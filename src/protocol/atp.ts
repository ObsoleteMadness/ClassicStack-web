/** ATP wire codec (OmniTalk core/protocol/atp). */

import { be16, be32, writeBe16, writeBe32 } from './binary';

export const TREQ = 0x40;
export const TRESP = 0x80;
export const TREL = 0xc0;
export const XO = 0x20;
export const EOM = 0x10;
export const STS = 0x08;
export const FuncMask = 0xc0;

export const MaxResponsePackets = 8;
export const MaxATPData = 578;
export const DDPType = 3;
export const HeaderSize = 8;

/** 3-bit TRel timeout in the low bits of an XO TReq control byte (OmniTalk TRel30s). */
export const TRel30s = 0;

export function setTRelTimeout(control: number, timeout: number = TRel30s): number {
  return (control & ~0x07) | (timeout & 0x07);
}

/** Highest response slot implied by a TReq bitmap (bitmap 0x01 → 1, 0xff → 8). */
export function maxRespFromBitmap(bitmap: number): number {
  let n = 0;
  for (let i = 0; i < MaxResponsePackets; i++) {
    if (bitmap & (1 << i)) n = i + 1;
  }
  return Math.max(1, n);
}

/**
 * OmniTalk `haveAll`: complete when the EOM packet and everything before it has
 * arrived, or when every packet the request asked for has arrived (System 7 often
 * omits EOM on a one-packet OpenSess/Command TResp).
 */
export function responseComplete(
  maxResp: number,
  got: { has(seq: number): boolean },
  eomSeq: number | null,
): boolean {
  if (eomSeq != null && eomSeq >= 0) {
    for (let i = 0; i <= eomSeq; i++) {
      if (!got.has(i)) return false;
    }
    return true;
  }
  for (let i = 0; i < maxResp; i++) {
    if (!got.has(i)) return false;
  }
  return true;
}

/**
 * Highest contiguous slot from 0. Used when the responder omits EOM on a
 * short reply (System 7 OpenSess / many AFP Command TResps).
 */
export function inferredEomSeq(maxResp: number, got: { has(seq: number): boolean }): number | null {
  if (!got.has(0)) return null;
  let last = 0;
  while (last + 1 < maxResp && got.has(last + 1)) last++;
  return last;
}

/** Bitmap of still-missing response slots (OmniTalk missingMask). */
export function missingBitmap(
  maxResp: number,
  got: { has(seq: number): boolean },
  eomSeq: number | null,
): number {
  const fullMask = (1 << maxResp) - 1;
  if (eomSeq != null && eomSeq >= 0) {
    let m = 0;
    for (let i = 0; i <= eomSeq; i++) {
      if (!got.has(i)) m |= 1 << i;
    }
    return m;
  }
  let m = 0;
  for (let i = 0; i < maxResp; i++) {
    if (!got.has(i)) m |= 1 << i;
  }
  return m || fullMask;
}

export interface Header {
  control: number;
  bitmap: number;
  transId: number;
  userData: number;
}

export function encodeHeader(h: Header): Uint8Array {
  const out = new Uint8Array(HeaderSize);
  out[0] = h.control;
  out[1] = h.bitmap;
  writeBe16(out, 2, h.transId);
  writeBe32(out, 4, h.userData);
  return out;
}

export function decodeHeader(b: Uint8Array): Header {
  if (b.length < HeaderSize) throw new Error('atp: short');
  return {
    control: b[0]!,
    bitmap: b[1]!,
    transId: be16(b, 2),
    userData: be32(b, 4),
  };
}

export function encodePacket(h: Header, data: Uint8Array = new Uint8Array()): Uint8Array {
  const hdr = encodeHeader(h);
  const out = new Uint8Array(hdr.length + data.length);
  out.set(hdr);
  out.set(data, hdr.length);
  return out;
}

export function decodePacket(b: Uint8Array): { header: Header; data: Uint8Array } {
  return { header: decodeHeader(b), data: b.subarray(HeaderSize) };
}

export function funcCode(h: Header): number {
  return h.control & FuncMask;
}

export function hasXO(h: Header): boolean {
  return (h.control & XO) !== 0;
}

export function hasEOM(h: Header): boolean {
  return (h.control & EOM) !== 0;
}

export function hasSTS(h: Header): boolean {
  return (h.control & STS) !== 0;
}
