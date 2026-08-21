/**
 * Windows ICO / CUR decoder (ICONDIR + BMP DIB or PNG images).
 * PNG frames need createImageBitmap (skipped in environments without it).
 */

import { le16, le32, writeLe16, writeLe32 } from '../../protocol/binary';
import type { ByteRangeReader } from '../byte-range';
import { bufferRangeReader } from '../byte-range';
import type { DecodedIcon } from '../resource-types/icon-decoder';
import { decodeIcoDib, dibRowBytes } from './bmp';
import { readExact, readSlice } from './read';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_IMAGES = 64;
const MAX_IMAGE = 2 * 1024 * 1024;

export type IcoKind = 'ico' | 'cur';

export function sniffIcoHeader(data: Uint8Array): IcoKind | null {
  if (data.length < 6) return null;
  if (le16(data, 0) !== 0) return null;
  const type = le16(data, 2);
  const count = le16(data, 4);
  if (count === 0 || count > MAX_IMAGES) return null;
  if (type === 1) return 'ico';
  if (type === 2) return 'cur';
  return null;
}

function isPng(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== PNG_SIG[i]) return false;
  return true;
}

async function decodePngIcon(data: Uint8Array, typeCode: string): Promise<DecodedIcon | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const blob = new Blob([data], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close();
      return null;
    }
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return {
      typeCode,
      isColor: true,
      width: img.width,
      height: img.height,
      pixels: img.data,
    };
  } catch {
    return null;
  }
}

type IcoEntry = { width: number; height: number; bytesInRes: number; imageOffset: number };

function parseEntries(dir: Uint8Array, count: number): IcoEntry[] | null {
  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > dir.length) return null;
    const w = dir[o] || 256;
    const h = dir[o + 1] || 256;
    const bytesInRes = le32(dir, o + 8);
    const imageOffset = le32(dir, o + 12);
    if (bytesInRes <= 0 || bytesInRes > MAX_IMAGE) return null;
    entries.push({ width: w, height: h, bytesInRes, imageOffset });
  }
  return entries;
}

/** Decode a whole ICO/CUR buffer. */
export async function decodeIco(data: Uint8Array): Promise<DecodedIcon[]> {
  return decodeIcoFromReader(bufferRangeReader(data));
}

export type IcoFrame = {
  index: number;
  width: number;
  height: number;
  bytes: Uint8Array;
};

/** Directory + raw image payloads for each ICO/CUR frame. */
export async function enumerateIcoFrames(
  read: ByteRangeReader,
): Promise<{ kind: IcoKind; frames: IcoFrame[] } | null> {
  const header = await readExact(read, 0, 6);
  if (!header) return null;
  const kind = sniffIcoHeader(header);
  if (!kind) return null;
  const count = le16(header, 4);
  const dir = await readExact(read, 0, 6 + count * 16);
  if (!dir) return null;
  const entries = parseEntries(dir, count);
  if (!entries) return null;
  const frames: IcoFrame[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const bytes = await readSlice(read, e.imageOffset, e.bytesInRes);
    if (!bytes.length) continue;
    frames.push({ index: i, width: e.width, height: e.height, bytes });
  }
  return { kind, frames };
}

/** Decode ICO/CUR via ranged reads (directory then each image). */
export async function decodeIcoFromReader(read: ByteRangeReader): Promise<DecodedIcon[]> {
  const header = await readExact(read, 0, 6);
  if (!header) return [];
  const kind = sniffIcoHeader(header);
  if (!kind) return [];
  const count = le16(header, 4);
  const dir = await readExact(read, 0, 6 + count * 16);
  if (!dir) return [];
  const entries = parseEntries(dir, count);
  if (!entries) return [];
  const typeCode = kind === 'cur' ? 'CUR' : 'ICO';
  const icons: DecodedIcon[] = [];
  for (const e of entries) {
    const raw = await readSlice(read, e.imageOffset, e.bytesInRes);
    if (raw.length < 16) continue;
    if (isPng(raw)) {
      const png = await decodePngIcon(raw, typeCode);
      if (png) icons.push(png);
      continue;
    }
    const dib = decodeIcoDib(raw, typeCode);
    if (dib) icons.push(dib);
  }
  return icons;
}

/** Build a 32-bpp ICO from top-down RGBA frames (tests + PE/NE round-trip). */
export function encodeIco(frames: DecodedIcon[]): Uint8Array {
  const n = frames.length;
  const dirSize = 6 + n * 16;
  const images: Uint8Array[] = frames.map(encodeIcoDib32);
  let off = dirSize;
  const out = new Uint8Array(dirSize + images.reduce((s, im) => s + im.length, 0));
  writeLe16(out, 0, 0);
  writeLe16(out, 2, 1);
  writeLe16(out, 4, n);
  for (let i = 0; i < n; i++) {
    const fr = frames[i]!;
    const im = images[i]!;
    const e = 6 + i * 16;
    out[e] = fr.width >= 256 ? 0 : fr.width;
    out[e + 1] = fr.height >= 256 ? 0 : fr.height;
    out[e + 2] = 0;
    out[e + 3] = 0;
    writeLe16(out, e + 4, 1);
    writeLe16(out, e + 6, 32);
    writeLe32(out, e + 8, im.length);
    writeLe32(out, e + 12, off);
    out.set(im, off);
    off += im.length;
  }
  return out;
}

function encodeIcoDib32(icon: DecodedIcon): Uint8Array {
  const w = icon.width;
  const h = icon.height;
  const xorStride = dibRowBytes(w, 32);
  const andStride = dibRowBytes(w, 1);
  const xorLen = xorStride * h;
  const andLen = andStride * h;
  const out = new Uint8Array(40 + xorLen + andLen);
  writeLe32(out, 0, 40);
  writeLe32(out, 4, w);
  writeLe32(out, 8, h * 2);
  writeLe16(out, 12, 1);
  writeLe16(out, 14, 32);
  const xorOff = 40;
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y;
    const row = xorOff + y * xorStride;
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4;
      const d = row + x * 4;
      out[d] = icon.pixels[s + 2]!;
      out[d + 1] = icon.pixels[s + 1]!;
      out[d + 2] = icon.pixels[s]!;
      out[d + 3] = icon.pixels[s + 3]!;
    }
  }
  return out;
}

/** ICONDIR wrapping a single PNG or DIB image (PE RT_ICON PNG frames). */
export function wrapSingleIcoImage(image: Uint8Array, type = 1): Uint8Array {
  const out = new Uint8Array(22 + image.length);
  writeLe16(out, 2, type === 2 ? 2 : 1);
  writeLe16(out, 4, 1);
  out[6] = 32;
  out[7] = 32;
  writeLe16(out, 10, 1);
  writeLe16(out, 12, 32);
  writeLe32(out, 14, image.length);
  writeLe32(out, 18, 22);
  out.set(image, 22);
  return out;
}

/** GRPICONDIR (PE/NE RT_GROUP_ICON) → ICONDIR with image payloads from RT_ICON ids. */
export function assembleIcoFromGroup(
  group: Uint8Array,
  iconsById: Map<number, Uint8Array>,
): Uint8Array | null {
  if (group.length < 6) return null;
  if (le16(group, 0) !== 0) return null;
  const type = le16(group, 2);
  if (type !== 1 && type !== 2) return null;
  const count = le16(group, 4);
  if (count === 0 || count > MAX_IMAGES) return null;
  const entries: { dir: Uint8Array; data: Uint8Array }[] = [];
  let payload = 0;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14;
    if (o + 14 > group.length) return null;
    const id = le16(group, o + 12);
    const data = iconsById.get(id);
    if (!data?.length) continue;
    const ent = new Uint8Array(16);
    ent.set(group.subarray(o, o + 12));
    writeLe32(ent, 8, data.length);
    entries.push({ dir: ent, data });
    payload += data.length;
  }
  if (!entries.length) return null;
  const dirSize = 6 + entries.length * 16;
  const out = new Uint8Array(dirSize + payload);
  writeLe16(out, 0, 0);
  writeLe16(out, 2, type);
  writeLe16(out, 4, entries.length);
  let off = 6 + entries.length * 16;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    writeLe32(e.dir, 12, off);
    out.set(e.dir, 6 + i * 16);
    out.set(e.data, off);
    off += e.data.length;
  }
  return out;
}
