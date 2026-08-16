import { abortError, throwIfAborted } from './abort';

type Waiter = { grant: () => void; priority: number };

/** Limits how many async tasks run at once. Higher `priority` waiters run first. */
export class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly max: number) {
    if (max < 1) throw new Error('AsyncSemaphore max must be >= 1');
  }

  /** True when a task is running or waiting for a slot. */
  get busy(): boolean {
    return this.inUse > 0 || this.waiters.length > 0;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, priority = 0): Promise<T> {
    await this.acquire(signal, priority);
    try {
      throwIfAborted(signal);
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal, priority = 0): Promise<void> {
    throwIfAborted(signal);
    if (this.inUse < this.max) {
      this.inUse++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.inUse++;
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i < 0) return;
        this.waiters.splice(i, 1);
        reject(abortError(signal));
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort);
    });
  }

  private release(): void {
    this.inUse--;
    const next = this.takeNext();
    if (next) next.grant();
  }

  private takeNext(): Waiter | undefined {
    let best = -1;
    let bestPri = -Infinity;
    for (let i = 0; i < this.waiters.length; i++) {
      const p = this.waiters[i]!.priority;
      if (p > bestPri) {
        bestPri = p;
        best = i;
      }
    }
    if (best < 0) return undefined;
    return this.waiters.splice(best, 1)[0];
  }
}
