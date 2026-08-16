/**
 * Apple-variant Snefru-128 for classic Mac netboot payload authentication.
 * Port of ClassicStack core/hash/snefru (Elliot Nunn snefru_hash.py / Apple Hash.c).
 */

import { be32, writeBe32 } from '../../protocol/binary';
import { sbox0, sbox1 } from './sboxes';

export const Size = 16;
export const BlockSize = 64;
export const TrailerSize = 64;

export class SnefruError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnefruError';
  }
}

function rotl32(v: number, shift: number): number {
  return ((v << shift) | (v >>> (32 - shift))) >>> 0;
}

function hash512(input: Uint32Array, p0: number, p1: number, p2: number): Uint32Array {
  const edit = new Uint32Array(16);
  edit.set(input);
  edit[0] = (edit[0]! ^ p0) >>> 0;
  edit[1] = (edit[1]! ^ p1) >>> 0;
  edit[2] = (edit[2]! ^ p2) >>> 0;

  for (const shift of [0, 16, 24, 8]) {
    for (let idx = 0; idx < 16; idx++) {
      const b = (edit[idx]! >>> shift) & 0xff;
      let v = idx % 4 < 2 ? sbox0[b]! : sbox1[b]!;
      v = rotl32(v, shift);
      edit[(idx + 1) % 16] = (edit[(idx + 1) % 16]! ^ v) >>> 0;
      edit[(idx + 15) % 16] = (edit[(idx + 15) % 16]! ^ v) >>> 0;
    }
  }

  edit[14] = (edit[14]! ^ p0) >>> 0;
  edit[13] = (edit[13]! ^ p1) >>> 0;
  edit[12] = (edit[12]! ^ p2) >>> 0;

  return new Uint32Array([
    (input[0]! ^ edit[15]!) >>> 0,
    (input[1]! ^ edit[14]!) >>> 0,
    (input[2]! ^ edit[13]!) >>> 0,
    (input[3]! ^ edit[12]!) >>> 0,
  ]);
}

/** Netboot Snefru-128 digest; input length must be a multiple of 64. */
export function sum(input: Uint8Array): Uint8Array {
  if (input.length % BlockSize !== 0) {
    throw new SnefruError('snefru: input length must be a multiple of 64 bytes');
  }

  let p0 = 0;
  let p1 = 0;
  let p2 = (input.length * 8) >>> 0;

  const temp = new Uint32Array(16);
  let loc = 0;
  for (let off = 0; off < input.length; off += BlockSize) {
    const grist = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      grist[i] = be32(input, off + 4 * i);
    }
    const h = hash512(grist, p0, p1, p2);
    temp.set(h, loc);
    p2 = (p2 + 1) >>> 0;
    loc += 4;

    if (loc >= 16) {
      const folded = hash512(temp, p0, p1, p2);
      temp.set(folded, 0);
      loc = 4;
      p2 = (p2 + 1) >>> 0;
    }
  }

  const final = hash512(temp, p0, p1, p2);
  const out = new Uint8Array(Size);
  for (let i = 0; i < 4; i++) writeBe32(out, i * 4, final[i]!);
  return out;
}

/**
 * Pad so length % align === align - 64 and total ≥ 2*align, then append
 * 48 zero bytes + 16-byte hash of the body.
 */
export function appendTrailer(payload: Uint8Array, align: number): Uint8Array {
  if (align <= 0 || align % BlockSize !== 0) {
    throw new SnefruError('snefru: input length must be a multiple of 64 bytes');
  }
  let out = new Uint8Array(payload);
  while (out.length % align !== align - TrailerSize || out.length + TrailerSize < 2 * align) {
    const next = new Uint8Array(out.length + 1);
    next.set(out);
    out = next;
  }
  const digest = sum(out);
  const result = new Uint8Array(out.length + TrailerSize);
  result.set(out);
  result.set(digest, out.length + (TrailerSize - Size));
  return result;
}

export function hasValidTrailer(payload: Uint8Array): boolean {
  if (payload.length < TrailerSize + BlockSize || (payload.length - TrailerSize) % BlockSize !== 0) {
    return false;
  }
  const body = payload.subarray(0, payload.length - TrailerSize);
  let digest: Uint8Array;
  try {
    digest = sum(body);
  } catch {
    return false;
  }
  const tail = payload.subarray(payload.length - Size);
  for (let i = 0; i < Size; i++) if (digest[i] !== tail[i]) return false;
  return true;
}
