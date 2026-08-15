/** Shared Macintosh file payload used by MacBinary, BinHex, and auto-expand. */

import { writeBe16 } from '../protocol/binary';
import { padOsType } from './extension-map';

export type MacFile = {
  name: string;
  data: Uint8Array;
  resource: Uint8Array;
  finderInfo: Uint8Array;
  /** Classic Mac OS timestamp (seconds since 1904), when the wrapper provided one. */
  createDate?: number;
  modDate?: number;
};

export function makeFinderInfo(
  type: string,
  creator: string,
  flags = 0,
  locationV = 0,
  locationH = 0,
  folder = 0,
): Uint8Array {
  const fi = new Uint8Array(32);
  const t = padOsType(type);
  const c = padOsType(creator);
  for (let i = 0; i < 4; i++) {
    fi[i] = t.charCodeAt(i) || 0x20;
    fi[4 + i] = c.charCodeAt(i) || 0x20;
  }
  writeBe16(fi, 8, flags);
  writeBe16(fi, 10, locationV);
  writeBe16(fi, 12, locationH);
  writeBe16(fi, 14, folder);
  return fi;
}

export function ostypeFromBytes(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}
