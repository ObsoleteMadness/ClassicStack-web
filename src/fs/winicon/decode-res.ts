import { le16, le32 } from '../../protocol/binary';
import type { DecodedIcon } from '../resource-types/icon-decoder';
import { decodeIcoDib } from './bmp';
import { assembleIcoFromGroup, decodeIco, wrapSingleIcoImage } from './ico';
import {
  RT_BITMAP,
  RT_CURSOR,
  RT_GROUP_CURSOR,
  RT_GROUP_ICON,
  RT_HTML,
  RT_ICON,
  RT_MANIFEST,
  RT_RCDATA,
  RT_STRING,
  RT_VERSION,
} from './rt';

export type WinResPreview =
  | { kind: 'icon'; icons: DecodedIcon[] }
  | { kind: 'bitmap'; icon: DecodedIcon }
  | { kind: 'version'; fields: { key: string; value: string }[] }
  | { kind: 'strings'; lines: { index: number; text: string }[] }
  | { kind: 'text'; text: string; encoding: string }
  | { kind: 'hex' };

function u16le(b: Uint8Array, o: number): number {
  return o + 2 <= b.length ? le16(b, o) : 0;
}

function readUtf16z(b: Uint8Array, o: number): { s: string; next: number } {
  let s = '';
  let p = o;
  while (p + 1 < b.length) {
    const c = le16(b, p);
    p += 2;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return { s, next: p };
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

function formatVersionQuad(ms: number, ls: number): string {
  return `${(ms >>> 16) & 0xffff}.${ms & 0xffff}.${(ls >>> 16) & 0xffff}.${ls & 0xffff}`;
}

/** VS_VERSION_INFO tree (StringFileInfo / VarFileInfo). */
export function decodeVersionInfo(bytes: Uint8Array): { key: string; value: string }[] {
  const map = new Map<string, string>();
  if (bytes.length < 6) return [];

  const put = (key: string, value: string) => {
    const v = value.trim();
    if (key && v) map.set(key, v);
  };

  const walk = (off: number, end: number, depth: number): void => {
    if (depth > 12 || off + 6 > end) return;
    const wLength = u16le(bytes, off);
    const wValueLength = u16le(bytes, off + 2);
    const wType = u16le(bytes, off + 4);
    if (wLength < 6 || off + wLength > bytes.length) return;
    const { s: key, next } = readUtf16z(bytes, off + 6);
    let p = align4(next);
    const nodeEnd = Math.min(off + wLength, end);

    if (wValueLength > 0 && p < nodeEnd) {
      if (wType === 1) {
        const { s } = readUtf16z(bytes, p);
        put(key, s);
        p = align4(p + wValueLength * 2);
      } else if (key === 'VS_VERSION_INFO' && wValueLength >= 52 && p + 52 <= bytes.length) {
        put('FileVersion', formatVersionQuad(le32(bytes, p + 8), le32(bytes, p + 12)));
        put('ProductVersion', formatVersionQuad(le32(bytes, p + 16), le32(bytes, p + 20)));
        p = align4(p + wValueLength);
      } else {
        p = align4(p + wValueLength);
      }
    }
    while (p + 6 <= nodeEnd) {
      const childLen = u16le(bytes, p);
      if (childLen < 6) break;
      walk(p, Math.min(p + childLen, nodeEnd), depth + 1);
      p = align4(p + childLen);
    }
  };

  walk(0, bytes.length, 0);
  return [...map].map(([key, value]) => ({ key, value }));
}

/** RT_STRING: 16 Pascal UTF-16 strings per block. */
export function decodeStringTable(bytes: Uint8Array, blockId: number): { index: number; text: string }[] {
  const lines: { index: number; text: string }[] = [];
  let p = 0;
  for (let i = 0; i < 16 && p + 2 <= bytes.length; i++) {
    const n = le16(bytes, p);
    p += 2;
    let text = '';
    for (let j = 0; j < n && p + 1 < bytes.length; j++) {
      text += String.fromCharCode(le16(bytes, p));
      p += 2;
    }
    if (text) lines.push({ index: (blockId - 1) * 16 + i, text });
  }
  return lines;
}

function looksUtf16Le(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return true;
  if (b.length < 8) return false;
  let zeros = 0;
  for (let i = 1; i < Math.min(64, b.length); i += 2) if (b[i] === 0) zeros++;
  return zeros >= 8;
}

function decodeTextish(bytes: Uint8Array): { text: string; encoding: string } | null {
  if (!bytes.length) return null;
  if (looksUtf16Le(bytes)) {
    const start = bytes[0] === 0xff && bytes[1] === 0xfe ? 2 : 0;
    const n = Math.min(32_000, Math.floor((bytes.length - start) / 2));
    let text = '';
    for (let i = 0; i < n; i++) text += String.fromCharCode(le16(bytes, start + i * 2));
    return { text, encoding: 'UTF-16LE' };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64_000));
    const printable = text.replace(/[\t\n\r]/g, '');
    let bad = 0;
    for (let i = 0; i < Math.min(printable.length, 400); i++) {
      const c = printable.charCodeAt(i);
      if (c < 32 && c !== 9) bad++;
    }
    if (bad > 8) return null;
    return { text, encoding: 'UTF-8' };
  } catch {
    return null;
  }
}

export async function previewWinResource(opts: {
  typeId: number | null;
  id: number | null;
  bytes: Uint8Array;
  iconBlobs: Map<number, Uint8Array>;
  cursorBlobs: Map<number, Uint8Array>;
}): Promise<WinResPreview> {
  const { typeId, id, bytes, iconBlobs, cursorBlobs } = opts;
  if (typeId === RT_GROUP_ICON) {
    const ico = assembleIcoFromGroup(bytes, iconBlobs);
    if (ico) {
      const icons = await decodeIco(ico);
      if (icons.length) return { kind: 'icon', icons };
    }
  }
  if (typeId === RT_GROUP_CURSOR) {
    const ico = assembleIcoFromGroup(bytes, cursorBlobs);
    if (ico) {
      const icons = await decodeIco(ico);
      if (icons.length) return { kind: 'icon', icons };
    }
  }
  if (typeId === RT_ICON) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      const icons = await decodeIco(wrapSingleIcoImage(bytes));
      if (icons.length) return { kind: 'icon', icons };
    }
    const dib = decodeIcoDib(bytes, 'ICO');
    if (dib) return { kind: 'icon', icons: [dib] };
  }
  if (typeId === RT_CURSOR) {
    const dib = decodeIcoDib(bytes.length >= 4 ? bytes.subarray(4) : bytes, 'CUR');
    if (dib) return { kind: 'icon', icons: [dib] };
  }
  if (typeId === RT_BITMAP) {
    const bmp = decodeIcoDib(bytes, 'BMP', { icon: false });
    if (bmp) return { kind: 'bitmap', icon: bmp };
  }
  if (typeId === RT_VERSION) {
    const fields = decodeVersionInfo(bytes);
    if (fields.length) return { kind: 'version', fields };
  }
  if (typeId === RT_STRING && id != null) {
    const lines = decodeStringTable(bytes, id);
    if (lines.length) return { kind: 'strings', lines };
  }
  if (typeId === RT_MANIFEST || typeId === RT_HTML || typeId === RT_RCDATA) {
    const t = decodeTextish(bytes);
    if (t) return { kind: 'text', ...t };
  }
  const t = decodeTextish(bytes);
  if (t && t.text.length > 8 && !t.text.includes('\0')) return { kind: 'text', ...t };
  return { kind: 'hex' };
}
