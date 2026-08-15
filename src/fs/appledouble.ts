/** AppleDouble v2 + AppleSingle codecs. */

import { be16, be32, writeBe16, writeBe32 } from '../protocol/binary';
import { crc32 } from '../protocol/crc32';

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

/** Layout of AppleDouble metadata inside downloaded zips. */
export type ZipExportStyle = 'appledouble' | 'macosx';

/** AppleDouble `._Name` beside the data fork, or Mac OS X `__MACOSX/…/._Name`. */
export function zipSidecarPath(dataPath: string, style: ZipExportStyle = 'appledouble'): string {
  const slash = dataPath.lastIndexOf('/');
  const dir = slash >= 0 ? dataPath.slice(0, slash + 1) : '';
  const base = slash >= 0 ? dataPath.slice(slash + 1) : dataPath;
  const sidecar = `._${base}`;
  return style === 'macosx' ? `__MACOSX/${dir}${sidecar}` : `${dir}${sidecar}`;
}

const ZipVersion = 20; // 2.0 — stored files; Archive Utility rejects version 0
const ZipUtf8 = 1 << 11;

/** Minimal ZIP (store only) for AppleDouble download pairs. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const { time: dosTime, date: dosDate } = dosDateTime();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    writeLe32(local, 0, 0x04034b50);
    writeLe16(local, 4, ZipVersion);
    writeLe16(local, 6, ZipUtf8);
    writeLe16(local, 8, 0); // method store
    writeLe16(local, 10, dosTime);
    writeLe16(local, 12, dosDate);
    writeLe32(local, 14, crc);
    writeLe32(local, 18, size);
    writeLe32(local, 22, size);
    writeLe16(local, 26, nameBytes.length);
    local.set(nameBytes, 30);
    local.set(f.data, 30 + nameBytes.length);
    locals.push(local);

    const cen = new Uint8Array(46 + nameBytes.length);
    writeLe32(cen, 0, 0x02014b50);
    writeLe16(cen, 4, ZipVersion);
    writeLe16(cen, 6, ZipVersion);
    writeLe16(cen, 8, ZipUtf8);
    writeLe16(cen, 10, 0);
    writeLe16(cen, 12, dosTime);
    writeLe16(cen, 14, dosDate);
    writeLe32(cen, 16, crc);
    writeLe32(cen, 20, size);
    writeLe32(cen, 24, size);
    writeLe16(cen, 28, nameBytes.length);
    writeLe32(cen, 42, offset);
    cen.set(nameBytes, 46);
    centrals.push(cen);
    offset += local.length;
  }

  let centralLen = 0;
  for (const c of centrals) centralLen += c.length;
  const end = new Uint8Array(22);
  writeLe32(end, 0, 0x06054b50);
  writeLe16(end, 8, files.length);
  writeLe16(end, 10, files.length);
  writeLe32(end, 12, centralLen);
  writeLe32(end, 16, offset);

  const out = new Uint8Array(offset + centralLen + end.length);
  let o = 0;
  for (const p of locals) {
    out.set(p, o);
    o += p.length;
  }
  for (const c of centrals) {
    out.set(c, o);
    o += c.length;
  }
  out.set(end, o);
  return out;
}

function dosDateTime(d = new Date()): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.min(59, d.getSeconds()) >> 1),
  };
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
