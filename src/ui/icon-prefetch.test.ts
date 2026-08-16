import { describe, expect, it } from 'vitest';
import { MAX_VISIBLE_ICON_REQUESTS, rectsOverlap, VisibleIconQueue } from './icon-prefetch';

function wait(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('rectsOverlap', () => {
  it('is true when rectangles share area', () => {
    expect(rectsOverlap({ top: 0, left: 0, bottom: 32, right: 32 }, { top: 16, left: 16, bottom: 48, right: 48 })).toBe(
      true,
    );
  });

  it('is false when rectangles only touch or miss', () => {
    expect(rectsOverlap({ top: 0, left: 0, bottom: 32, right: 32 }, { top: 32, left: 0, bottom: 64, right: 32 })).toBe(
      false,
    );
    expect(rectsOverlap({ top: 0, left: 0, bottom: 32, right: 32 }, { top: 40, left: 0, bottom: 72, right: 32 })).toBe(
      false,
    );
  });
});

describe('VisibleIconQueue', () => {
  it('runs at most four loads at a time', async () => {
    let current = 0;
    let peak = 0;
    const visible = new Set(Array.from({ length: 10 }, (_, i) => String(i)));
    const started: string[] = [];
    const queue = new VisibleIconQueue(
      async (item) => {
        started.push(item.key);
        current++;
        peak = Math.max(peak, current);
        await wait(20);
        current--;
      },
      (item) => visible.has(item.key),
    );
    for (let i = 0; i < 10; i++) queue.enqueue({ key: String(i) });
    expect(queue.inflightCount).toBe(MAX_VISIBLE_ICON_REQUESTS);
    expect(started).toEqual(['0', '1', '2', '3']);
    await wait(80);
    expect(peak).toBe(MAX_VISIBLE_ICON_REQUESTS);
    expect(started).toHaveLength(10);
  });

  it('does not start loads for items that are not visible', async () => {
    const started: string[] = [];
    const visible = new Set(['a', 'c']);
    const queue = new VisibleIconQueue(
      async (item) => {
        started.push(item.key);
      },
      (item) => visible.has(item.key),
    );
    queue.enqueue({ key: 'a' });
    queue.enqueue({ key: 'b' });
    queue.enqueue({ key: 'c' });
    await wait(0);
    expect(started).toEqual(['a', 'c']);
  });

  it('drops waiting items that leave the viewport before a slot opens', async () => {
    const started: string[] = [];
    const visible = new Set(['1', '2', '3', '4', '5']);
    const queue = new VisibleIconQueue(
      async (item) => {
        started.push(item.key);
        await wait(15);
      },
      (item) => visible.has(item.key),
    );
    for (const key of ['1', '2', '3', '4', '5']) queue.enqueue({ key });
    queue.hide('5');
    await wait(40);
    expect(started).toEqual(['1', '2', '3', '4']);
  });

  it('starts the next visible waiter when a slot frees', async () => {
    const started: string[] = [];
    const queue = new VisibleIconQueue(
      async (item) => {
        started.push(item.key);
        await wait(10);
      },
      () => true,
    );
    for (const key of ['a', 'b', 'c', 'd', 'e']) queue.enqueue({ key });
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    await wait(25);
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
