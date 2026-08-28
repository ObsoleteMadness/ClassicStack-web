import { describe, it, expect, vi } from 'vitest';
import { CtsChunk, CtsMaxWaitMs, chunkBytes, waitClearToSend } from './cts';

describe('chunkBytes', () => {
  it('splits on CtsChunk and keeps an empty buffer as one chunk', () => {
    const data = new Uint8Array(CtsChunk * 2 + 3);
    const parts = chunkBytes(data);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.length).toBe(CtsChunk);
    expect(parts[2]!.length).toBe(3);
    expect(chunkBytes(new Uint8Array())).toEqual([new Uint8Array()]);
  });
});

describe('waitClearToSend', () => {
  it('returns immediately when CTS is asserted', async () => {
    const sleep = vi.fn(async () => undefined);
    await waitClearToSend(async () => true, () => 0, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns immediately when CTS cannot be read', async () => {
    const sleep = vi.fn(async () => undefined);
    await waitClearToSend(async () => null, () => 0, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until CTS asserts', async () => {
    let n = 0;
    const sleep = vi.fn(async () => undefined);
    await waitClearToSend(
      async () => {
        n++;
        return n >= 3;
      },
      () => 0,
      sleep,
    );
    expect(n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after CtsMaxWaitMs so an unwired line does not stall', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    await waitClearToSend(
      async () => false,
      () => now,
      sleep,
    );
    expect(now).toBeGreaterThanOrEqual(CtsMaxWaitMs);
  });
});
