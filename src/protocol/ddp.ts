/** DDP long + short header codecs (OmniTalk core/protocol/ddp). */

import { appendBe16, be16, writeBe16 } from './binary';

export const MaxDataLength = 586;
export const LongHeaderLen = 13;
export const ShortHeaderLen = 5;

export interface Datagram {
  hops: number;
  destNetwork: number;
  srcNetwork: number;
  destNode: number;
  srcNode: number;
  destSocket: number;
  srcSocket: number;
  ddpType: number;
  data: Uint8Array;
}

function checksum(data: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < data.length; i++) {
    v = (v + data[i]!) & 0xffff;
    v = ((v & 0x7fff) << 1) | ((v >>> 15) & 1);
  }
  return v === 0 ? 0xffff : v;
}

export function encodeLong(d: Datagram): Uint8Array {
  if (d.data.length > MaxDataLength) throw new Error('ddp: data too long');
  const length = LongHeaderLen + d.data.length;
  const out = new Uint8Array(length);
  out[0] = ((d.hops & 0x0f) << 2) | ((length & 0x300) >>> 8);
  out[1] = length & 0xff;
  // checksum left 0 (disabled)
  writeBe16(out, 4, d.destNetwork);
  writeBe16(out, 6, d.srcNetwork);
  out[8] = d.destNode;
  out[9] = d.srcNode;
  out[10] = d.destSocket;
  out[11] = d.srcSocket;
  out[12] = d.ddpType;
  out.set(d.data, 13);
  return out;
}

export function decodeLong(b: Uint8Array): Datagram {
  if (b.length < LongHeaderLen) throw new Error('ddp: short');
  const first = b[0]!;
  if ((first & 0xc0) !== 0) throw new Error('ddp: bad header');
  const hops = (first & 0x3c) >>> 2;
  const length = ((first & 0x03) << 8) | b[1]!;
  if (length !== b.length || length > LongHeaderLen + MaxDataLength) {
    throw new Error('ddp: bad length');
  }
  const sum = be16(b, 2);
  if (sum !== 0 && checksum(b.subarray(4)) !== sum) {
    throw new Error('ddp: bad checksum');
  }
  return {
    hops,
    destNetwork: be16(b, 4),
    srcNetwork: be16(b, 6),
    destNode: b[8]!,
    srcNode: b[9]!,
    destSocket: b[10]!,
    srcSocket: b[11]!,
    ddpType: b[12]!,
    data: b.subarray(13),
  };
}

/** Short-header DDP on LocalTalk: nets/nodes come from LLAP. */
export function encodeShort(
  destSocket: number,
  srcSocket: number,
  ddpType: number,
  data: Uint8Array,
): Uint8Array {
  if (data.length > MaxDataLength) throw new Error('ddp: data too long');
  const length = ShortHeaderLen + data.length;
  const out = new Uint8Array(length);
  out[0] = (length >>> 8) & 0xff;
  out[1] = length & 0xff;
  out[2] = destSocket;
  out[3] = srcSocket;
  out[4] = ddpType;
  out.set(data, 5);
  return out;
}

export function decodeShort(
  b: Uint8Array,
  network: number,
  destNode: number,
  srcNode: number,
): Datagram {
  if (b.length < ShortHeaderLen) throw new Error('ddp: short header too small');
  const length = (b[0]! << 8) | b[1]!;
  if (length !== b.length) throw new Error('ddp: short length mismatch');
  return {
    hops: 0,
    destNetwork: network,
    srcNetwork: network,
    destNode,
    srcNode,
    destSocket: b[2]!,
    srcSocket: b[3]!,
    ddpType: b[4]!,
    data: b.subarray(5),
  };
}

export function wrapLlap(
  dstNode: number,
  srcNode: number,
  long: boolean,
  ddpPayload: Uint8Array,
): Uint8Array {
  const type = long ? 0x02 : 0x01;
  const out = new Uint8Array(3 + ddpPayload.length);
  out[0] = dstNode;
  out[1] = srcNode;
  out[2] = type;
  out.set(ddpPayload, 3);
  return out;
}

export { appendBe16 };
