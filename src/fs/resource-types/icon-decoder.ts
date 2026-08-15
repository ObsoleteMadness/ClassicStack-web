/**
 * Classic Mac icon family decoder (port of LibHfs.ResourceForks.ResourceTypes.IconDecoder).
 */

import { be16 } from '../../protocol/binary';
import { CLUT4, CLUT8 } from './palettes';
import { parsePixMap } from './pixmap';
import { parseColorTable } from './color-table';

export interface DecodedIcon {
  typeCode: string;
  isColor: boolean;
  width: number;
  height: number;
  /** RGBA bytes */
  pixels: Uint8ClampedArray;
}

export const SUPPORTED_ICON_TYPES = [
  'cicn',
  'icl8',
  'ics8',
  'icm8',
  'ich8',
  'icl4',
  'ics4',
  'icm4',
  'ich4',
  'ICN#',
  'ICON',
  'ics#',
  'icm#',
  'ich#',
] as const;

function be16s(b: Uint8Array, o: number): number {
  return (be16(b, o) << 16) >> 16;
}

function clut4ToRgb(n: number): [number, number, number] {
  const i = Math.max(0, Math.min(CLUT4.length - 1, n));
  const c = CLUT4[i]!;
  return [c[0], c[1], c[2]];
}

function clut8ToRgb(n: number): [number, number, number] {
  const i = Math.max(0, Math.min(CLUT8.length - 1, n));
  const c = CLUT8[i]!;
  return [c[0], c[1], c[2]];
}

export function applyMask(icon: DecodedIcon, mask: DecodedIcon): DecodedIcon {
  if (icon.width !== mask.width || icon.height !== mask.height) return icon;
  const rgba = new Uint8ClampedArray(icon.width * icon.height * 4);
  for (let i = 0; i < icon.width * icon.height; i++) {
    rgba[i * 4]! = icon.pixels[i * 4]!;
    rgba[i * 4 + 1]! = icon.pixels[i * 4 + 1]!;
    rgba[i * 4 + 2]! = icon.pixels[i * 4 + 2]!;
    rgba[i * 4 + 3]! = mask.pixels[i * 4 + 3]!;
  }
  return {
    typeCode: icon.typeCode,
    isColor: icon.isColor,
    width: icon.width,
    height: icon.height,
    pixels: rgba,
  };
}

export function decodeIcon(
  resType: string,
  data: Uint8Array,
  mask: DecodedIcon | null = null,
): DecodedIcon | null {
  const t = resType.trim();
  switch (t) {
    case 'cicn':
      return decodeCicn(t, data);
    case 'ICON':
    case 'ICN#':
      return decode1BitIcon(t, data, 32, 32);
    case 'ics#':
      return decode1BitIcon(t, data, 16, 16);
    case 'icm#':
      return decode1BitIcon(t, data, 16, 12);
    case 'ics4':
      return decode4BitIcon(t, data, 16, 16, mask);
    case 'icl4':
      return decode4BitIcon(t, data, 32, 32, mask);
    case 'icm4':
      return decode4BitIcon(t, data, 16, 12, mask);
    case 'ics8':
      return decode8BitIcon(t, data, 16, 16, mask);
    case 'icl8':
      return decode8BitIcon(t, data, 32, 32, mask);
    case 'icm8':
      return decode8BitIcon(t, data, 16, 12, mask);
    case 'ich#':
      return decode1BitIcon(t, data, 48, 48);
    case 'ich4':
      return decode4BitIcon(t, data, 48, 48, mask);
    case 'ich8':
      return decode8BitIcon(t, data, 48, 48, mask);
    default:
      if (data.length === 2304) return decode8BitIcon(t, data, 48, 48, mask);
      if (data.length === 1152) return decode4BitIcon(t, data, 48, 48, mask);
      if (data.length === 1024) return decode8BitIcon(t, data, 32, 32, mask);
      if (data.length === 512) return decode4BitIcon(t, data, 32, 32, mask);
      if (data.length === 256) return decode8BitIcon(t, data, 16, 16, mask);
      if (data.length === 128) return decode4BitIcon(t, data, 16, 16, mask);
      if (data.length === 32) return decode1BitIcon(t, data, 16, 16);
      if (data.length === 64) return decode1BitIcon(t, data, 16, 16);
      if (data.length === 24) return decode1BitIcon(t, data, 16, 12);
      if (data.length === 48) return decode1BitIcon(t, data, 16, 12);
      if (data.length === 288) return decode1BitIcon(t, data, 48, 48);
      return null;
  }
}

function decode1BitIcon(
  resType: string,
  data: Uint8Array,
  width: number,
  height: number,
): DecodedIcon | null {
  const pixels = width * height;
  const bytesPerPlane = pixels / 8;
  const rgba = new Uint8ClampedArray(pixels * 4);
  const maskBytes = pixels / 8;

  if (data.length === bytesPerPlane + maskBytes) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * (width / 8);
      for (let xb = 0; xb < width / 8; xb++) {
        const b = data[rowStart + xb]!;
        for (let bit = 0; bit < 8; bit++) {
          const x = xb * 8 + bit;
          const idx = (y * width + x) * 4;
          const on = (b & (1 << (7 - bit))) !== 0;
          const v = on ? 0 : 255;
          rgba[idx] = v;
          rgba[idx + 1] = v;
          rgba[idx + 2] = v;
          const mi = (y * width + x) / 8;
          const mb = 7 - ((y * width + x) % 8);
          const m = (data[bytesPerPlane + Math.floor(mi)]! & (1 << mb)) !== 0;
          rgba[idx + 3] = m ? 255 : 0;
        }
      }
    }
    return { typeCode: resType, isColor: false, width, height, pixels: rgba };
  }

  if (data.length === bytesPerPlane) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * (width / 8);
      for (let xb = 0; xb < width / 8; xb++) {
        const b = data[rowStart + xb]!;
        for (let bit = 0; bit < 8; bit++) {
          const x = xb * 8 + bit;
          const idx = (y * width + x) * 4;
          const on = (b & (1 << (7 - bit))) !== 0;
          const v = on ? 0 : 255;
          rgba[idx] = v;
          rgba[idx + 1] = v;
          rgba[idx + 2] = v;
          rgba[idx + 3] = 255;
        }
      }
    }
    return { typeCode: resType, isColor: false, width, height, pixels: rgba };
  }

  if (data.length === bytesPerPlane * 2) {
    const half = bytesPerPlane;
    for (let y = 0; y < height; y++) {
      const rowStart = y * (width / 8);
      for (let xb = 0; xb < width / 8; xb++) {
        const xorb = data[half + rowStart + xb]!;
        for (let bit = 0; bit < 8; bit++) {
          const x = xb * 8 + bit;
          const idx = (y * width + x) * 4;
          const on = (xorb & (1 << (7 - bit))) !== 0;
          const v = on ? 0 : 255;
          rgba[idx] = v;
          rgba[idx + 1] = v;
          rgba[idx + 2] = v;
          rgba[idx + 3] = 255;
        }
      }
    }
    return { typeCode: resType, isColor: false, width, height, pixels: rgba };
  }

  return null;
}

function decode4BitIcon(
  resType: string,
  data: Uint8Array,
  width: number,
  height: number,
  mask: DecodedIcon | null,
): DecodedIcon | null {
  const pixels = width * height;
  const expected = pixels / 2;
  if (data.length < expected) return null;
  const rgba = new Uint8ClampedArray(pixels * 4);
  const maskBytes = pixels / 8;
  const hasMask = data.length >= expected + maskBytes;
  const maskOffset = expected;
  let pix = 0;
  for (let i = 0; i < expected && pix < pixels; i++) {
    const b = data[i]!;
    const hi = (b >> 4) & 0xf;
    const lo = b & 0xf;
    const c1 = clut4ToRgb(hi);
    rgba[pix * 4] = c1[0];
    rgba[pix * 4 + 1] = c1[1];
    rgba[pix * 4 + 2] = c1[2];
    rgba[pix * 4 + 3] = 255;
    if (hasMask) {
      const mi = Math.floor(pix / 8);
      const bit = 7 - (pix % 8);
      const m = (data[maskOffset + mi]! & (1 << bit)) !== 0;
      rgba[pix * 4 + 3] = m ? 255 : 0;
    }
    pix++;
    if (pix >= pixels) break;
    const c2 = clut4ToRgb(lo);
    rgba[pix * 4] = c2[0];
    rgba[pix * 4 + 1] = c2[1];
    rgba[pix * 4 + 2] = c2[2];
    rgba[pix * 4 + 3] = 255;
    if (hasMask) {
      const mi = Math.floor(pix / 8);
      const bit = 7 - (pix % 8);
      const m = (data[maskOffset + mi]! & (1 << bit)) !== 0;
      rgba[pix * 4 + 3] = m ? 255 : 0;
    }
    pix++;
  }
  const icon: DecodedIcon = { typeCode: resType, isColor: true, width, height, pixels: rgba };
  if (!hasMask && mask) return applyMask(icon, mask);
  return icon;
}

function decode8BitIcon(
  resType: string,
  data: Uint8Array,
  width: number,
  height: number,
  mask: DecodedIcon | null,
): DecodedIcon | null {
  const pixels = width * height;
  if (data.length < pixels) return null;
  const rgba = new Uint8ClampedArray(pixels * 4);
  const maskBytes = pixels / 8;
  const hasMask = data.length >= pixels + maskBytes;
  const maskOffset = pixels;
  for (let i = 0; i < pixels; i++) {
    const c = clut8ToRgb(data[i]!);
    rgba[i * 4] = c[0];
    rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2];
    rgba[i * 4 + 3] = 255;
    if (hasMask) {
      const mi = Math.floor(i / 8);
      const bit = 7 - (i % 8);
      const m = (data[maskOffset + mi]! & (1 << bit)) !== 0;
      rgba[i * 4 + 3] = m ? 255 : 0;
    }
  }
  const icon: DecodedIcon = { typeCode: resType, isColor: true, width, height, pixels: rgba };
  if (!hasMask && mask) return applyMask(icon, mask);
  return icon;
}

function getBits(arr: Uint8Array, base: number, bitOffset: number, bits: number): number {
  const byteIndex = base + Math.floor(bitOffset / 8);
  const bitShift = bitOffset % 8;
  let hi = 0;
  if (byteIndex < arr.length) hi = arr[byteIndex]! << 8;
  if (byteIndex + 1 < arr.length) hi |= arr[byteIndex + 1]!;
  const shift = 16 - bitShift - bits;
  return (hi >> shift) & ((1 << bits) - 1);
}

function decodeCicn(resType: string, data: Uint8Array): DecodedIcon | null {
  try {
    const off = { o: 0 };
    const pmap = parsePixMap(data, off);

    off.o += 4; // mask baseAddr
    const maskRowBytes = be16(data, off.o);
    off.o += 2;
    const maskTop = be16s(data, off.o);
    off.o += 2;
    off.o += 2; // maskLeft
    const maskBottom = be16s(data, off.o);
    off.o += 2;
    off.o += 2; // maskRight

    off.o += 4; // bmap baseAddr
    const bmapRowBytes = be16(data, off.o);
    off.o += 2;
    const bmapTop = be16s(data, off.o);
    off.o += 2;
    off.o += 2; // bmapLeft
    const bmapBottom = be16s(data, off.o);
    off.o += 2;
    off.o += 2; // bmapRight
    off.o += 4; // extra zero

    const maskHeight = maskBottom - maskTop;
    const maskLen = maskRowBytes * maskHeight;
    if (off.o + maskLen > data.length) return null;
    const maskBase = off.o;
    off.o += maskLen;

    const bmapHeight = bmapBottom - bmapTop;
    const bmapLen = bmapRowBytes * bmapHeight;
    if (off.o + bmapLen > data.length) return null;
    off.o += bmapLen;

    const ct = parseColorTable(data, off);

    const pmapRowBytesMasked = pmap.rowBytes & 0x7fff;
    const pmapLen = pmapRowBytesMasked * pmap.height;
    if (off.o + pmapLen > data.length) return null;
    const pmapBase = off.o;

    const width = pmap.width;
    const height = pmap.height;
    const rgba = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = y * width + x;
        let colorValue = 0;
        if (pmap.pixelSize === 8) {
          const byteIndex = pmapBase + y * pmapRowBytesMasked + x;
          if (byteIndex >= data.length) return null;
          colorValue = data[byteIndex]!;
        } else {
          const bitsPerRow = pmapRowBytesMasked * 8;
          const bitOffset = y * bitsPerRow + x * pmap.pixelSize;
          colorValue = getBits(data, pmapBase, bitOffset, pmap.pixelSize);
        }

        let rgb = { red: 0, green: 0, blue: 0 };
        let found = false;
        for (const c of ct.colors) {
          if (c.colorIndex === colorValue) {
            rgb = c.color;
            found = true;
            break;
          }
        }
        if (!found && colorValue >= 0 && colorValue < ct.colors.length) {
          rgb = ct.colors[colorValue]!.color;
        }

        rgba[pixelIndex * 4] = rgb.red >> 8;
        rgba[pixelIndex * 4 + 1] = rgb.green >> 8;
        rgba[pixelIndex * 4 + 2] = rgb.blue >> 8;

        const maskBitIndex = y * (maskRowBytes * 8) + x;
        const maskByte = maskBase + Math.floor(maskBitIndex / 8);
        let m = false;
        if (maskByte < data.length) {
          m = (data[maskByte]! & (0x80 >> (maskBitIndex % 8))) !== 0;
        }
        rgba[pixelIndex * 4 + 3] = m ? 255 : 0;
      }
    }

    return { typeCode: resType, isColor: true, width, height, pixels: rgba };
  } catch {
    /* fall through */
  }

  if (data.length >= 1024) return decode8BitIcon(resType, data, 32, 32, null);
  if (data.length >= 512) return decode4BitIcon(resType, data, 32, 32, null);
  if (data.length >= 256) return decode8BitIcon(resType, data, 16, 16, null);
  if (data.length >= 128) return decode4BitIcon(resType, data, 16, 16, null);
  if (data.length >= 64) return decode1BitIcon(resType, data, 16, 16);
  return null;
}

/** AFP Desktop DB iconType → resource type / size heuristic. */
export function decodeDesktopIcon(iconType: number, data: Uint8Array): DecodedIcon | null {
  // Common Desktop Manager icon types (simplified mapping).
  const map: Record<number, string> = {
    1: 'ICN#',
    2: 'ics#',
    0x101: 'icl8',
    0x201: 'ics8',
    0x401: 'icl4',
    0x501: 'ics4',
  };
  const type = map[iconType];
  if (type) return decodeIcon(type, data);
  return decodeIcon('', data);
}

export function decodeICNHash(data: Uint8Array): DecodedIcon | null {
  return decode1BitIcon('ICN#', data, 32, 32);
}

/** Convert decoded RGBA to a PNG data URL via OffscreenCanvas / canvas. */
export async function decodedIconToDataUrl(icon: DecodedIcon): Promise<string | null> {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(icon.width, icon.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const img = new ImageData(icon.pixels, icon.width, icon.height);
      ctx.putImageData(img, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return await blobToDataUrl(blob);
    }
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = icon.width;
      canvas.height = icon.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.putImageData(new ImageData(icon.pixels, icon.width, icon.height), 0, 0);
      return canvas.toDataURL('image/png');
    }
  } catch {
    return null;
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
