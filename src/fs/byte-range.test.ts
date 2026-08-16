import { describe, expect, it } from 'vitest';
import { bufferRangeReader, SparseBytes } from './byte-range';

describe('bufferRangeReader', () => {
  it('returns the requested slice and short reads at EOF', async () => {
    const read = bufferRangeReader(Uint8Array.of(1, 2, 3, 4, 5));
    expect([...(await read(1, 2))]).toEqual([2, 3]);
    expect([...(await read(4, 8))]).toEqual([5]);
    expect((await read(5, 1)).length).toBe(0);
    expect((await read(0, 0)).length).toBe(0);
  });
});

describe('SparseBytes', () => {
  it('faults missing ranges and serves later overlapping access from cache', async () => {
    const calls: { offset: number; count: number }[] = [];
    const inner = bufferRangeReader(Uint8Array.from({ length: 40 }, (_, i) => i));
    const sparse = new SparseBytes(async (offset, count) => {
      calls.push({ offset, count });
      return inner(offset, count);
    });
    expect([...(await sparse.slice(0, 4))]).toEqual([0, 1, 2, 3]);
    expect([...(await sparse.slice(20, 4))]).toEqual([20, 21, 22, 23]);
    expect(calls).toEqual([
      { offset: 0, count: 4 },
      { offset: 20, count: 4 },
    ]);
    expect([...(await sparse.slice(1, 2))]).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
    expect([...(await sparse.slice(2, 6))]).toEqual([2, 3, 4, 5, 6, 7]);
    expect(calls).toEqual([
      { offset: 0, count: 4 },
      { offset: 20, count: 4 },
      { offset: 4, count: 4 },
    ]);
    expect(sparse.has(0, 8)).toBe(true);
    expect(sparse.has(0, 9)).toBe(false);
  });

  it('merges adjacent runs', async () => {
    const inner = bufferRangeReader(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
    const sparse = new SparseBytes(inner);
    await sparse.slice(0, 4);
    await sparse.slice(4, 4);
    expect(sparse.has(0, 8)).toBe(true);
    expect([...(await sparse.slice(0, 8))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
