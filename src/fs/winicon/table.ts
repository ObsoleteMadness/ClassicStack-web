/**
 * Grouped PE / NE / ICO resource table for the Windows resource explorer.
 */

import { le16, le32 } from '../../protocol/binary';
import type { ByteRangeReader } from '../byte-range';
import { enumerateIcoFrames } from './ico';
import { enumerateNeResources, type NeResourceLeaf } from './ne';
import { enumeratePeResources, type PeResourceLeaf } from './pe';
import { readExact } from './read';
import {
  RT_BITMAP,
  RT_CURSOR,
  RT_GROUP_CURSOR,
  RT_GROUP_ICON,
  RT_ICON,
  RT_ICON_TYPES,
  RT_MANIFEST,
  RT_STRING,
  RT_VERSION,
  rtTypeCode,
  rtTypeKey,
  rtTypeLabel,
} from './rt';
import { sniffWinIcon } from './extract';

const NE_SIG = 0x454e;

const TYPE_ORDER = [
  RT_VERSION,
  RT_GROUP_ICON,
  RT_MANIFEST,
  RT_ICON,
  RT_BITMAP,
  RT_STRING,
  RT_GROUP_CURSOR,
];

const MACHINE: Record<number, string> = {
  0x14c: 'i386',
  0x8664: 'amd64',
  0x1c0: 'ARM',
  0xaa64: 'ARM64',
  0x1c4: 'ARMv7',
  0x200: 'IA64',
};

export type WinResKind = 'pe' | 'ne' | 'ico' | 'cur';

export type WinResEntry = {
  typeKey: string;
  typeId: number | null;
  typeName: string | null;
  id: number | null;
  name: string | null;
  language: number;
  length: number;
  bytes: Uint8Array;
};

export type WinResTypeGroup = {
  key: string;
  typeId: number | null;
  typeName: string | null;
  label: string;
  code: string;
  count: number;
  icon: boolean;
  entries: WinResEntry[];
};

export type WinResInspect = {
  kind: WinResKind | null;
  magic?: string;
  machine?: number;
  machineName?: string;
  shift?: number;
  types: WinResTypeGroup[];
  entries: WinResEntry[];
};

function emptyInspect(): WinResInspect {
  return { kind: null, types: [], entries: [] };
}

function typeRank(id: number | null): number {
  if (id == null) return 2000;
  const i = TYPE_ORDER.indexOf(id);
  return i >= 0 ? i : 1000 + id;
}

function sortGroups(groups: WinResTypeGroup[]): WinResTypeGroup[] {
  return [...groups].sort((a, b) => {
    const d = typeRank(a.typeId) - typeRank(b.typeId);
    if (d) return d;
    return a.label.localeCompare(b.label);
  });
}

function groupEntries(entries: WinResEntry[]): WinResTypeGroup[] {
  const map = new Map<string, WinResTypeGroup>();
  for (const e of entries) {
    let g = map.get(e.typeKey);
    if (!g) {
      g = {
        key: e.typeKey,
        typeId: e.typeId,
        typeName: e.typeName,
        label: rtTypeLabel(e.typeId, e.typeName),
        code: rtTypeCode(e.typeId, e.typeName),
        count: 0,
        icon: e.typeId != null && RT_ICON_TYPES.has(e.typeId),
        entries: [],
      };
      map.set(e.typeKey, g);
    }
    g.entries.push(e);
    g.count = g.entries.length;
  }
  return sortGroups([...map.values()]);
}

function fromPeLeaves(leaves: PeResourceLeaf[], magic: string, machine: number): WinResInspect {
  const entries: WinResEntry[] = leaves.map((leaf) => ({
    typeKey: rtTypeKey(leaf.typeId, leaf.typeName),
    typeId: leaf.typeId,
    typeName: leaf.typeName,
    id: leaf.id,
    name: leaf.name,
    language: leaf.language,
    length: leaf.bytes.length,
    bytes: leaf.bytes,
  }));
  return {
    kind: 'pe',
    magic,
    machine,
    machineName: MACHINE[machine] ?? `0x${machine.toString(16)}`,
    types: groupEntries(entries),
    entries,
  };
}

function fromNeLeaves(leaves: NeResourceLeaf[], shift: number): WinResInspect {
  const entries: WinResEntry[] = leaves.map((leaf) => ({
    typeKey: rtTypeKey(leaf.typeId, leaf.typeName),
    typeId: leaf.typeId,
    typeName: leaf.typeName,
    id: leaf.id,
    name: leaf.name,
    language: 0,
    length: leaf.bytes.length,
    bytes: leaf.bytes,
  }));
  return { kind: 'ne', magic: 'NE', shift, types: groupEntries(entries), entries };
}

/** First type to show: version / icon group when present. */
export function preferredWinType(types: WinResTypeGroup[]): string | null {
  if (!types.length) return null;
  return sortGroups(types)[0]?.key ?? null;
}

/** Parse PE, NE, or standalone ICO/CUR into grouped resource types. */
export async function inspectWinResources(read: ByteRangeReader): Promise<WinResInspect> {
  const header = await readExact(read, 0, 64);
  if (!header) return emptyInspect();
  const kind = sniffWinIcon(header);
  if (kind === 'ico') {
    const listed = await enumerateIcoFrames(read);
    if (!listed) return emptyInspect();
    const typeId = listed.kind === 'cur' ? RT_CURSOR : RT_ICON;
    const typeKey = rtTypeKey(typeId, null);
    const entries: WinResEntry[] = listed.frames.map((f) => ({
      typeKey,
      typeId,
      typeName: null,
      id: f.index + 1,
      name: `${f.width}×${f.height}`,
      language: 0,
      length: f.bytes.length,
      bytes: f.bytes,
    }));
    return {
      kind: listed.kind,
      magic: listed.kind.toUpperCase(),
      types: groupEntries(entries),
      entries,
    };
  }
  if (kind === 'ne') {
    const lfanew = le32(header, 0x3c);
    const ne = await readExact(read, lfanew, 2);
    if (ne && le16(ne, 0) === NE_SIG) {
      const table = await enumerateNeResources(read);
      if (!table) return emptyInspect();
      return fromNeLeaves(table.leaves, table.shift);
    }
  }
  if (kind === 'pe' || kind === 'ne') {
    const lfanew = header.length >= 64 ? le32(header, 0x3c) : 0;
    if (lfanew) {
      const sig = await readExact(read, lfanew, 2);
      if (sig && le16(sig, 0) === NE_SIG) {
        const table = await enumerateNeResources(read);
        if (!table) return emptyInspect();
        return fromNeLeaves(table.leaves, table.shift);
      }
    }
    const table = await enumeratePeResources(read);
    if (!table) return emptyInspect();
    return fromPeLeaves(table.leaves, table.magic, table.machine);
  }
  return emptyInspect();
}
