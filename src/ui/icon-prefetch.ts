/** Max AFP / fork icon lookups in flight for on-screen Finder items. */
export const MAX_VISIBLE_ICON_REQUESTS = 4;

export function rectsOverlap(a: { top: number; right: number; bottom: number; left: number }, b: typeof a): boolean {
  return a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
}

/**
 * Starts at most `max` icon loads at once, and only for items that are still
 * visible when a slot opens. Hidden waiting items are dropped, not started.
 */
export class VisibleIconQueue<T extends { key: string }> {
  private waiting: T[] = [];
  private waitingKeys = new Set<string>();
  private inflight = new Set<string>();
  private active = 0;

  constructor(
    private readonly load: (item: T) => Promise<void>,
    private readonly isVisible: (item: T) => boolean,
    private readonly max = MAX_VISIBLE_ICON_REQUESTS,
  ) {}

  get inflightCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  reset(): void {
    this.waiting = [];
    this.waitingKeys.clear();
  }

  has(key: string): boolean {
    return this.waitingKeys.has(key) || this.inflight.has(key);
  }

  enqueue(item: T): void {
    if (this.waitingKeys.has(item.key) || this.inflight.has(item.key)) return;
    this.waiting.push(item);
    this.waitingKeys.add(item.key);
    this.pump();
  }

  /** Drop a queued (not yet started) item that left the viewport. */
  hide(key: string): void {
    if (!this.waitingKeys.has(key)) return;
    this.waiting = this.waiting.filter((it) => it.key !== key);
    this.waitingKeys.delete(key);
  }

  pump(): void {
    while (this.active < this.max) {
      const next = this.takeVisible();
      if (!next) break;
      this.active++;
      this.inflight.add(next.key);
      void this.load(next).finally(() => {
        this.active--;
        this.inflight.delete(next.key);
        this.pump();
      });
    }
  }

  private takeVisible(): T | undefined {
    while (this.waiting.length) {
      const item = this.waiting.shift()!;
      this.waitingKeys.delete(item.key);
      if (this.isVisible(item)) return item;
    }
    return undefined;
  }
}
