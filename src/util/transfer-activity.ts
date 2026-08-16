/** In-flight file copy/import/download jobs for the Finder transfer window. */

export type TransferKind = 'file' | 'folder';

export type TransferStatus = 'queued' | 'running' | 'done' | 'error';

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

class TransferActivity {
  private jobs = new Map<string, TransferJob & { lastBytes: number; lastTick: number }>();
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
  begin(id: string, detail?: string): void {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'queued') return;
    j.status = 'running';
    j.lastTick = performance.now();
    if (detail !== undefined) j.detail = detail;
    this.emit();
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
    if (!j) return;
    j.status = 'done';
    if (j.bytesTotal <= 0) j.bytesTotal = j.bytesDone;
    j.rate = 0;
    this.emit();
  }

  fail(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
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
    });
    this.order.push(id);
    return id;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const transferActivity = new TransferActivity();
export const TRANSFER_FILE_ICON = FILE_ICON;
