/**
 * PICT decoder for bitmap opcodes plus a subset of QuickDraw drawing commands.
 *
 * Opcode layout follows Inside Macintosh: Imaging With QuickDraw, with bitmap
 * packing matching QuickDrawViewer and TwelveMonkeys' PICT reader. Vector ops
 * are recorded and later emitted as SVG (the same “printer driver” approach as
 * QuickDrawViewer, which translates opcodes instead of matching 72 dpi pixels).
 */

import { be16, be32 } from '../../protocol/binary';
import { decodeMacRoman } from '../../protocol/macroman';
import { decodedIconToDataUrl, type DecodedIcon } from '../resource-types/icon-decoder';
import { CLUT4, CLUT8 } from '../resource-types/palettes';
import { decodePackBits } from './packbits';

export interface PictRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type PictVerb = 'frame' | 'paint' | 'erase' | 'invert' | 'fill';

export interface PictRgba {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export type PictOp =
  | { kind: 'clip'; rect: PictRect }
  | { kind: 'fg'; color: string }
  | { kind: 'bg'; color: string }
  | { kind: 'penSize'; h: number; v: number }
  | { kind: 'ovalSize'; h: number; v: number }
  | { kind: 'fontSize'; size: number }
  | { kind: 'fontStyle'; face: number }
  | { kind: 'rect'; verb: PictVerb; rect: PictRect }
  | { kind: 'rrect'; verb: PictVerb; rect: PictRect }
  | { kind: 'oval'; verb: PictVerb; rect: PictRect }
  | { kind: 'arc'; verb: PictVerb; rect: PictRect; start: number; extent: number }
  | { kind: 'poly'; verb: PictVerb; points: { h: number; v: number }[] }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'text'; x: number; y: number; text: string }
  | { kind: 'bitmap'; dst: PictRect; image: PictRgba };

export interface PictPicture {
  version: 1 | 2;
  frame: PictRect;
  width: number;
  height: number;
  ops: PictOp[];
}

const VERBS: PictVerb[] = ['frame', 'paint', 'erase', 'invert', 'fill'];

const QD1: Record<number, string> = {
  30: '#ffffff',
  33: '#000000',
  69: '#ffff00',
  137: '#ff00ff',
  205: '#ff0000',
  273: '#00ffff',
  341: '#00ff00',
  409: '#0000ff',
};

class Cursor {
  constructor(
    readonly b: Uint8Array,
    public o = 0,
  ) {}

  get remaining(): number {
    return this.b.length - this.o;
  }

  eof(): boolean {
    return this.o >= this.b.length;
  }

  need(n: number): boolean {
    return this.o + n <= this.b.length;
  }

  u8(): number {
    return this.b[this.o++] ?? 0;
  }

  i8(): number {
    return (this.u8() << 24) >> 24;
  }

  u16(): number {
    const v = be16(this.b, this.o);
    this.o += 2;
    return v;
  }

  i16(): number {
    return (this.u16() << 16) >> 16;
  }

  u32(): number {
    const v = be32(this.b, this.o);
    this.o += 4;
    return v >>> 0;
  }

  bytes(n: number): Uint8Array {
    const s = this.b.subarray(this.o, this.o + n);
    this.o += s.length;
    return s;
  }

  skip(n: number): void {
    this.o += n;
  }

  align2(): void {
    if (this.o & 1) this.o += 1;
  }

  rect(): PictRect {
    return { top: this.i16(), left: this.i16(), bottom: this.i16(), right: this.i16() };
  }

  pstring(): string {
    const n = this.u8();
    return decodeMacRoman(this.bytes(n));
  }
}

function rectW(r: PictRect): number {
  return Math.max(0, r.right - r.left);
}

function rectH(r: PictRect): number {
  return Math.max(0, r.bottom - r.top);
}

function looksLikePicture(bytes: Uint8Array, o: number): boolean {
  if (o + 12 > bytes.length) return false;
  if (bytes[o + 10] === 0x00 && bytes[o + 11] === 0x11) return true;
  if (bytes[o + 10] === 0x11 && (bytes[o + 11] === 0x01 || bytes[o + 11] === 0x02)) return true;
  return false;
}

function bodyOffset(bytes: Uint8Array): number {
  if (looksLikePicture(bytes, 0)) return 0;
  if (bytes.length >= 512 + 12 && looksLikePicture(bytes, 512)) return 512;
  return 0;
}

function rgb16(r: Cursor): string {
  const red = r.u16();
  const green = r.u16();
  const blue = r.u16();
  return cssRgb(red >> 8, green >> 8, blue >> 8);
}

function cssRgb(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0');
}

function qd1Color(code: number): string {
  return QD1[code] ?? '#000000';
}

function expand5(v: number): number {
  return (v << 3) | (v >> 2);
}

function skipRegion(r: Cursor): PictRect | null {
  if (!r.need(10)) return null;
  let size = r.u16();
  if (size < 10) size += 10;
  const box = r.rect();
  r.skip(Math.max(0, size - 10));
  return box;
}

function skipPoly(r: Cursor): { h: number; v: number }[] {
  if (!r.need(10)) return [];
  const size = r.u16();
  r.rect();
  const n = Math.max(0, Math.floor((size - 10) / 4));
  const pts: { h: number; v: number }[] = [];
  for (let i = 0; i < n && r.need(4); i++) {
    const v = r.i16();
    const h = r.i16();
    pts.push({ h, v });
  }
  return pts;
}

function parseClut(r: Cursor, pixelSize: number): [number, number, number][] {
  if (!r.need(8)) return [];
  r.skip(4);
  r.u16();
  const last = r.u16();
  const colors: [number, number, number][] = [];
  const n = last + 1;
  for (let i = 0; i < n && r.need(8); i++) {
    const idx = r.u16();
    const red = r.u16() >> 8;
    const green = r.u16() >> 8;
    const blue = r.u16() >> 8;
    const slot = idx < 0x8000 ? idx : i;
    colors[slot] = [red, green, blue];
  }
  if (colors.length === 0) {
    if (pixelSize <= 1) return [[255, 255, 255], [0, 0, 0]];
    if (pixelSize <= 4) return CLUT4.map((c) => [c[0], c[1], c[2]]);
    return CLUT8.map((c) => [c[0], c[1], c[2]]);
  }
  return colors;
}

function rowCountPrefix(rowBytes: number, r: Cursor): number {
  if (rowBytes > 250) return r.need(2) ? r.u16() : 0;
  return r.need(1) ? r.u8() : 0;
}

function readPackedRows(
  r: Cursor,
  height: number,
  unpackedRow: number,
  packed: boolean,
  unitBytes: number,
  rowBytesForPrefix: number,
): Uint8Array {
  const out = new Uint8Array(unpackedRow * height);
  for (let y = 0; y < height; y++) {
    if (!packed) {
      out.set(r.bytes(unpackedRow), y * unpackedRow);
      continue;
    }
    const n = rowCountPrefix(rowBytesForPrefix, r);
    const packedRow = r.bytes(n);
    out.set(decodePackBits(packedRow, unpackedRow, unitBytes), y * unpackedRow);
  }
  return out;
}

function sampleIndex(row: Uint8Array, x: number, pixelSize: number): number {
  if (pixelSize >= 8) return row[x] ?? 0;
  if (pixelSize === 4) {
    const b = row[x >> 1] ?? 0;
    return (x & 1) === 0 ? (b >> 4) & 0xf : b & 0xf;
  }
  const b = row[x >> 3] ?? 0;
  return (b >> (7 - (x & 7))) & 1;
}

function rasterIndexed(
  data: Uint8Array,
  width: number,
  height: number,
  rowBytes: number,
  pixelSize: number,
  clut: [number, number, number][],
): PictRgba {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const fallback = pixelSize <= 1 ? ([[255, 255, 255], [0, 0, 0]] as [number, number, number][]) : pixelSize <= 4 ? CLUT4 : CLUT8;
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      const idx = sampleIndex(row, x, pixelSize);
      const c = clut[idx] ?? fallback[idx] ?? fallback[fallback.length - 1] ?? [0, 0, 0];
      const o = (y * width + x) * 4;
      pixels[o] = c[0];
      pixels[o + 1] = c[1];
      pixels[o + 2] = c[2];
      pixels[o + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function raster16(data: Uint8Array, width: number, height: number, rowBytes: number): PictRgba {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * rowBytes + x * 2;
      const p = (data[i]! << 8) | data[i + 1]!;
      const o = (y * width + x) * 4;
      pixels[o] = expand5((p >> 10) & 31);
      pixels[o + 1] = expand5((p >> 5) & 31);
      pixels[o + 2] = expand5(p & 31);
      pixels[o + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function rasterDirect(
  data: Uint8Array,
  width: number,
  height: number,
  cmpCount: number,
  planar: boolean,
): PictRgba {
  const pixels = new Uint8ClampedArray(width * height * 4);
  if (planar) {
    const plane = width;
    for (let y = 0; y < height; y++) {
      const row = y * plane * cmpCount;
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (cmpCount >= 4) {
          pixels[o] = data[row + plane + x] ?? 0;
          pixels[o + 1] = data[row + plane * 2 + x] ?? 0;
          pixels[o + 2] = data[row + plane * 3 + x] ?? 0;
        } else {
          pixels[o] = data[row + x] ?? 0;
          pixels[o + 1] = data[row + plane + x] ?? 0;
          pixels[o + 2] = data[row + plane * 2 + x] ?? 0;
        }
        pixels[o + 3] = 255;
      }
    }
    return { width, height, pixels };
  }
  const stride = cmpCount >= 4 ? 4 : 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * stride;
      const o = (y * width + x) * 4;
      if (stride === 4) {
        pixels[o] = data[i + 1] ?? 0;
        pixels[o + 1] = data[i + 2] ?? 0;
        pixels[o + 2] = data[i + 3] ?? 0;
      } else {
        pixels[o] = data[i] ?? 0;
        pixels[o + 1] = data[i + 1] ?? 0;
        pixels[o + 2] = data[i + 2] ?? 0;
      }
      pixels[o + 3] = 255;
    }
  }
  return { width, height, pixels };
}

interface PixMap {
  rowBytes: number;
  bounds: PictRect;
  packType: number;
  pixelSize: number;
  cmpCount: number;
  clut: [number, number, number][];
  indexed: boolean;
}

function readPixMapTail(r: Cursor, indexed: boolean, pixelSizeHint: number): Omit<PixMap, 'rowBytes' | 'bounds' | 'indexed'> {
  r.u16();
  const packType = r.u16();
  r.u32();
  r.skip(8);
  r.u16();
  const pixelSize = r.u16() || pixelSizeHint;
  const cmpCount = r.u16() || (pixelSize <= 8 ? 1 : pixelSize === 16 ? 1 : 3);
  r.u16();
  r.u32();
  r.u32();
  r.u32();
  const clut = indexed ? parseClut(r, pixelSize) : [];
  return { packType, pixelSize, cmpCount, clut };
}

function readBitMapOrPixMap(r: Cursor): PixMap | null {
  if (!r.need(10)) return null;
  const raw = r.u16();
  const rowBytes = raw & 0x7fff;
  const pixmap = (raw & 0x8000) !== 0;
  const bounds = r.rect();
  if (!pixmap) {
    return {
      rowBytes,
      bounds,
      packType: 0,
      pixelSize: 1,
      cmpCount: 1,
      clut: [
        [255, 255, 255],
        [0, 0, 0],
      ],
      indexed: true,
    };
  }
  if (!r.need(36)) return null;
  const tail = readPixMapTail(r, true, 8);
  return { rowBytes, bounds, indexed: tail.pixelSize <= 8, ...tail };
}

function readDirectPixMap(r: Cursor): PixMap | null {
  if (!r.need(4)) return null;
  r.skip(4);
  if (!r.need(10)) return null;
  const raw = r.u16();
  const rowBytes = raw & 0x7fff;
  const bounds = r.rect();
  if (!r.need(36)) return null;
  const tail = readPixMapTail(r, false, 32);
  return { rowBytes, bounds, indexed: false, ...tail };
}

function effectivePack(pm: PixMap): number {
  if (pm.packType !== 0) return pm.packType;
  if (pm.pixelSize <= 8) return 0;
  if (pm.pixelSize === 16) return 3;
  return 4;
}

function decodePixData(r: Cursor, pm: PixMap, src: PictRect, packedOpcode: boolean): PictRgba | null {
  const width = rectW(pm.bounds) || rectW(src);
  const height = rectH(src) || rectH(pm.bounds);
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return null;
  const pack = packedOpcode ? effectivePack(pm) : pm.packType === 0 ? 1 : pm.packType;
  const packedRows = packedOpcode && pm.rowBytes >= 8 && pack !== 1 && pack !== 2;

  if (pm.indexed || pm.pixelSize <= 8) {
    const unpacked = packedOpcode && pm.rowBytes < 8 ? false : packedRows;
    const data = readPackedRows(r, height, pm.rowBytes, unpacked, 1, pm.rowBytes);
    return rasterIndexed(data, width, height, pm.rowBytes, pm.pixelSize || 1, pm.clut);
  }

  if (pm.pixelSize === 16 || pack === 3) {
    const data = readPackedRows(r, height, pm.rowBytes, pack === 3 || (pack === 0 && packedOpcode), 2, pm.rowBytes);
    return raster16(data, width, height, pm.rowBytes);
  }

  if (pack === 2) {
    const row = width * 3;
    const data = new Uint8Array(row * height);
    for (let y = 0; y < height; y++) data.set(r.bytes(row), y * row);
    return rasterDirect(data, width, height, 3, false);
  }

  if (pack === 4) {
    const cmp = pm.cmpCount === 4 ? 4 : 3;
    const unpackedRow = (pm.rowBytes * cmp) / 4;
    const data = readPackedRows(r, height, unpackedRow, true, 1, pm.rowBytes);
    return rasterDirect(data, width, height, cmp, true);
  }

  const data = readPackedRows(r, height, pm.rowBytes, false, 1, pm.rowBytes);
  if (pm.pixelSize === 32 || pm.cmpCount >= 3) {
    return rasterDirect(data, width, height, pm.cmpCount >= 4 ? 4 : pm.rowBytes / width >= 4 ? 4 : 3, false);
  }
  return rasterIndexed(data, width, height, pm.rowBytes, pm.pixelSize || 8, pm.clut);
}

function readBitsOp(r: Cursor, packed: boolean, hasRgn: boolean): PictOp | null {
  const pm = readBitMapOrPixMap(r);
  if (!pm) return null;
  if (!r.need(18)) return null;
  const src = r.rect();
  const dst = r.rect();
  r.u16();
  if (hasRgn) skipRegion(r);
  const image = decodePixData(r, pm, src, packed);
  if (!image) return null;
  return { kind: 'bitmap', dst, image };
}

function readDirectBitsOp(r: Cursor, hasRgn: boolean): PictOp | null {
  const pm = readDirectPixMap(r);
  if (!pm) return null;
  if (!r.need(18)) return null;
  const src = r.rect();
  const dst = r.rect();
  r.u16();
  if (hasRgn) skipRegion(r);
  const image = decodePixData(r, pm, src, true);
  if (!image) return null;
  return { kind: 'bitmap', dst, image };
}

function skipPixPat(r: Cursor): void {
  if (!r.need(10)) return;
  const sel = r.u16();
  r.skip(8);
  if (sel === 2) {
    if (r.need(6)) r.skip(6);
    return;
  }
  const pm = readBitMapOrPixMap(r);
  if (!pm) return;
  const h = rectH(pm.bounds);
  const packed = pm.rowBytes >= 8;
  readPackedRows(r, h, pm.rowBytes, packed, 1, pm.rowBytes);
}

function skipReserved(r: Cursor, op: number): void {
  if (op <= 0xff) {
    if (op >= 0x24 && op <= 0x27) r.skip(r.u16());
    else if (op >= 0x2c && op <= 0x2f && op !== 0x2c && op !== 0x2e) r.skip(r.u16());
    else if (op >= 0xa2 && op <= 0xaf) r.skip(r.u16());
    else if (op >= 0xd0 && op <= 0xfe) r.skip(r.u32());
    else if (op >= 0x9c && op <= 0x9f) r.skip(r.u32());
    return;
  }
  if (op >= 0x0100 && op <= 0x7fff) r.skip(2 * (op >> 8));
  else if (op >= 0x8100) r.skip(r.u32());
}

function verbOf(op: number, base: number): PictVerb {
  return VERBS[(op - base) & 7] ?? 'paint';
}

export function decodePict(bytes: Uint8Array): PictPicture | null {
  if (bytes.length < 12) return null;
  const r = new Cursor(bytes, bodyOffset(bytes));
  if (!r.need(10)) return null;
  r.u16();
  const frame = r.rect();
  const width = rectW(frame);
  const height = rectH(frame);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null;

  let version: 1 | 2 = 1;
  const ops: PictOp[] = [];
  let lastRect: PictRect = frame;
  let lastRRect = lastRect;
  let lastOval = lastRect;
  let lastArc = lastRect;
  let lastPoly: { h: number; v: number }[] = [];
  let penX = 0;
  let penY = 0;
  let textX = 0;
  let textY = 0;
  let ovalH = 16;
  let ovalV = 16;

  const pushRect = (kind: 'rect' | 'rrect' | 'oval', verb: PictVerb, rect: PictRect): void => {
    ops.push({ kind, verb, rect });
    lastRect = rect;
    if (kind === 'rrect') lastRRect = rect;
    if (kind === 'oval') lastOval = rect;
  };

  try {
    while (!r.eof()) {
      if (version === 2) r.align2();
      if (r.eof()) break;
      const op = version === 1 ? r.u8() : r.u16();
      if (op === 0x00) continue;
      if (op === 0xff) break;
      if (op === 0x11 || op === 0x02ff) {
        if (op === 0x11 && version === 1) {
          const v = r.u8();
          if (v === 2) {
            r.u8();
            version = 2;
          }
        } else if (op === 0x11) {
          const v = r.u8();
          if (v === 2) r.u8();
          version = 2;
        } else {
          version = 2;
        }
        continue;
      }
      if (op === 0x0c00) {
        r.skip(24);
        continue;
      }
      if (op === 0x01) {
        const clip = skipRegion(r);
        if (clip) ops.push({ kind: 'clip', rect: clip });
        continue;
      }
      if (op === 0x02 || op === 0x09 || op === 0x0a) {
        r.skip(8);
        continue;
      }
      if (op === 0x03) {
        r.u16();
        continue;
      }
      if (op === 0x04) {
        ops.push({ kind: 'fontStyle', face: r.u8() });
        continue;
      }
      if (op === 0x05 || op === 0x08 || op === 0x15) {
        r.u16();
        continue;
      }
      if (op === 0x06) {
        r.u32();
        continue;
      }
      if (op === 0x07) {
        const v = r.i16();
        const h = r.i16();
        ops.push({ kind: 'penSize', h: Math.max(1, h), v: Math.max(1, v) });
        continue;
      }
      if (op === 0x0b) {
        ovalV = Math.max(0, r.i16());
        ovalH = Math.max(0, r.i16());
        ops.push({ kind: 'ovalSize', h: ovalH, v: ovalV });
        continue;
      }
      if (op === 0x0c) {
        r.skip(4);
        continue;
      }
      if (op === 0x0d) {
        ops.push({ kind: 'fontSize', size: r.u16() });
        continue;
      }
      if (op === 0x0e) {
        ops.push({ kind: 'fg', color: qd1Color(r.u32()) });
        continue;
      }
      if (op === 0x0f) {
        ops.push({ kind: 'bg', color: qd1Color(r.u32()) });
        continue;
      }
      if (op === 0x10) {
        r.skip(8);
        continue;
      }
      if (op === 0x12 || op === 0x13 || op === 0x14) {
        skipPixPat(r);
        continue;
      }
      if (op === 0x16) {
        r.u16();
        continue;
      }
      if (op === 0x1a) {
        ops.push({ kind: 'fg', color: rgb16(r) });
        continue;
      }
      if (op === 0x1b) {
        ops.push({ kind: 'bg', color: rgb16(r) });
        continue;
      }
      if (op === 0x1c) continue;
      if (op === 0x1d) {
        r.skip(6);
        continue;
      }
      if (op === 0x1e) continue;
      if (op === 0x1f) {
        r.skip(6);
        continue;
      }
      if (op === 0x20) {
        const y1 = r.i16();
        const x1 = r.i16();
        const y2 = r.i16();
        const x2 = r.i16();
        ops.push({ kind: 'line', x1, y1, x2, y2 });
        penX = x2;
        penY = y2;
        continue;
      }
      if (op === 0x21) {
        const y2 = r.i16();
        const x2 = r.i16();
        ops.push({ kind: 'line', x1: penX, y1: penY, x2, y2 });
        penX = x2;
        penY = y2;
        continue;
      }
      if (op === 0x22) {
        const y1 = r.i16();
        const x1 = r.i16();
        const x2 = x1 + r.i8();
        const y2 = y1 + r.i8();
        ops.push({ kind: 'line', x1, y1, x2, y2 });
        penX = x2;
        penY = y2;
        continue;
      }
      if (op === 0x23) {
        const x2 = penX + r.i8();
        const y2 = penY + r.i8();
        ops.push({ kind: 'line', x1: penX, y1: penY, x2, y2 });
        penX = x2;
        penY = y2;
        continue;
      }
      if (op === 0x28) {
        textY = r.i16();
        textX = r.i16();
        const text = r.pstring();
        ops.push({ kind: 'text', x: textX, y: textY, text });
        continue;
      }
      if (op === 0x29) {
        textX += r.i8();
        ops.push({ kind: 'text', x: textX, y: textY, text: r.pstring() });
        continue;
      }
      if (op === 0x2a) {
        textY += r.i8();
        ops.push({ kind: 'text', x: textX, y: textY, text: r.pstring() });
        continue;
      }
      if (op === 0x2b) {
        textX += r.i8();
        textY += r.i8();
        ops.push({ kind: 'text', x: textX, y: textY, text: r.pstring() });
        continue;
      }
      if (op === 0x2c) {
        const n = r.u16();
        r.skip(Math.max(0, n));
        continue;
      }
      if (op === 0x2e) {
        const n = r.u16();
        r.skip(Math.max(0, n));
        continue;
      }
      if (op >= 0x30 && op <= 0x34) {
        const rect = r.rect();
        pushRect('rect', verbOf(op, 0x30), rect);
        continue;
      }
      if (op >= 0x38 && op <= 0x3c) {
        pushRect('rect', verbOf(op, 0x38), lastRect);
        continue;
      }
      if (op >= 0x40 && op <= 0x44) {
        const rect = r.rect();
        pushRect('rrect', verbOf(op, 0x40), rect);
        continue;
      }
      if (op >= 0x48 && op <= 0x4c) {
        pushRect('rrect', verbOf(op, 0x48), lastRRect);
        continue;
      }
      if (op >= 0x50 && op <= 0x54) {
        const rect = r.rect();
        pushRect('oval', verbOf(op, 0x50), rect);
        continue;
      }
      if (op >= 0x58 && op <= 0x5c) {
        pushRect('oval', verbOf(op, 0x58), lastOval);
        continue;
      }
      if (op >= 0x60 && op <= 0x64) {
        const rect = r.rect();
        lastArc = rect;
        ops.push({ kind: 'arc', verb: verbOf(op, 0x60), rect, start: r.i16(), extent: r.i16() });
        continue;
      }
      if (op >= 0x68 && op <= 0x6c) {
        ops.push({ kind: 'arc', verb: verbOf(op, 0x68), rect: lastArc, start: r.i16(), extent: r.i16() });
        continue;
      }
      if (op >= 0x70 && op <= 0x74) {
        lastPoly = skipPoly(r);
        ops.push({ kind: 'poly', verb: verbOf(op, 0x70), points: lastPoly });
        continue;
      }
      if (op >= 0x78 && op <= 0x7c) {
        ops.push({ kind: 'poly', verb: verbOf(op, 0x78), points: lastPoly });
        continue;
      }
      if (op >= 0x80 && op <= 0x84) {
        const box = skipRegion(r);
        if (box && op !== 0x80) pushRect('rect', verbOf(op, 0x80), box);
        continue;
      }
      if (op >= 0x88 && op <= 0x8c) continue;
      if (op === 0x90 || op === 0x91) {
        const bit = readBitsOp(r, false, op === 0x91);
        if (bit) ops.push(bit);
        continue;
      }
      if (op === 0x98 || op === 0x99) {
        const bit = readBitsOp(r, true, op === 0x99);
        if (bit) ops.push(bit);
        continue;
      }
      if (op === 0x9a || op === 0x9b) {
        const bit = readDirectBitsOp(r, op === 0x9b);
        if (bit) ops.push(bit);
        continue;
      }
      if (op === 0xa0) {
        r.u16();
        continue;
      }
      if (op === 0xa1) {
        r.u16();
        r.skip(r.u16());
        continue;
      }
      skipReserved(r, op);
    }
  } catch {
    if (!ops.length) return null;
  }

  if (!ops.length) return null;
  return { version, frame, width, height, ops };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function svgRect(r: PictRect, ox: number, oy: number): string {
  return `x="${r.left - ox}" y="${r.top - oy}" width="${rectW(r)}" height="${rectH(r)}"`;
}

function paintAttrs(verb: PictVerb, fg: string, bg: string, sw: number): string {
  if (verb === 'frame') return `fill="none" stroke="${fg}" stroke-width="${sw}"`;
  if (verb === 'erase') return `fill="${bg}" stroke="none"`;
  if (verb === 'invert') return `fill="${fg}" stroke="none" style="mix-blend-mode:difference"`;
  return `fill="${fg}" stroke="none"`;
}

function arcPath(rect: PictRect, startDeg: number, extent: number, ox: number, oy: number): string {
  const rx = rectW(rect) / 2;
  const ry = rectH(rect) / 2;
  const cx = rect.left - ox + rx;
  const cy = rect.top - oy + ry;
  const toXy = (deg: number): [number, number] => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + rx * Math.sin(rad), cy - ry * Math.cos(rad)];
  };
  const [x1, y1] = toXy(startDeg);
  const [x2, y2] = toXy(startDeg + extent);
  const large = Math.abs(extent) > 180 ? 1 : 0;
  const sweep = extent >= 0 ? 1 : 0;
  return `M ${x1} ${y1} A ${rx} ${ry} 0 ${large} ${sweep} ${x2} ${y2}`;
}

export async function pictToSvg(picture: PictPicture): Promise<string> {
  const ox = picture.frame.left;
  const oy = picture.frame.top;
  const parts: string[] = [];
  let fg = '#000000';
  let bg = '#ffffff';
  let sw = 1;
  let rx = 16;
  let ry = 16;
  let fontSize = 12;
  let fontWeight = '400';
  let fontStyle = 'normal';
  let clipId: string | null = null;

  for (let i = 0; i < picture.ops.length; i++) {
    const op = picture.ops[i]!;
    if (op.kind === 'fg') fg = op.color;
    else if (op.kind === 'bg') bg = op.color;
    else if (op.kind === 'penSize') sw = Math.max(1, (op.h + op.v) / 2);
    else if (op.kind === 'ovalSize') {
      rx = op.h;
      ry = op.v;
    } else if (op.kind === 'fontSize') fontSize = Math.max(1, op.size);
    else if (op.kind === 'fontStyle') {
      fontWeight = op.face & 1 ? '700' : '400';
      fontStyle = op.face & 2 ? 'italic' : 'normal';
    } else if (op.kind === 'clip') {
      clipId = `c${i}`;
      parts.push(
        `<clipPath id="${clipId}"><rect ${svgRect(op.rect, ox, oy)} /></clipPath>`,
      );
    } else if (op.kind === 'rect') {
      parts.push(`<rect ${svgRect(op.rect, ox, oy)} ${paintAttrs(op.verb, fg, bg, sw)} />`);
    } else if (op.kind === 'rrect') {
      parts.push(
        `<rect ${svgRect(op.rect, ox, oy)} rx="${rx}" ry="${ry}" ${paintAttrs(op.verb, fg, bg, sw)} />`,
      );
    } else if (op.kind === 'oval') {
      const w = rectW(op.rect);
      const h = rectH(op.rect);
      parts.push(
        `<ellipse cx="${op.rect.left - ox + w / 2}" cy="${op.rect.top - oy + h / 2}" rx="${w / 2}" ry="${h / 2}" ${paintAttrs(op.verb, fg, bg, sw)} />`,
      );
    } else if (op.kind === 'arc') {
      const d = arcPath(op.rect, op.start, op.extent, ox, oy);
      if (op.verb === 'frame') parts.push(`<path d="${d}" fill="none" stroke="${fg}" stroke-width="${sw}" />`);
      else {
        const w = rectW(op.rect);
        const h = rectH(op.rect);
        parts.push(
          `<path d="M ${op.rect.left - ox + w / 2} ${op.rect.top - oy + h / 2} ${d.slice(1)} Z" ${paintAttrs(op.verb, fg, bg, sw)} />`,
        );
      }
    } else if (op.kind === 'poly' && op.points.length) {
      const pts = op.points.map((p) => `${p.h - ox},${p.v - oy}`).join(' ');
      parts.push(`<polygon points="${pts}" ${paintAttrs(op.verb, fg, bg, sw)} />`);
    } else if (op.kind === 'line') {
      parts.push(
        `<line x1="${op.x1 - ox}" y1="${op.y1 - oy}" x2="${op.x2 - ox}" y2="${op.y2 - oy}" stroke="${fg}" stroke-width="${sw}" />`,
      );
    } else if (op.kind === 'text') {
      parts.push(
        `<text x="${op.x - ox}" y="${op.y - oy}" fill="${fg}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" font-family="Geneva, Chicago, sans-serif">${esc(op.text)}</text>`,
      );
    } else if (op.kind === 'bitmap') {
      const icon: DecodedIcon = {
        typeCode: 'PICT',
        isColor: true,
        width: op.image.width,
        height: op.image.height,
        pixels: op.image.pixels,
      };
      const url = await decodedIconToDataUrl(icon);
      if (url) {
        parts.push(
          `<image ${svgRect(op.dst, ox, oy)} href="${esc(url)}" preserveAspectRatio="none" />`,
        );
      }
    }
  }

  const clip = clipId ? ` clip-path="url(#${clipId})"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${picture.width}" height="${picture.height}" viewBox="0 0 ${picture.width} ${picture.height}" style="background:${bg}">
  <g${clip}>${parts.join('')}</g>
</svg>`;
}

export async function pictToSvgDataUrl(bytes: Uint8Array): Promise<string | null> {
  const picture = decodePict(bytes);
  if (!picture) return null;
  const svg = await pictToSvg(picture);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
