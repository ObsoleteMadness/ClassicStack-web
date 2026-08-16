/** In-flight file copy/import/download jobs for the Finder transfer window. */

import { isAbortError } from './abort';

export type TransferKind = 'file' | 'folder';

export type TransferStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Catalog subset used to delete a dest file left behind by a cancelled write. */
export type TransferDest = {
  lookup(parentId: number, name: string): Promise<{ id: number; isDir: boolean } | undefined>;
  remove(id: number): Promise<void>;
};

export interface TransferJob {
  id: string;
  name: string;
  kind: TransferKind;
  bytesDone: number;
  bytesTotal: number;
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

type WriteLoc = { dest: TransferDest; parentId: number; name: string };

type JobRec = TransferJob & {
  lastBytes: number;
  lastTick: number;
  abort: AbortController;
  /** Top-level dest shown in Finder while this job is still writing. */
  dest?: WriteLoc;
  partial?: WriteLoc;
};

class TransferActivity {
  private jobs = new Map<string, JobRec>();
  private order: string[] = [];
  private listeners = new Set<Listener>();
  private seq = 1;

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

  /** Combined progress of running root jobs (nested expand tasks are skipped). */
  aggregateProgress(): { pct: number; running: boolean; indeterminate: boolean } {
    let done = 0;
    let total = 0;
    let running = false;
    for (const j of this.jobs.values()) {
      if (j.parentId && this.jobs.has(j.parentId)) continue;
      if (j.status !== 'running') continue;
      running = true;
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
    if (detail !== undefined) j.detail = detail;
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
    j.dest = undefined;
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
  setDest(id: string, dest: TransferDest, parentId: number, name: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    j.dest = { dest, parentId, name };
    this.emit();
  }

  /**
   * Remember the dest file currently being written so cancel can delete a
   * partial copy. Folder jobs should point this at the file in flight, not the folder.
   */
  watchPartial(id: string, dest: TransferDest, parentId: number, name: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    j.partial = { dest, parentId, name };
  }

  /** Running/queued writes targeting `parentId` in `dest` (top-level dest or in-flight file). */
  writesIn(dest: TransferDest, parentId: number): TransferWriteProgress[] {
    const out: TransferWriteProgress[] = [];
    const seen = new Set<string>();
    for (const j of this.jobs.values()) {
      if (j.status !== 'running' && j.status !== 'queued') continue;
      const hits: { name: string; kind: TransferKind }[] = [];
      if (j.dest && j.dest.dest === dest && j.dest.parentId === parentId) {
        hits.push({ name: j.dest.name, kind: j.kind });
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
      if (node && !node.isDir) await partial.dest.remove(node.id);
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
    j.dest = undefined;
    j.status = 'done';
    if (j.bytesTotal <= 0) j.bytesTotal = j.bytesDone;
    j.rate = 0;
    this.emit();
  }

  fail(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return;
    this.clearPartial(id);
    j.dest = undefined;
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

function jobProgress(j: TransferJob): { pct: number; indeterminate: boolean } {
  if (j.status === 'queued') return { pct: 0, indeterminate: false };
  if (j.bytesTotal <= 0) return { pct: 0, indeterminate: j.status === 'running' };
  return { pct: Math.min(100, Math.round((j.bytesDone / j.bytesTotal) * 100)), indeterminate: false };
}

export const transferActivity = new TransferActivity();
export const TRANSFER_FILE_ICON = FILE_ICON;
