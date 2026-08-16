/** Limits how many async tasks run at once (FIFO waiters). */
export class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max: number) {
    if (max < 1) throw new Error('AsyncSemaphore max must be >= 1');
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inUse < this.max) {
      this.inUse++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inUse++;
        resolve();
      });
    });
  }

  private release(): void {
    this.inUse--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
