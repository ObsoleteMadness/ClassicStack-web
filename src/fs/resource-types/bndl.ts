/**
 * BNDL (bundle) resource parser (port of LibHfs.ResourceForks.ResourceTypes.Bndl).
 */

import { be16 } from '../../protocol/binary';
import type { ResourceEntry, ResourceFork } from '../resource-fork';
import { SUPPORTED_ICON_TYPES } from './icon-decoder';
import { IconSet } from './icon-set';

function be16s(b: Uint8Array, o: number): number {
  return (be16(b, o) << 16) >> 16;
}

function readAscii4(b: Uint8Array, o: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(b[o + i] ?? 0x20);
  return s;
}

export interface LocalMapping {
  localId: number;
  resourceId: number;
}

export interface BndlSection {
  code: string;
  mappings: LocalMapping[];
}

export interface Bndl {
  owner: string;
  id: number;
  sections: BndlSection[];
  extractIcons(rf: ResourceFork): Map<number, IconSet>;
  extractTypeToLocalMap(rf: ResourceFork): Map<string, number>;
}

function parseBndlBytes(data: Uint8Array): Bndl | null {
  if (data.length < 8) return null;
  let pos = 0;
  const owner = readAscii4(data, pos);
  pos += 4;
  const id = be16s(data, pos);
  pos += 2;
  const nsecs = be16s(data, pos) + 1;
  pos += 2;

  const sections: BndlSection[] = [];
  for (let i = 0; i < nsecs; i++) {
    if (pos + 6 > data.length) break;
    const code = readAscii4(data, pos);
    pos += 4;
    const nmaps = be16s(data, pos) + 1;
    pos += 2;
    const mappings: LocalMapping[] = [];
    for (let m = 0; m < nmaps; m++) {
      if (pos + 4 > data.length) break;
      const localId = be16s(data, pos);
      pos += 2;
      const resourceId = be16s(data, pos);
      pos += 2;
      mappings.push({ localId, resourceId });
    }
    sections.push({ code, mappings });
  }

  return {
    owner,
    id,
    sections,
    extractIcons(rf: ResourceFork): Map<number, IconSet> {
      const result = new Map<number, IconSet>();
      const supported = new Set<string>(SUPPORTED_ICON_TYPES);
      for (const sect of sections) {
        if (!supported.has(sect.code)) continue;
        for (const mapping of sect.mappings) {
          const icons = IconSet.fromResourceFork(mapping.resourceId, rf);
          if (icons && !result.has(mapping.localId)) {
            result.set(mapping.localId, icons);
          }
        }
      }
      return result;
    },
    extractTypeToLocalMap(rf: ResourceFork): Map<string, number> {
      const map = new Map<string, number>();
      for (const sect of sections) {
        if (sect.code !== 'FREF') continue;
        for (const mapping of sect.mappings) {
          try {
            const e = rf.findById('FREF', mapping.resourceId);
            if (!e) continue;
            const bytes = rf.readBytes(e);
            if (bytes.length < 6) continue;
            const type = readAscii4(bytes, 0);
            const localId = be16s(bytes, 4);
            map.set(type, localId);
          } catch {
            /* ignore */
          }
        }
      }
      return map;
    },
  };
}

export function parseBndlFromEntry(ent: ResourceEntry, rf: ResourceFork): Bndl | null {
  return parseBndlBytes(rf.readBytes(ent));
}

/** Prefer id 128, then any BNDL. */
export function parseBndl(rf: ResourceFork, resourceId = 128): Bndl | null {
  let ent = rf.findById('BNDL', resourceId);
  if (!ent) ent = rf.findByType('BNDL')[0];
  if (!ent) return null;
  return parseBndlFromEntry(ent, rf);
}
