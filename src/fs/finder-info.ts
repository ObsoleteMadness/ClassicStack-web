/**
 * Classic FinderInfo (FInfo/FXInfo and DInfo/DXInfo) for Get Info.
 * Flag bits match Files.h; AFP attribute bits match AFP 2.1 file/dir parms.
 */

import { be16 } from '../protocol/binary';
import { decodeMacRoman } from '../protocol/macroman';
import { finderFlags } from './icon-cache';
import type { ResourceFork } from './resource-fork';

export const FINDER_IS_STATIONERY = 0x0800;
export const FINDER_NAME_LOCKED = 0x1000;
export const FINDER_COLOR_MASK = 0x000e;

/** AFP directory/file attribute bits (FPGetFileDirParms). */
export const AFP_ATTR_WRITE_INHIBIT = 0x0020;
export const AFP_ATTR_RENAME_INHIBIT = 0x0080;
export const AFP_ATTR_DELETE_INHIBIT = 0x0100;

export interface FinderLabel {
  index: number;
  name: string;
  color: string;
}

/** System 7 Labels control panel names, index 1–7 from fdFlags color bits. */
export const FINDER_LABELS: readonly FinderLabel[] = [
  { index: 1, name: 'Essential', color: '#f5a623' },
  { index: 2, name: 'Hot', color: '#e23c3c' },
  { index: 3, name: 'In Progress', color: '#d45aa0' },
  { index: 4, name: 'Cool', color: '#3cb4c8' },
  { index: 5, name: 'Personal', color: '#7a6ad6' },
  { index: 6, name: 'Project 1', color: '#3d8b40' },
  { index: 7, name: 'Project 2', color: '#8a8a8a' },
];

export interface FinderGetInfoDetails {
  locked: boolean;
  readOnly: boolean;
  stationery: boolean;
  nameLocked: boolean;
  label: FinderLabel | null;
  commentId: number;
}

export function finderLabelIndex(finderInfo: Uint8Array): number {
  return (finderFlags(finderInfo) & FINDER_COLOR_MASK) >> 1;
}

export function finderLabel(finderInfo: Uint8Array): FinderLabel | null {
  const n = finderLabelIndex(finderInfo);
  if (n < 1 || n > 7) return null;
  return FINDER_LABELS[n - 1] ?? null;
}

/** FXInfo/DXInfo comment ID (Desktop FCMT), signed 16-bit at offset 26. */
export function finderCommentId(finderInfo: Uint8Array): number {
  if (finderInfo.length < 28) return 0;
  return (be16(finderInfo, 26) << 16) >> 16;
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
  opts?: { attributes?: number; type?: string },
): FinderGetInfoDetails {
  const flags = finderFlags(finderInfo);
  const attr = opts?.attributes ?? 0;
  const type = (opts?.type ?? '').padEnd(4, ' ').slice(0, 4);
  const locked = (attr & AFP_ATTR_WRITE_INHIBIT) !== 0;
  const readOnly =
    type === 'ttro' || (attr & (AFP_ATTR_RENAME_INHIBIT | AFP_ATTR_DELETE_INHIBIT)) !== 0;
  return {
    locked,
    readOnly,
    stationery: (flags & FINDER_IS_STATIONERY) !== 0,
    nameLocked: (flags & FINDER_NAME_LOCKED) !== 0,
    label: finderLabel(finderInfo),
    commentId: finderCommentId(finderInfo),
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
