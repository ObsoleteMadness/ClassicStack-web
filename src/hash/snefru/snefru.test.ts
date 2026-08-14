import { describe, expect, it } from 'vitest';
import { appendTrailer, hasValidTrailer, sum, SnefruError } from './snefru';

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function counting(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xff;
  return out;
}

function pattern(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7 + 3) & 0xff;
  return out;
}

describe('snefru', () => {
  it('matches snefru_hash.py vectors', () => {
    expect(hex(sum(new Uint8Array(64)))).toBe('825ac7022417010cc9cbd09c05c37141');
    expect(hex(sum(new Uint8Array(64).fill(0x41)))).toBe('26c6e957cbc3da084b83d75b5c219a20');
    expect(hex(sum(counting(256)))).toBe('662bb71c2157c4128686f4a5455126ee');
    expect(hex(sum(pattern(1024)))).toBe('fb4fc5343711418eb2d2823e76bc2107');
  });

  it('rejects unaligned input', () => {
    expect(() => sum(new Uint8Array(63))).toThrow(SnefruError);
  });

  it('AppendTrailer matches reference payload', () => {
    const out = appendTrailer(new TextEncoder().encode('hello world payload'), 64);
    expect(out.length).toBe(128);
    expect(hex(out.subarray(112))).toBe('a5e4dd459d1faeb9ec562f748396b599');
    expect(hasValidTrailer(out)).toBe(true);
  });

  it('AppendTrailer aligns to block size', () => {
    for (const align of [64, 256, 512]) {
      for (const plen of [0, 1, 19, align - 64, align, align * 3 + 5]) {
        const out = appendTrailer(new Uint8Array(plen), align);
        expect(out.length % align).toBe(0);
        expect(out.length).toBeGreaterThanOrEqual(2 * align);
        expect(hasValidTrailer(out)).toBe(true);
      }
    }
  });

  it('HasValidTrailer rejects corruption', () => {
    const out = appendTrailer(new TextEncoder().encode('payload'), 64);
    out[0]! ^= 0xff;
    expect(hasValidTrailer(out)).toBe(false);
    expect(hasValidTrailer(new Uint8Array(64))).toBe(false);
  });
});
