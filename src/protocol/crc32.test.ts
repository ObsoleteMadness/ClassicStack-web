import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';

describe('crc32', () => {
  it('matches the ISO-HDLC check vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});
