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
