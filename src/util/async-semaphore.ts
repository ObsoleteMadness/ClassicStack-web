import { abortError, throwIfAborted } from './abort';

type Waiter = { grant: () => void };

/** Limits how many async tasks run at once (FIFO waiters). */
export class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly max: number) {
    if (max < 1) throw new Error('AsyncSemaphore max must be >= 1');
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.inUse < this.max) {
      this.inUse++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
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
    const next = this.waiters.shift();
    if (next) next.grant();
  }
}
