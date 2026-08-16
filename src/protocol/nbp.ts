/** NBP wire codec (ClassicStack core/protocol/nbp). */

import { encodeMacRoman, decodeMacRoman, atalkEqual } from './macroman';

export const SASSocket = 2;
export const DDPType = 2;
export const CtrlBrRq = 1;
export const CtrlLkUp = 2;
export const CtrlLkUpRply = 3;
export const CtrlFwd = 4;
export const NameWildcard = 0x3d; // '='
export const ZoneWildcard = 0x2a; // '*'

export interface Tuple {
  network: number;
  node: number;
  socket: number;
  enumerator: number;
  object: Uint8Array;
  type: Uint8Array;
  zone: Uint8Array;
}

export interface Packet {
  function: number;
  tupleCount: number;
  nbpId: number;
  tuples: Tuple[];
}

function readPString(data: Uint8Array, o: number): { bytes: Uint8Array; next: number } {
  const len = data[o]!;
  const bytes = data.subarray(o + 1, o + 1 + len);
  return { bytes, next: o + 1 + len };
}

export function parsePacket(data: Uint8Array): Packet {
  if (data.length < 8) throw new Error('nbp: malformed');
  const function_ = data[0]! >>> 4;
  const tupleCount = data[0]! & 0x0f;
  const nbpId = data[1]!;
  const tuples: Tuple[] = [];
  let o = 2;
  for (let t = 0; t < tupleCount; t++) {
    if (o + 5 > data.length) throw new Error('nbp: malformed');
    const network = (data[o]! << 8) | data[o + 1]!;
    const node = data[o + 2]!;
    const socket = data[o + 3]!;
    const enumerator = data[o + 4]!;
    o += 5;
    const obj = readPString(data, o);
    o = obj.next;
    const typ = readPString(data, o);
    o = typ.next;
    const zone = readPString(data, o);
    o = zone.next;
    let zoneBytes = zone.bytes;
    if (zoneBytes.length === 0) zoneBytes = new Uint8Array([ZoneWildcard]);
    tuples.push({
      network,
      node,
      socket,
      enumerator,
      object: obj.bytes,
      type: typ.bytes,
      zone: zoneBytes,
    });
  }
  return { function: function_, tupleCount, nbpId, tuples };
}

function appendEntity(out: number[], obj: Uint8Array, typ: Uint8Array, zone: Uint8Array): void {
  out.push(obj.length, ...obj, typ.length, ...typ, zone.length, ...zone);
}

export function buildLkUp(
  functionCode: number,
  nbpId: number,
  network: number,
  node: number,
  socket: number,
  obj: Uint8Array,
  typ: Uint8Array,
  zone: Uint8Array,
): Uint8Array {
  const out: number[] = [(functionCode << 4) | 1, nbpId, (network >>> 8) & 0xff, network & 0xff, node, socket, 0];
  appendEntity(out, obj, typ, zone);
  return new Uint8Array(out);
}

export function buildLkUpRply(
  nbpId: number,
  network: number,
  node: number,
  socket: number,
  obj: Uint8Array,
  typ: Uint8Array,
  zone: Uint8Array,
): Uint8Array {
  return buildLkUp(CtrlLkUpRply, nbpId, network, node, socket, obj, typ, zone);
}

export function entityBytes(name: string, type: string, zone = '*'): {
  object: Uint8Array;
  type: Uint8Array;
  zone: Uint8Array;
} {
  return {
    object: encodeMacRoman(name),
    type: encodeMacRoman(type),
    zone: encodeMacRoman(zone),
  };
}

export function entityString(t: Tuple): string {
  return `${decodeMacRoman(t.object)}:${decodeMacRoman(t.type)}@${decodeMacRoman(t.zone)}`;
}

/** Match pattern against name; '=' matches anything. */
export function matches(pattern: Uint8Array, name: Uint8Array): boolean {
  if (pattern.length === 1 && pattern[0] === NameWildcard) return true;
  return atalkEqual(pattern, name);
}
