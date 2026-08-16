import { describe, expect, it } from 'vitest';
import { AsyncSemaphore } from './async-semaphore';

describe('AsyncSemaphore', () => {
  it('never runs more than max tasks at once', async () => {
    const sem = new AsyncSemaphore(3);
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 12 }, (_, i) =>
      sem.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running--;
        return i;
      }),
    );
    const out = await Promise.all(jobs);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it('releases a slot when a task throws', async () => {
    const sem = new AsyncSemaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('skips a queued task when its signal aborts', async () => {
    const sem = new AsyncSemaphore(1);
    let started = 0;
    const ac = new AbortController();
    let release!: () => void;
    const held = sem.run(
      () =>
        new Promise<void>((resolve) => {
          started++;
          release = resolve;
        }),
    );
    const queued = sem.run(async () => {
      started++;
    }, ac.signal);
    await Promise.resolve();
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await held;
    expect(started).toBe(1);
    await sem.run(async () => {
      started++;
    });
    expect(started).toBe(2);
  });

  it('reports busy when a task is running or queued', async () => {
    const sem = new AsyncSemaphore(1);
    expect(sem.busy).toBe(false);
    let release!: () => void;
    const held = sem.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    expect(sem.busy).toBe(true);
    const queued = sem.run(async () => undefined);
    expect(sem.busy).toBe(true);
    release();
    await Promise.all([held, queued]);
    expect(sem.busy).toBe(false);
  });

  it('runs a higher-priority waiter before earlier low-priority ones', async () => {
    const sem = new AsyncSemaphore(1);
    const order: string[] = [];
    let release!: () => void;
    const held = sem.run(
      () =>
        new Promise<void>((resolve) => {
          order.push('hold');
          release = resolve;
        }),
    );
    const low = sem.run(async () => {
      order.push('low');
    }, undefined, 0);
    const high = sem.run(async () => {
      order.push('high');
    }, undefined, 1);
    await Promise.resolve();
    release();
    await Promise.all([held, low, high]);
    expect(order).toEqual(['hold', 'high', 'low']);
  });
});
