/** BinHex 4.0 decoder (and encoder for tests). */

import { be16, be32, writeBe16, writeBe32 } from '../protocol/binary';
import { crc16BinHex } from '../protocol/crc16';
import { decodeMacRoman, encodeMacRoman } from '../protocol/macroman';
import { makeFinderInfo, ostypeFromBytes, type MacFile } from './mac-file';

const BANNER = 'converted with binhex';
const ALPHABET = '!"#$%&\'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr';
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

const RLE = 0x90;
const LINE = 64;

function binhexCrc(data: Uint8Array): number {
  return crc16BinHex(new Uint8Array([0, 0]), crc16BinHex(data));
}

function isWs(c: number): boolean {
  return c === 0x0d || c === 0x0a || c === 0x09 || c === 0x20;
}

function looksLikeBinHex(data: Uint8Array): boolean {
  const n = Math.min(data.length, 32768);
  let i = 0;
  while (i < n && isWs(data[i]!)) i++;
  if (i < n && data[i] === 0x3a) return true;
  let s = '';
  for (let j = 0; j < n; j++) {
    const c = data[j]!;
    if (c > 127) break;
    s += String.fromCharCode(c);
  }
  return s.toLowerCase().includes('binhex');
}

function findPayload(text: string): string | null {
  const lower = text.toLowerCase();
  const banner = lower.indexOf(BANNER);
  const from = banner >= 0 ? banner : 0;
  const colon = text.indexOf(':', from);
  if (colon < 0) return null;
  const end = text.indexOf(':', colon + 1);
  if (end < 0) return null;
  return text.slice(colon + 1, end);
}

function decode6(payload: string): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    if (c > 127) return null;
    if (isWs(c)) continue;
    const v = DECODE[c]!;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeRle(src: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b !== RLE) {
      out.push(b);
      continue;
    }
    const n = src[++i];
    if (n === undefined) return null;
    if (n === 0) {
      out.push(RLE);
      continue;
    }
    if (out.length === 0) return null;
    const prev = out[out.length - 1]!;
    for (let k = 1; k < n; k++) out.push(prev);
  }
  return Uint8Array.from(out);
}

function encodeRle(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < src.length; ) {
    const b = src[i]!;
    if (b === RLE) {
      out.push(RLE, 0);
      i++;
      continue;
    }
    let n = 1;
    while (i + n < src.length && src[i + n] === b && n < 255) n++;
    if (n >= 3) {
      out.push(b, RLE, n);
      i += n;
    } else {
      out.push(b);
      i++;
    }
  }
  return Uint8Array.from(out);
}

function encode6(src: Uint8Array): string {
  let acc = 0;
  let bits = 0;
  let chars = '';
  const push = (v: number): void => {
    chars += ALPHABET[v]!;
  };
  for (let i = 0; i < src.length; i++) {
    acc = (acc << 8) | src[i]!;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      push((acc >> bits) & 0x3f);
    }
  }
  if (bits > 0) push((acc << (6 - bits)) & 0x3f);
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += LINE) lines.push(chars.slice(i, i + LINE));
  return lines.join('\r');
}

function readFork(raw: Uint8Array, off: number, len: number): { bytes: Uint8Array; next: number } | null {
  if (off + len + 2 > raw.length) return null;
  const bytes = raw.subarray(off, off + len);
  const stored = be16(raw, off + len);
  if (binhexCrc(bytes) !== stored) return null;
  return { bytes: bytes.slice(), next: off + len + 2 };
}

export function parseBinHex(data: Uint8Array): MacFile | null {
  if (data.length < 20 || !looksLikeBinHex(data)) return null;
  let text = '';
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    if (c > 127) {
      if (i < 8) return null;
      break;
    }
    text += String.fromCharCode(c);
  }
  const payload = findPayload(text);
  if (!payload) return null;
  const packed = decode6(payload);
  if (!packed) return null;
  const raw = decodeRle(packed);
  if (!raw || raw.length < 22) return null;

  const nameLen = raw[0]!;
  if (nameLen < 1 || nameLen > 63) return null;
  const nameEnd = 1 + nameLen;
  if (nameEnd + 20 > raw.length) return null;
  const version = raw[nameEnd]!;
  if (version !== 0) return null;

  const headerEnd = nameEnd + 1 + 4 + 4 + 2 + 4 + 4;
  if (headerEnd + 2 > raw.length) return null;
  const header = raw.subarray(0, headerEnd);
  if (binhexCrc(header) !== be16(raw, headerEnd)) return null;

  const typeOff = nameEnd + 1;
  const dataLen = be32(raw, typeOff + 10);
  const rsrcLen = be32(raw, typeOff + 14);
  const dataPart = readFork(raw, headerEnd + 2, dataLen);
  if (!dataPart) return null;
  const rsrcPart = readFork(raw, dataPart.next, rsrcLen);
  if (!rsrcPart) return null;

  const name = decodeMacRoman(raw.subarray(1, nameEnd));
  if (!name || name.includes(':')) return null;

  return {
    name,
    data: dataPart.bytes,
    resource: rsrcPart.bytes,
    finderInfo: makeFinderInfo(
      ostypeFromBytes(raw, typeOff),
      ostypeFromBytes(raw, typeOff + 4),
      be16(raw, typeOff + 8),
    ),
  };
}

export function buildBinHex(file: MacFile): Uint8Array {
  const nameBytes = encodeMacRoman(file.name).subarray(0, 63);
  const header = new Uint8Array(1 + nameBytes.length + 1 + 4 + 4 + 2 + 4 + 4);
  header[0] = nameBytes.length;
  header.set(nameBytes, 1);
  const typeOff = 1 + nameBytes.length + 1;
  header.set(file.finderInfo.subarray(0, 4), typeOff);
  header.set(file.finderInfo.subarray(4, 8), typeOff + 4);
  writeBe16(header, typeOff + 8, be16(file.finderInfo, 8));
  writeBe32(header, typeOff + 10, file.data.length);
  writeBe32(header, typeOff + 14, file.resource.length);

  const parts = [header, crcBytes(binhexCrc(header)), file.data, crcBytes(binhexCrc(file.data)), file.resource, crcBytes(binhexCrc(file.resource))];
  let total = 0;
  for (const p of parts) total += p.length;
  const raw = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    raw.set(p, o);
    o += p.length;
  }

  const body = encode6(encodeRle(raw));
  const text = `(This file must be converted with BinHex 4.0)\r:\r${body}\r:\r`;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function crcBytes(crc: number): Uint8Array {
  const b = new Uint8Array(2);
  writeBe16(b, 0, crc);
  return b;
}
