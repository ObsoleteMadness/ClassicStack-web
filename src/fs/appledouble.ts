/** AppleDouble v2 + AppleSingle codecs. */

import { be16, be32, writeBe16, writeBe32 } from '../protocol/binary';

export const AD_MAGIC = 0x00051607;
export const AS_MAGIC = 0x00051600;
export const AD_VERSION = 0x00020000;

export const EntryDataFork = 1;
export const EntryResourceFork = 2;
export const EntryFinderInfo = 9;

const HeaderSize = 26;
const EntrySize = 12;

export interface AppleDoubleData {
  finderInfo: Uint8Array; // 32 bytes
  resource: Uint8Array;
}

export function parseAppleDouble(b: Uint8Array): AppleDoubleData | null {
  if (b.length < HeaderSize) return null;
  if (be32(b, 0) !== AD_MAGIC) return null;
  const num = be16(b, 24);
  const out: AppleDoubleData = {
    finderInfo: new Uint8Array(32),
    resource: new Uint8Array(),
  };
  for (let i = 0; i < num; i++) {
    const o = HeaderSize + i * EntrySize;
    if (o + EntrySize > b.length) break;
    const id = be32(b, o);
    const off = be32(b, o + 4);
    const len = be32(b, o + 8);
    if (off + len > b.length) continue;
    const slice = b.subarray(off, off + len);
    if (id === EntryFinderInfo) out.finderInfo.set(slice.subarray(0, 32));
    if (id === EntryResourceFork) out.resource = slice.slice();
  }
  return out;
}

export function buildAppleDouble(finderInfo: Uint8Array, resource: Uint8Array): Uint8Array {
  const numEntries = 2;
  const finderOff = HeaderSize + numEntries * EntrySize;
  const rsrcOff = finderOff + 32;
  const total = rsrcOff + resource.length;
  const out = new Uint8Array(total);
  writeBe32(out, 0, AD_MAGIC);
  writeBe32(out, 4, AD_VERSION);
  writeBe16(out, 24, numEntries);
  // FinderInfo entry
  writeBe32(out, HeaderSize, EntryFinderInfo);
  writeBe32(out, HeaderSize + 4, finderOff);
  writeBe32(out, HeaderSize + 8, 32);
  // Resource entry
  writeBe32(out, HeaderSize + EntrySize, EntryResourceFork);
  writeBe32(out, HeaderSize + EntrySize + 4, rsrcOff);
  writeBe32(out, HeaderSize + EntrySize + 8, resource.length);
  out.set(finderInfo.subarray(0, 32), finderOff);
  out.set(resource, rsrcOff);
  return out;
}

export interface AppleSingleData {
  data: Uint8Array;
  resource: Uint8Array;
  finderInfo: Uint8Array;
}

export function parseAppleSingle(b: Uint8Array): AppleSingleData | null {
  if (b.length < HeaderSize) return null;
  if (be32(b, 0) !== AS_MAGIC) return null;
  const num = be16(b, 24);
  const out: AppleSingleData = {
    data: new Uint8Array(),
    resource: new Uint8Array(),
    finderInfo: new Uint8Array(32),
  };
  for (let i = 0; i < num; i++) {
    const o = HeaderSize + i * EntrySize;
    if (o + EntrySize > b.length) break;
    const id = be32(b, o);
    const off = be32(b, o + 4);
    const len = be32(b, o + 8);
    if (off + len > b.length) continue;
    const slice = b.subarray(off, off + len);
    if (id === EntryDataFork) out.data = slice.slice();
    if (id === EntryResourceFork) out.resource = slice.slice();
    if (id === EntryFinderInfo) out.finderInfo.set(slice.subarray(0, 32));
  }
  return out;
}

export function buildAppleSingle(data: Uint8Array, resource: Uint8Array, finderInfo: Uint8Array): Uint8Array {
  const numEntries = 3;
  const finderOff = HeaderSize + numEntries * EntrySize;
  const rsrcOff = finderOff + 32;
  // 4K-align resource often; keep simple contiguous
  const dataOff = rsrcOff + resource.length;
  const total = dataOff + data.length;
  const out = new Uint8Array(total);
  writeBe32(out, 0, AS_MAGIC);
  writeBe32(out, 4, AD_VERSION);
  writeBe16(out, 24, numEntries);
  let e = HeaderSize;
  writeBe32(out, e, EntryFinderInfo);
  writeBe32(out, e + 4, finderOff);
  writeBe32(out, e + 8, 32);
  e += EntrySize;
  writeBe32(out, e, EntryResourceFork);
  writeBe32(out, e + 4, rsrcOff);
  writeBe32(out, e + 8, resource.length);
  e += EntrySize;
  writeBe32(out, e, EntryDataFork);
  writeBe32(out, e + 4, dataOff);
  writeBe32(out, e + 8, data.length);
  out.set(finderInfo.subarray(0, 32), finderOff);
  out.set(resource, rsrcOff);
  out.set(data, dataOff);
  return out;
}

/** Minimal ZIP (store only) for AppleDouble download pairs. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const local = new Uint8Array(30 + nameBytes.length + f.data.length);
    // local file header
    writeLe32(local, 0, 0x04034b50);
    writeLe16(local, 8, 0); // method store
    writeLe16(local, 26, nameBytes.length);
    writeLe32(local, 18, f.data.length); // comp size
    writeLe32(local, 22, f.data.length); // uncomp
    // crc optional 0
    local.set(nameBytes, 30);
    local.set(f.data, 30 + nameBytes.length);
    parts.push(local);

    const cen = new Uint8Array(46 + nameBytes.length);
    writeLe32(cen, 0, 0x02014b50);
    writeLe16(cen, 10, 0);
    writeLe16(cen, 28, nameBytes.length);
    writeLe32(cen, 16, f.data.length);
    writeLe32(cen, 20, f.data.length);
    writeLe32(cen, 42, offset);
    cen.set(nameBytes, 46);
    central.push(...cen);
    offset += local.length;
  }

  const centralBuf = new Uint8Array(central);
  const end = new Uint8Array(22);
  writeLe32(end, 0, 0x06054b50);
  writeLe16(end, 8, files.length);
  writeLe16(end, 10, files.length);
  writeLe32(end, 12, centralBuf.length);
  writeLe32(end, 16, offset);

  const total = offset + centralBuf.length + end.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  out.set(centralBuf, o);
  o += centralBuf.length;
  out.set(end, o);
  return out;
}

function writeLe16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}

function writeLe32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
