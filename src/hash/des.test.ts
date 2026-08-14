import { describe, it, expect } from 'vitest';
import { desEncryptBlock } from './des';

describe('DES ECB', () => {
  it('matches the NIST single-block test vector', () => {
    const key = Uint8Array.from([0x13, 0x34, 0x57, 0x79, 0x9b, 0xbc, 0xdf, 0xf1]);
    const plain = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
    const cipher = desEncryptBlock(plain, key);
    expect([...cipher]).toEqual([0x85, 0xe8, 0x13, 0x54, 0x0f, 0x0a, 0xb4, 0x05]);
  });
});
