/**
 * Windows DIB (BITMAPINFOHEADER) used as the image payload inside ICO/CUR.
 * Height in the header is XOR+AND (2× icon height) for icons.
 */

import { le16, le32 } from '../../protocol/binary';
import type { DecodedIcon } from '../resource-types/icon-decoder';

const BI_RGB = 0;
const BI_BITFIELDS = 3;

export function dibRowBytes(width: number, bitCount: number): number {
  return ((width * bitCount + 31) >> 5) << 2;
}

function paletteCount(bitCount: number, biClrUsed: number): number {
  if (biClrUsed > 0) return biClrUsed;
  if (bitCount === 1) return 2;
  if (bitCount === 4) return 16;
  if (bitCount === 8) return 256;
  return 0;
}

function sampleAnd(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  const rowBytes = dibRowBytes(width, 1);
  const row = (height - 1 - y) * rowBytes;
  const byte = mask[row + (x >> 3)];
  if (byte == null) return false;
  return (byte & (0x80 >> (x & 7))) !== 0;
}

/**
 * Decode a Windows DIB to RGBA. Icon DIBs (`icon: true`) store XOR then AND
 * so BITMAPINFOHEADER height is 2×. RT_BITMAP uses the raw height.
 */
export function decodeIcoDib(
  data: Uint8Array,
  typeCode = 'ICO',
  opts?: { icon?: boolean; maxDim?: number },
): DecodedIcon | null {
  if (data.length < 40) return null;
  const icon = opts?.icon !== false;
  const maxDim = opts?.maxDim ?? (icon ? 256 : 2048);
  const biSize = le32(data, 0);
  if (biSize < 40) return null;
  const width = le32(data, 4) | 0;
  const rawHeight = le32(data, 8) | 0;
  if (width <= 0 || width > maxDim || rawHeight === 0) return null;
  const absH = Math.abs(rawHeight);
  const height = icon ? (absH === width * 2 || absH > width ? Math.floor(absH / 2) : absH) : absH;
  if (height <= 0 || height > maxDim) return null;
  const planes = le16(data, 12);
  const bitCount = le16(data, 14);
  const compression = le32(data, 16);
  const clrUsed = le32(data, 32);
  if (planes !== 1) return null;
  if (compression !== BI_RGB && compression !== BI_BITFIELDS) return null;
  if (![1, 4, 8, 24, 32].includes(bitCount)) return null;

  let off = biSize;
  if (compression === BI_BITFIELDS) {
    off += 12;
  }
  const nPal = paletteCount(bitCount, clrUsed);
  const palette: [number, number, number][] = [];
  for (let i = 0; i < nPal; i++) {
    if (off + 4 > data.length) return null;
    palette.push([data[off]!, data[off + 1]!, data[off + 2]!]); // B,G,R
    off += 4;
  }

  const xorStride = dibRowBytes(width, bitCount);
  const xorLen = xorStride * height;
  if (off + xorLen > data.length) return null;
  const xorOff = off;
  off += xorLen;
  const andStride = dibRowBytes(width, 1);
  const andLen = andStride * height;
  const and = off + andLen <= data.length ? data.subarray(off, off + andLen) : new Uint8Array(andLen);

  const pixels = new Uint8ClampedArray(width * height * 4);
  let hasXorAlpha = false;

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    const row = xorOff + srcY * xorStride;
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (bitCount === 32) {
        const p = row + x * 4;
        b = data[p]!;
        g = data[p + 1]!;
        r = data[p + 2]!;
        a = data[p + 3]!;
        if (a) hasXorAlpha = true;
      } else if (bitCount === 24) {
        const p = row + x * 3;
        b = data[p]!;
        g = data[p + 1]!;
        r = data[p + 2]!;
      } else if (bitCount === 8) {
        const idx = data[row + x]!;
        const c = palette[idx] ?? [0, 0, 0];
        b = c[0];
        g = c[1];
        r = c[2];
      } else if (bitCount === 4) {
        const byte = data[row + (x >> 1)]!;
        const idx = x & 1 ? byte & 0xf : (byte >> 4) & 0xf;
        const c = palette[idx] ?? [0, 0, 0];
        b = c[0];
        g = c[1];
        r = c[2];
      } else {
        const byte = data[row + (x >> 3)]!;
        const on = (byte & (0x80 >> (x & 7))) !== 0;
        const c = palette[on ? 1 : 0] ?? (on ? [255, 255, 255] : [0, 0, 0]);
        b = c[0];
        g = c[1];
        r = c[2];
      }
      pixels[dst] = r;
      pixels[dst + 1] = g;
      pixels[dst + 2] = b;
      pixels[dst + 3] = a;
    }
  }

  if (icon && (bitCount !== 32 || !hasXorAlpha)) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (sampleAnd(and, width, height, x, y)) {
          pixels[(y * width + x) * 4 + 3] = 0;
        }
      }
    }
  }

  return {
    typeCode,
    isColor: bitCount > 1,
    width,
    height,
    pixels,
  };
}

const BMP_MAGIC = 0x4d42; // 'BM'

export function sniffBmp(data: Uint8Array): boolean {
  return data.length >= 14 && le16(data, 0) === BMP_MAGIC;
}

/**
 * Decode a Windows BMP file (BITMAPFILEHEADER + DIB). OS/2 COREHEADER
 * and RLE-compressed files are not supported.
 */
export function decodeBmp(data: Uint8Array): DecodedIcon | null {
  if (!sniffBmp(data)) return null;
  const offBits = le32(data, 10);
  if (offBits < 14 || offBits > data.length) return null;
  return decodeIcoDib(data.subarray(14), 'BMP', { icon: false });
}
