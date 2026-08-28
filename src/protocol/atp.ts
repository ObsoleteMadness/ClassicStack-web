/** ATP wire codec (ClassicStack core/protocol/atp). */

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

/** TReq bitmap for a payload of `bytes` (one bit per 578-byte ATP slot, max 8). */
export function bitmapForPayload(bytes: number): number {
  const n = Math.min(Math.max(Math.ceil(Math.max(bytes, 1) / MaxATPData), 1), MaxResponsePackets);
  return (1 << n) - 1;
}

/**
 * Split payload into ATP slots (at least one, possibly empty). Caps at
 * MaxResponsePackets — ClassicStack `atpRequest.respond`.
 */
export function splitPayload(data: Uint8Array): Uint8Array[] {
  let n = Math.ceil(data.length / MaxATPData);
  if (n < 1) n = 1;
  if (n > MaxResponsePackets) n = MaxResponsePackets;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * MaxATPData;
    chunks.push(data.subarray(start, Math.min(start + MaxATPData, data.length)));
  }
  return chunks;
}

/**
 * TReq bitmap bits as slot numbers (0..7). A zero bitmap is packet 0 only so a
 * malformed request still gets a reply (ClassicStack `atpRequest.respond`).
 */
export function slotsFromBitmap(bitmap: number): number[] {
  const mask = bitmap & ((1 << MaxResponsePackets) - 1);
  if (mask === 0) return [0];
  const slots: number[] = [];
  for (let i = 0; i < MaxResponsePackets; i++) {
    if (mask & (1 << i)) slots.push(i);
  }
  return slots;
}

/**
 * Encode TResp packets for `data`, sending only slots the TReq bitmap asked for.
 * EOM is set on the last slot of the *message*, not the last packet of this
 * retransmission (a bitmap-0x01 retry of an 8-slot write must not set EOM).
 */
export function encodeTRespPackets(
  transId: number,
  userData: number,
  data: Uint8Array,
  bitmap: number,
): Uint8Array[] {
  const chunks = splitPayload(data);
  const lastSeq = chunks.length - 1;
  const out: Uint8Array[] = [];
  for (const seq of slotsFromBitmap(bitmap)) {
    if (seq > lastSeq) continue;
    const eom = seq === lastSeq ? EOM : 0;
    out.push(
      encodePacket(
        {
          control: TRESP | eom,
          bitmap: seq,
          transId,
          userData: seq === 0 ? userData : 0,
        },
        chunks[seq]!,
      ),
    );
  }
  return out;
}

/** 3-bit TRel timeout in the low bits of an XO TReq control byte (ClassicStack TRel30s). */
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
 * ClassicStack `haveAll`: complete when the EOM packet and everything before it has
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

/** Bitmap of still-missing response slots (ClassicStack missingMask). */
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
