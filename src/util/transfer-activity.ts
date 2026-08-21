/** In-flight file copy/import/download jobs for the Finder transfer window. */

import { isAbortError, throwIfAborted } from './abort';
import { AsyncSemaphore } from './async-semaphore';

import type { NodeRef } from '../fs/catalog-caps';

export type TransferKind = 'file' | 'folder';

export type TransferStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Rate-column caption while a folder job is enumerating items before the copy/download. */
export const TRANSFER_DETAIL_SEARCHING = 'Searching';

/** Catalog subset used to delete a dest file left behind by a cancelled write. */
export type TransferDest = {
  lookup(parent: NodeRef, name: string): Promise<{ addr?: string; id?: number; path?: string; isDir: boolean } | undefined>;
  remove(ref: NodeRef): Promise<void>;
};

export interface TransferJob {
  id: string;
  name: string;
  kind: TransferKind;
  bytesDone: number;
  bytesTotal: number;
  /** Items found during Searching, or processed afterwards. */
  itemsDone: number;
  rate: number;
  status: TransferStatus;
  error?: string;
  iconSrc: string;
  /** When set, this row is a nested subtask of another job (e.g. auto-expand). */
  parentId?: string;
  /** Shown in the rate column while running with no byte rate yet (e.g. Expanding). */
  detail?: string;
}

/** In-progress dest item to overlay in a Finder folder listing. */
export interface TransferWriteProgress {
  jobId: string;
  name: string;
  kind: TransferKind;
  pct: number;
  indeterminate: boolean;
}

export interface TransferStart {
  name: string;
  kind: TransferKind;
  bytesTotal?: number;
  iconSrc?: string;
  parentId?: string;
  detail?: string;
  queued?: boolean;
}

type Listener = () => void;

const FILE_ICON = '/icons/FILE16.png';

type WriteLoc = { dest: TransferDest; parentId: NodeRef; name: string; kind?: TransferKind };

type JobRec = TransferJob & {
  lastBytes: number;
  lastTick: number;
  abort: AbortController;
  /** Dest items shown in Finder while this job is still writing. */
  dests?: WriteLoc[];
  partial?: WriteLoc;
};

class TransferActivity {
  private jobs = new Map<string, JobRec>();
  private order: string[] = [];
  private listeners = new Set<Listener>();
  private seq = 1;
  /** One Finder copy/import at a time so AFP Writes do not interleave. */
  private readonly copySlot = new AsyncSemaphore(1);
  private copyOwner: string | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): TransferJob[] {
    return this.order.map((id) => this.jobs.get(id)!).filter(Boolean);
  }

  hasRunning(): boolean {
    for (const j of this.jobs.values()) {
      if (j.status === 'running' || j.status === 'queued') return true;
    }
    return false;
  }

  /** True when a running/queued job is writing into `dest`. */
  busyOn(dest: TransferDest): boolean {
    for (const j of this.jobs.values()) {
      if (j.status !== 'running' && j.status !== 'queued') continue;
      if (j.partial?.dest === dest) return true;
      if (j.dests?.some((d) => d.dest === dest)) return true;
    }
    return false;
  }

  /**
   * Run `fn` when no other copy holds the slot. Re-enters for the same job
   * (archive expand inside an import). Begins a queued job as it starts.
   */
  async withCopySlot<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.copyOwner === id) return fn();
    const signal = this.signal(id);
    return this.copySlot.run(async () => {
      throwIfAborted(signal);
      this.copyOwner = id;
      try {
        this.begin(id);
        return await fn();
      } finally {
        if (this.copyOwner === id) this.copyOwner = null;
      }
    }, signal);
  }

  /** Combined progress of running root jobs (nested expand tasks are skipped). */
  aggregateProgress(): { pct: number; running: boolean; indeterminate: boolean } {
    let done = 0;
    let total = 0;
    let running = false;
    for (const j of this.jobs.values()) {
      if (j.parentId && this.jobs.has(j.parentId)) continue;
      if (j.status !== 'running') continue;
      running = true;
      if (isSearchingJob(j)) continue;
      done += j.bytesDone;
      total += j.bytesTotal;
    }
    if (!running) return { pct: 0, running: false, indeterminate: false };
    if (total <= 0) return { pct: 0, running: true, indeterminate: true };
    return { pct: Math.min(100, Math.round((done / total) * 100)), running: true, indeterminate: false };
  }

  start(spec: TransferStart): string {
    const id = this.insert(spec);
    this.emit();
    return id;
  }

  /** Queue several nested jobs and notify listeners once. */
  startMany(specs: TransferStart[]): string[] {
    const ids = specs.map((spec) => this.insert(spec));
    if (ids.length) this.emit();
    return ids;
  }

  /** Move a queued job to running (e.g. the next extracted file). */
  begin(id: string, detail?: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'queued') return false;
    j.status = 'running';
    j.lastTick = performance.now();
    j.detail = detail;
    this.emit();
    return true;
  }

  signal(id: string): AbortSignal | undefined {
    return this.jobs.get(id)?.abort.signal;
  }

  isCancelled(id: string): boolean {
    const j = this.jobs.get(id);
    return !!j && (j.status === 'cancelled' || j.abort.signal.aborted);
  }

  /** Abort a running job or skip a queued one. Nested extract tasks are cancelled too. */
  cancel(id: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    j.status = 'cancelled';
    j.rate = 0;
    j.detail = undefined;
    j.dests = undefined;
    if (!j.abort.signal.aborted) j.abort.abort();
    for (const child of this.jobs.values()) {
      if (child.parentId === id) this.cancel(child.id);
    }
    this.emit();
  }

  /**
   * Dest folder + name for Finder overlay (the copy target, including folders).
   * Call as soon as the dest name is known so the item can appear before the write.
   */
  setDest(id: string, dest: TransferDest, parentId: NodeRef, name: string, kind?: TransferKind): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    j.dests = [{ dest, parentId, name, kind }];
    this.emit();
  }

  /** Extra dest overlay (e.g. several top-level items from one archive). */
  addDest(id: string, dest: TransferDest, parentId: NodeRef, name: string, kind?: TransferKind): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    const dests = j.dests ?? (j.dests = []);
    const key = `${parentId}\0${name.toLowerCase()}`;
    if (dests.some((d) => d.dest === dest && `${d.parentId}\0${d.name.toLowerCase()}` === key)) return;
    dests.push({ dest, parentId, name, kind });
    this.emit();
  }

  clearDest(id: string): void {
    const j = this.jobs.get(id);
    if (!j || !j.dests?.length) return;
    j.dests = undefined;
    this.emit();
  }

  /**
   * Remember the dest file currently being written so cancel can delete a
   * partial copy. Folder jobs should point this at the file in flight, not the folder.
   */
  watchPartial(id: string, dest: TransferDest, parentId: NodeRef, name: string): void {
    this.setWriteFile(id, dest, parentId, name);
  }

  /**
   * Overlay the dest file currently being written. Folder dest overlays on the
   * same job are kept so a parent listing still shows progress after enumerate.
   */
  setWriteFile(id: string, dest: TransferDest, parentId: NodeRef, name: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    const folders = (j.dests ?? []).filter((d) => (d.kind ?? j.kind) === 'folder');
    const fileLoc: WriteLoc = { dest, parentId, name, kind: 'file' };
    j.dests = [...folders, fileLoc];
    j.partial = { dest, parentId, name };
    this.emit();
  }

  /** Running/queued writes targeting `parentId` in `dest` (top-level dest or in-flight file). */
  writesIn(dest: TransferDest, parentId: NodeRef): TransferWriteProgress[] {
    const out: TransferWriteProgress[] = [];
    const seen = new Set<string>();
    for (const j of this.jobs.values()) {
      if (j.status !== 'running' && j.status !== 'queued') continue;
      const hits: { name: string; kind: TransferKind }[] = [];
      for (const loc of j.dests ?? []) {
        if (loc.dest === dest && loc.parentId === parentId) {
          hits.push({ name: loc.name, kind: loc.kind ?? j.kind });
        }
      }
      if (j.partial && j.partial.dest === dest && j.partial.parentId === parentId) {
        hits.push({ name: j.partial.name, kind: 'file' });
      }
      if (!hits.length) continue;
      const prog = jobProgress(j);
      for (const hit of hits) {
        const key = hit.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          jobId: j.id,
          name: hit.name,
          kind: hit.kind,
          pct: prog.pct,
          indeterminate: prog.indeterminate,
        });
      }
    }
    return out;
  }

  clearPartial(id: string): void {
    const j = this.jobs.get(id);
    if (j) j.partial = undefined;
  }

  /** Delete the watched dest file if it is a file (not a folder). */
  async discardPartial(id: string): Promise<void> {
    const j = this.jobs.get(id);
    const partial = j?.partial;
    if (!j || !partial) return;
    j.partial = undefined;
    try {
      const node = await partial.dest.lookup(partial.parentId, partial.name);
      if (node && !node.isDir) {
        const ref: NodeRef = node.path != null && node.addr === 'path' ? node.path : (node.id as number);
        await partial.dest.remove(ref);
      }
    } catch {
      /* dest may already be gone */
    }
  }

  /** Finish, fail, or drop a partial after the writer stops. */
  async settle(id: string, err?: unknown): Promise<void> {
    if (!err) {
      this.clearPartial(id);
      this.finish(id);
      return;
    }
    if (isAbortError(err) || this.isCancelled(id)) {
      await this.discardPartial(id);
      if (!this.isCancelled(id)) this.cancel(id);
      return;
    }
    this.clearPartial(id);
    this.fail(id, err instanceof Error ? err.message : String(err));
  }

  /** Fail queued children when the parent extract aborts. */
  failQueued(parentId: string, error: string): void {
    let any = false;
    for (const j of this.jobs.values()) {
      if (j.parentId !== parentId || j.status !== 'queued') continue;
      j.status = 'error';
      j.error = error;
      j.rate = 0;
      j.dests = undefined;
      j.partial = undefined;
      any = true;
    }
    if (any) this.emit();
  }

  setIcon(id: string, iconSrc: string): void {
    const j = this.jobs.get(id);
    if (!j || j.kind === 'folder') return;
    j.iconSrc = iconSrc;
    this.emit();
  }

  setTotal(id: string, n: number): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    j.bytesTotal = Math.max(n, j.bytesDone);
    this.emit();
  }

  /**
   * Searching-phase totals: item count and listed size so far. The progress
   * bar stays indeterminate until setBytes starts the download.
   */
  setFound(id: string, items: number, bytes: number): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    if (j.status === 'queued') j.status = 'running';
    j.itemsDone = Math.max(0, items);
    j.bytesTotal = Math.max(0, bytes);
    j.detail = TRANSFER_DETAIL_SEARCHING;
    this.emit();
  }

  setDetail(id: string, detail: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    if (j.detail === detail) return;
    j.detail = detail;
    this.emit();
  }

  /** Replace progress (e.g. switch from reading an archive to writing extracted files). */
  setBytes(id: string, done: number, total: number, detail?: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    if (j.status === 'queued') j.status = 'running';
    j.bytesDone = Math.max(0, done);
    j.bytesTotal = Math.max(total, j.bytesDone);
    j.rate = 0;
    j.lastBytes = j.bytesDone;
    j.lastTick = performance.now();
    if (detail !== undefined) j.detail = detail;
    this.emit();
  }

  addBytes(id: string, n: number): void {
    const j = this.jobs.get(id);
    if (!j || n <= 0) return;
    if (j.status === 'queued') j.status = 'running';
    if (j.status !== 'running') return;
    j.bytesDone += n;
    if (j.bytesTotal > 0 && j.bytesDone > j.bytesTotal) j.bytesTotal = j.bytesDone;
    const now = performance.now();
    const dt = (now - j.lastTick) / 1000;
    if (dt >= 0.12) {
      const inst = (j.bytesDone - j.lastBytes) / dt;
      j.rate = j.rate > 0 ? j.rate * 0.65 + inst * 0.35 : inst;
      j.lastBytes = j.bytesDone;
      j.lastTick = now;
    }
    this.emit();
  }

  finish(id: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    this.clearPartial(id);
    j.dests = undefined;
    j.status = 'done';
    if (j.bytesTotal <= 0) j.bytesTotal = j.bytesDone;
    j.rate = 0;
    this.emit();
  }

  fail(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    this.clearPartial(id);
    j.dests = undefined;
    j.status = 'error';
    j.error = error;
    j.rate = 0;
    this.emit();
  }

  clearFinished(): void {
    for (const id of [...this.order]) {
      const j = this.jobs.get(id);
      if (j && j.status !== 'running' && j.status !== 'queued') {
        this.jobs.delete(id);
        this.order = this.order.filter((x) => x !== id);
      }
    }
    this.emit();
  }

  private insert(spec: TransferStart): string {
    const id = `t${this.seq++}`;
    const now = performance.now();
    this.jobs.set(id, {
      id,
      name: spec.name,
      kind: spec.kind,
      bytesDone: 0,
      bytesTotal: spec.bytesTotal ?? 0,
      itemsDone: 0,
      rate: 0,
      status: spec.queued ? 'queued' : 'running',
      iconSrc: spec.iconSrc ?? (spec.kind === 'folder' ? '' : FILE_ICON),
      parentId: spec.parentId,
      detail: spec.detail ?? (spec.queued ? 'Queued' : undefined),
      lastBytes: 0,
      lastTick: now,
      abort: new AbortController(),
    });
    this.order.push(id);
    return id;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function isSearchingJob(j: TransferJob): boolean {
  return j.status === 'running' && j.detail === TRANSFER_DETAIL_SEARCHING;
}

/** True while a running job is enumerating items (zip download, folder copy prepare). */
export function isTransferSearching(j: TransferJob): boolean {
  return isSearchingJob(j);
}

function jobProgress(j: TransferJob): { pct: number; indeterminate: boolean } {
  if (j.status === 'queued') return { pct: 0, indeterminate: false };
  if (isSearchingJob(j) || j.bytesTotal <= 0) return { pct: 0, indeterminate: j.status === 'running' };
  return { pct: Math.min(100, Math.round((j.bytesDone / j.bytesTotal) * 100)), indeterminate: false };
}

export const transferActivity = new TransferActivity();
export const TRANSFER_FILE_ICON = FILE_ICON;
