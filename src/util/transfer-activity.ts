/** In-flight file copy/import/download jobs for the Finder transfer window. */

export type TransferKind = 'file' | 'folder';

export interface TransferJob {
  id: string;
  name: string;
  kind: TransferKind;
  bytesDone: number;
  bytesTotal: number;
  rate: number;
  status: 'running' | 'done' | 'error';
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
      if (j.status === 'running') return true;
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
    const id = `t${this.seq++}`;
    const now = performance.now();
    this.jobs.set(id, {
      id,
      name: spec.name,
      kind: spec.kind,
      bytesDone: 0,
      bytesTotal: spec.bytesTotal ?? 0,
      rate: 0,
      status: 'running',
      iconSrc: spec.iconSrc ?? (spec.kind === 'folder' ? '' : FILE_ICON),
      parentId: spec.parentId,
      detail: spec.detail,
      lastBytes: 0,
      lastTick: now,
    });
    this.order.push(id);
    this.emit();
    return id;
  }

  setIcon(id: string, iconSrc: string): void {
    const j = this.jobs.get(id);
    if (!j || j.kind === 'folder') return;
    j.iconSrc = iconSrc;
    this.emit();
  }

  setTotal(id: string, n: number): void {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running') return;
    j.bytesTotal = Math.max(n, j.bytesDone);
    this.emit();
  }

  addBytes(id: string, n: number): void {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'running' || n <= 0) return;
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
      if (j && j.status !== 'running') {
        this.jobs.delete(id);
        this.order = this.order.filter((x) => x !== id);
      }
    }
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const transferActivity = new TransferActivity();
export const TRANSFER_FILE_ICON = FILE_ICON;
