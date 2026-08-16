/**
 * 32-byte FinderInfo: FileInfo+ExtendedFileInfo or FolderInfo+ExtendedFolderInfo.
 * Layout and FinderFlags match Dropbox finderinfo-rust / Carbon Finder.h
 * (https://github.com/dropbox/finderinfo-rust). HFS+ is big-endian.
 *
 * Classic FXInfo/DXInfo overlay the same 16 extended bytes: fdIconID at 16,
 * fdComment/frComment at 26. Carbon Extended*Info uses those as reserved /
 * extendedFinderFlags / putAwayFolderID.
 */

import { be16, be32 } from '../protocol/binary';
import { decodeMacRoman } from '../protocol/macroman';
import type { ResourceFork } from './resource-fork';

/** Unused / reserved in System 7; set to 0. */
export const kIsOnDesk = 0x0001;
/** Three bits of color coding (mask, not a shifted index). */
export const kColor = 0x000e;
/** Undocumented Finder.h bit used to hide the name extension (OS X). */
export const kHideExtension = 0x0010;
/** Application can be executed by multiple users; files only. */
export const kIsShared = 0x0040;
/** File contains no INIT resources; reserved for directories. */
export const kHasNoINITs = 0x0080;
/** Finder recorded bundle info into the desktop database. */
export const kHasBeenInited = 0x0100;
/** File or directory contains a customized icon. */
export const kHasCustomIcon = 0x0400;
/** File is a stationery pad; reserved for directories. */
export const kIsStationery = 0x0800;
/** Name and icon cannot be changed from the Finder. */
export const kNameLocked = 0x1000;
/** File has a BNDL; directory is a file package. */
export const kHasBundle = 0x2000;
/** Invisible in the Finder and Navigation Services. */
export const kIsInvisible = 0x4000;
/** File is an alias; reserved for directories. */
export const kIsAlias = 0x8000;

export const HAS_CUSTOM_ICON = kHasCustomIcon;
export const HAS_BUNDLE = kHasBundle;
export const FINDER_IS_INVISIBLE = kIsInvisible;
export const FINDER_IS_STATIONERY = kIsStationery;
export const FINDER_NAME_LOCKED = kNameLocked;
export const FINDER_COLOR_MASK = kColor;

/** If set, the other extended flags are ignored. */
export const kExtendedFlagsAreInvalid = 0x8000;
export const kExtendedFlagHasCustomBadge = 0x0100;
export const kExtendedFlagHasRoutingInfo = 0x0004;

/** AFP directory/file attribute bits (FPGetFileDirParms), not FinderInfo. */
export const AFP_ATTR_WRITE_INHIBIT = 0x0020;
export const AFP_ATTR_RENAME_INHIBIT = 0x0080;
export const AFP_ATTR_DELETE_INHIBIT = 0x0100;

export interface Point {
  v: number;
  h: number;
}

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface FileInfo {
  fileType: string;
  fileCreator: string;
  finderFlags: number;
  location: Point;
  /** Classic FInfo.fdFldr / Carbon reservedField. */
  reservedField: number;
}

export interface ExtendedFileInfo {
  /** Classic fdIconID is reserved1[0]; Carbon documents these as reserved. */
  reserved1: [number, number, number, number];
  extendedFinderFlags: number;
  /** Classic FXInfo.fdComment; Carbon reserved2. */
  reserved2: number;
  putAwayFolderID: number;
}

export interface FolderInfo {
  windowBounds: Rect;
  finderFlags: number;
  location: Point;
  reservedField: number;
}

export interface ExtendedFolderInfo {
  scrollPosition: Point;
  /** Classic DXInfo.frOpenChain. */
  reserved1: number;
  extendedFinderFlags: number;
  /** Classic DXInfo.frComment; Carbon reserved2. */
  reserved2: number;
  putAwayFolderID: number;
}

export interface FinderInfoFile {
  fileInfo: FileInfo;
  extendedFileInfo: ExtendedFileInfo;
}

export interface FinderInfoFolder {
  folderInfo: FolderInfo;
  extendedFolderInfo: ExtendedFolderInfo;
}

export interface FinderLabel {
  /** Color bits 1–3 as 1…7 (`(flags & kColor) >> 1`). */
  index: number;
  /** Raw `flags & kColor` (0x02…0x0e), as Dropbox LabelColor::from_u8. */
  bits: number;
  name: string;
  color: string;
}

/**
 * OS X Finder label colors (Dropbox LabelColor). Classic System 7 used the
 * same kColor bits with a different Labels-control-panel palette.
 */
export const FINDER_LABELS: readonly FinderLabel[] = [
  { index: 1, bits: 0x02, name: 'Gray', color: '#8e8e93' },
  { index: 2, bits: 0x04, name: 'Green', color: '#34c759' },
  { index: 3, bits: 0x06, name: 'Purple', color: '#af52de' },
  { index: 4, bits: 0x08, name: 'Blue', color: '#007aff' },
  { index: 5, bits: 0x0a, name: 'Yellow', color: '#ffcc00' },
  { index: 6, bits: 0x0c, name: 'Red', color: '#ff3b30' },
  { index: 7, bits: 0x0e, name: 'Orange', color: '#ff9500' },
];

export interface FinderGetInfoDetails {
  locked: boolean;
  readOnly: boolean;
  stationery: boolean;
  nameLocked: boolean;
  label: FinderLabel | null;
  commentId: number;
  customIcon: boolean;
  invisible: boolean;
  alias: boolean;
  shared: boolean;
}

function i16(b: Uint8Array, o: number): number {
  return (be16(b, o) << 16) >> 16;
}

function i32(b: Uint8Array, o: number): number {
  return be32(b, o) | 0;
}

function readAscii4(b: Uint8Array, o: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(b[o + i] ?? 0x20);
  return s;
}

function readPoint(b: Uint8Array, o: number): Point {
  return { v: i16(b, o), h: i16(b, o + 2) };
}

function readRect(b: Uint8Array, o: number): Rect {
  return { top: i16(b, o), left: i16(b, o + 2), bottom: i16(b, o + 4), right: i16(b, o + 6) };
}

/** FinderFlags at offset 8 for both FileInfo and FolderInfo. */
export function finderFlags(finderInfo: Uint8Array): number {
  return be16(finderInfo, 8);
}

export function isFinderInvisible(finderInfo: Uint8Array): boolean {
  return (finderFlags(finderInfo) & kIsInvisible) !== 0;
}

export function parseFileInfo(b: Uint8Array): FileInfo {
  return {
    fileType: readAscii4(b, 0),
    fileCreator: readAscii4(b, 4),
    finderFlags: be16(b, 8),
    location: readPoint(b, 10),
    reservedField: be16(b, 14),
  };
}

export function parseExtendedFileInfo(b: Uint8Array): ExtendedFileInfo {
  return {
    reserved1: [i16(b, 16), i16(b, 18), i16(b, 20), i16(b, 22)],
    extendedFinderFlags: be16(b, 24),
    reserved2: i16(b, 26),
    putAwayFolderID: i32(b, 28),
  };
}

export function parseFinderInfoFile(b: Uint8Array): FinderInfoFile | null {
  if (b.length < 32) return null;
  return { fileInfo: parseFileInfo(b), extendedFileInfo: parseExtendedFileInfo(b) };
}

export function parseFolderInfo(b: Uint8Array): FolderInfo {
  return {
    windowBounds: readRect(b, 0),
    finderFlags: be16(b, 8),
    location: readPoint(b, 10),
    reservedField: be16(b, 14),
  };
}

export function parseExtendedFolderInfo(b: Uint8Array): ExtendedFolderInfo {
  return {
    scrollPosition: readPoint(b, 16),
    reserved1: i32(b, 20),
    extendedFinderFlags: be16(b, 24),
    reserved2: i16(b, 26),
    putAwayFolderID: i32(b, 28),
  };
}

export function parseFinderInfoFolder(b: Uint8Array): FinderInfoFolder | null {
  if (b.length < 32) return null;
  return { folderInfo: parseFolderInfo(b), extendedFolderInfo: parseExtendedFolderInfo(b) };
}

/** Classic FXInfo.fdIconID / first reserved1 word. */
export function finderIconId(finderInfo: Uint8Array): number {
  if (finderInfo.length < 18) return 0;
  return i16(finderInfo, 16);
}

/**
 * Dropbox LabelColor::from_u8: match `flags & kColor` (0x02, 0x04, … 0x0e).
 * Bits 1–3 as an index 1–7 is `(flags & kColor) >> 1`.
 */
export function finderLabel(finderInfo: Uint8Array): FinderLabel | null {
  const bits = finderFlags(finderInfo) & kColor;
  return FINDER_LABELS.find((l) => l.bits === bits) ?? null;
}

export function finderLabelIndex(finderInfo: Uint8Array): number {
  return finderLabel(finderInfo)?.index ?? 0;
}

/** Classic FXInfo.fdComment / DXInfo.frComment (signed 16 at offset 26). */
export function finderCommentId(finderInfo: Uint8Array): number {
  if (finderInfo.length < 28) return 0;
  return i16(finderInfo, 26);
}

export function decodeFcmt(bytes: Uint8Array): string {
  if (bytes.length < 1) return '';
  const n = bytes[0]!;
  const end = Math.min(1 + n, bytes.length);
  return decodeMacRoman(bytes.subarray(1, end)).trim();
}

export function finderCommentFromFork(rf: ResourceFork, finderInfo: Uint8Array): string | null {
  const want = finderCommentId(finderInfo);
  const tryId = (id: number): string | null => {
    const entry = rf.findById('FCMT', id);
    if (!entry) return null;
    const text = decodeFcmt(rf.readBytes(entry));
    return text || null;
  };
  if (want) {
    const hit = tryId(want);
    if (hit) return hit;
    return null;
  }
  return tryId(1);
}

export function finderGetInfoDetails(
  finderInfo: Uint8Array,
  opts?: { attributes?: number; type?: string; isDir?: boolean },
): FinderGetInfoDetails {
  const flags = finderFlags(finderInfo);
  const attr = opts?.attributes ?? 0;
  const type = opts?.isDir ? '' : (opts?.type ?? '').padEnd(4, ' ').slice(0, 4);
  return {
    locked: (attr & AFP_ATTR_WRITE_INHIBIT) !== 0,
    readOnly: type === 'ttro' || (attr & (AFP_ATTR_RENAME_INHIBIT | AFP_ATTR_DELETE_INHIBIT)) !== 0,
    stationery: !opts?.isDir && (flags & kIsStationery) !== 0,
    nameLocked: (flags & kNameLocked) !== 0,
    label: finderLabel(finderInfo),
    commentId: finderCommentId(finderInfo),
    customIcon: (flags & kHasCustomIcon) !== 0,
    invisible: (flags & kIsInvisible) !== 0,
    alias: !opts?.isDir && (flags & kIsAlias) !== 0,
    shared: !opts?.isDir && (flags & kIsShared) !== 0,
  };
}

export function finderFlagLabels(details: FinderGetInfoDetails): string[] {
  const tags: string[] = [];
  if (details.locked) tags.push('Locked');
  if (details.readOnly) tags.push('Read only');
  if (details.stationery) tags.push('Stationery');
  if (details.nameLocked) tags.push('Name locked');
  return tags;
}
