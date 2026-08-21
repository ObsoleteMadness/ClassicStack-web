/**
 * Classic Mac OS `vers` resource (VersRec / NumVersion).
 * Finder Get Info uses id 1 for the file's version and copyright strings.
 */

import { be16 } from '../../protocol/binary';
import { decodeMacRoman } from '../../protocol/macroman';
import type { ResourceFork } from '../resource-fork';

export const DEVELOP_STAGE = 0x20;
export const ALPHA_STAGE = 0x40;
export const BETA_STAGE = 0x60;
export const FINAL_STAGE = 0x80;

export interface NumVersion {
  majorRev: number;
  minorAndBugRev: number;
  stage: number;
  nonRelRev: number;
}

export interface VersRec {
  numeric: NumVersion;
  countryCode: number;
  shortVersion: string;
  longVersion: string;
}

export interface VersGetInfo {
  version: string;
  copyright: string;
  product?: string;
  productVersion?: string;
  description?: string;
  company?: string;
}

const COPYRIGHT_RE = /(?:©|\(c\)|copyright)/i;

function bcdByte(n: number): number {
  return ((n >> 4) & 0x0f) * 10 + (n & 0x0f);
}

function readPString(bytes: Uint8Array, o: number): { text: string; next: number } | null {
  if (o >= bytes.length) return null;
  const n = bytes[o]!;
  const start = o + 1;
  const end = start + n;
  if (end > bytes.length) return null;
  return { text: decodeMacRoman(bytes.subarray(start, end)), next: end };
}

/** Format NumVersion the way ResEdit / Finder short strings usually look. */
export function formatNumVersion(v: NumVersion): string {
  const major = bcdByte(v.majorRev);
  const minor = (v.minorAndBugRev >> 4) & 0x0f;
  const bug = v.minorAndBugRev & 0x0f;
  let s = bug ? `${major}.${minor}.${bug}` : `${major}.${minor}`;
  if (v.stage === FINAL_STAGE) {
    if (v.nonRelRev) s += `rev${v.nonRelRev}`;
    return s;
  }
  const letter =
    v.stage === DEVELOP_STAGE ? 'd' : v.stage === ALPHA_STAGE ? 'a' : v.stage === BETA_STAGE ? 'b' : '';
  if (letter) s += `${letter}${v.nonRelRev}`;
  else if (v.nonRelRev) s += `rev${v.nonRelRev}`;
  return s;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** Copyright / notice text from the long version string (CR-separated in ResEdit). */
export function copyrightFromVers(rec: VersRec): string {
  const long = normalizeNewlines(rec.longVersion);
  if (!long) return '';
  const lines = long.split('\n');
  const idx = lines.findIndex((line) => COPYRIGHT_RE.test(line));
  if (idx >= 0) return lines.slice(idx).join('\n').trim();
  if (lines.length > 1) return lines.slice(1).join('\n').trim();
  return long;
}

export function versInfoForGetInfo(rec: VersRec): VersGetInfo {
  const version = rec.shortVersion.trim() || formatNumVersion(rec.numeric);
  let copyright = copyrightFromVers(rec);
  if (copyright && copyright === version) copyright = '';
  if (!copyright && rec.longVersion.trim() && rec.longVersion.trim() !== version) {
    copyright = normalizeNewlines(rec.longVersion);
  }
  return { version, copyright };
}

export function decodeVers(bytes: Uint8Array): VersRec | null {
  if (bytes.length < 8) return null;
  const numeric: NumVersion = {
    majorRev: bytes[0]!,
    minorAndBugRev: bytes[1]!,
    stage: bytes[2]!,
    nonRelRev: bytes[3]!,
  };
  const countryCode = (be16(bytes, 4) << 16) >> 16;
  const short = readPString(bytes, 6);
  if (!short) return null;
  const long = readPString(bytes, short.next);
  return {
    numeric,
    countryCode,
    shortVersion: short.text,
    longVersion: long?.text ?? '',
  };
}

export function decodeVers1(rf: ResourceFork): VersRec | null {
  const entry = rf.findById('vers', 1);
  if (!entry) return null;
  return decodeVers(rf.readBytes(entry));
}
