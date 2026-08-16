/** Summaries and small decoders for the Resource Fork explorer. */

import { be16 } from '../protocol/binary';
import { decodeMacRoman } from '../protocol/macroman';
import { parseBndlFromEntry, type Bndl } from './resource-types/bndl';
import { SUPPORTED_ICON_TYPES } from './resource-types/icon-decoder';
import { CDEV_ICON_ID, CUSTOM_ICON_ID, DEFAULT_ICON_ID } from './resource-types/icon-set';
import { ResourceFork, type FileHeader, type ResourceEntry } from './resource-fork';

export interface ResourceTypeGroup {
  type: string;
  count: number;
  bytes: number;
  entries: ResourceEntry[];
}

export interface FrefInfo {
  type: string;
  localId: number;
  name: string;
}

export interface BndlMappingView {
  code: string;
  localId: number;
  resourceId: number;
  present: boolean;
}

export interface BndlView {
  owner: string;
  ownerId: number;
  mappings: BndlMappingView[];
}

export interface ForkInspect {
  header: FileHeader | null;
  forkBytes: number;
  entries: readonly ResourceEntry[];
  types: ResourceTypeGroup[];
  /** True when the map yielded at least one resource. */
  parsed: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  'ICN#': 'Large 1-bit icon',
  ICON: '32×32 icon',
  'ics#': 'Small 1-bit icon',
  icl8: 'Large 8-bit icon',
  ics8: 'Small 8-bit icon',
  icl4: 'Large 4-bit icon',
  ics4: 'Small 4-bit icon',
  cicn: 'Color icon',
  icns: 'Icon family',
  BNDL: 'Bundle',
  FREF: 'File reference',
  cdev: 'Control panel code',
  INIT: 'System extension',
  CODE: 'Code',
  DATA: 'Data',
  'STR ': 'String',
  'STR#': 'String list',
  DITL: 'Dialog items',
  DLOG: 'Dialog',
  ALRT: 'Alert',
  MENU: 'Menu',
  CNTL: 'Control',
  PICT: 'Picture',
  snd: 'Sound',
  vers: 'Version',
  SIZE: 'Size',
  TEXT: 'Text',
  hwin: 'Windoid',
  nrct: 'Rectangle list',
  RECT: 'Rectangle',
};

const ICON_DEBUG_ORDER = [
  'BNDL',
  'FREF',
  'ICN#',
  'icl8',
  'ics#',
  'ics8',
  'cicn',
  'ICON',
  'icns',
  'icl4',
  'ics4',
];

export const ICON_RELATED_TYPES = new Set<string>([...SUPPORTED_ICON_TYPES, 'BNDL', 'FREF', 'icns']);

function be16s(b: Uint8Array, o: number): number {
  return (be16(b, o) << 16) >> 16;
}

function readAscii4(b: Uint8Array, o: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(b[o + i] ?? 0x20);
  return s;
}

/** Quote a 4-byte OSType, showing spaces. */
export function formatOsType(type: string): string {
  const t = (type ?? '').padEnd(4, ' ').slice(0, 4);
  return `'${t.replace(/ /g, ' ')}'`;
}

export function resourceTypeLabel(type: string): string | undefined {
  return TYPE_LABELS[type] ?? TYPE_LABELS[type.trimEnd()];
}

export function resourceIdHint(type: string, id: number): string | undefined {
  if (id === CDEV_ICON_ID) return 'cdev icon / bundle';
  if (id === CUSTOM_ICON_ID) return 'custom icon';
  if (id === DEFAULT_ICON_ID && ICON_RELATED_TYPES.has(type)) return 'default icon / bundle';
  return undefined;
}

export function groupResourceTypes(entries: readonly ResourceEntry[]): ResourceTypeGroup[] {
  const map = new Map<string, ResourceEntry[]>();
  for (const e of entries) {
    const list = map.get(e.type) ?? [];
    list.push(e);
    map.set(e.type, list);
  }
  return [...map.entries()]
    .map(([type, ents]) => ({
      type,
      count: ents.length,
      bytes: ents.reduce((n, e) => n + e.length, 0),
      entries: [...ents].sort((a, b) => a.id - b.id || (a.name ?? '').localeCompare(b.name ?? '')),
    }))
    .sort((a, b) => {
      const ai = ICON_RELATED_TYPES.has(a.type) ? 0 : 1;
      const bi = ICON_RELATED_TYPES.has(b.type) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return a.type.localeCompare(b.type);
    });
}

/** Prefer BNDL / icon family types so missing Finder icons are obvious. */
export function preferredInspectType(types: readonly string[]): string | null {
  for (const t of ICON_DEBUG_ORDER) {
    if (types.includes(t)) return t;
  }
  return types[0] ?? null;
}

export function inspectResourceFork(bytes: Uint8Array): ForkInspect {
  if (bytes.length < 16) {
    return { header: null, forkBytes: bytes.length, entries: [], types: [], parsed: false };
  }
  return inspectLoadedFork(ResourceFork.fromBytes(bytes), bytes.length);
}

export function inspectLoadedFork(rf: ResourceFork, forkBytes: number): ForkInspect {
  const entries = rf.allEntries;
  return {
    header: rf.fileHeader,
    forkBytes,
    entries,
    types: groupResourceTypes(entries),
    parsed: entries.length > 0,
  };
}

export function decodeFref(bytes: Uint8Array): FrefInfo | null {
  if (bytes.length < 6) return null;
  const type = readAscii4(bytes, 0);
  const localId = be16s(bytes, 4);
  let name = '';
  if (bytes.length > 6) {
    const n = bytes[6]!;
    if (n && 7 + n <= bytes.length) name = decodeMacRoman(bytes.subarray(7, 7 + n));
  }
  return { type, localId, name };
}

export function describeBndl(rf: ResourceFork, entry: ResourceEntry): BndlView | null {
  const bndl: Bndl | null = parseBndlFromEntry(entry, rf);
  if (!bndl) return null;
  const mappings: BndlMappingView[] = [];
  for (const sect of bndl.sections) {
    for (const m of sect.mappings) {
      mappings.push({
        code: sect.code,
        localId: m.localId,
        resourceId: m.resourceId,
        present: rf.findById(sect.code, m.resourceId) != null,
      });
    }
  }
  return { owner: bndl.owner, ownerId: bndl.id, mappings };
}

export function hexDump(bytes: Uint8Array, maxBytes = 512): { text: string; truncated: boolean } {
  const n = Math.min(bytes.length, maxBytes);
  const lines: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const slice = bytes.subarray(i, Math.min(i + 16, n));
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0'));
    while (hex.length < 16) hex.push('  ');
    const ascii = Array.from(slice, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(
      `${i.toString(16).padStart(4, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`,
    );
  }
  return { text: lines.join('\n'), truncated: bytes.length > maxBytes };
}

/**
 * Pick bytes to parse: the resource fork, or the data fork when it itself is a
 * resource map (resource-only files copied without AppleDouble).
 */
export function forkBytesFromNode(node: {
  resource: Uint8Array;
  data: Uint8Array;
}): { bytes: Uint8Array; source: 'resource' | 'data' | 'empty' } {
  if (node.resource.length >= 16) {
    const rf = ResourceFork.fromBytes(node.resource);
    if (rf.allEntries.length > 0 || rf.fileHeader) {
      return { bytes: node.resource, source: 'resource' };
    }
  }
  if (node.data.length >= 16) {
    const rf = ResourceFork.fromBytes(node.data);
    if (rf.allEntries.length > 0) return { bytes: node.data, source: 'data' };
  }
  if (node.resource.length > 0) return { bytes: node.resource, source: 'resource' };
  return { bytes: new Uint8Array(), source: 'empty' };
}
