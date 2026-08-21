/**
 * NE (New Executable, 16-bit Windows) resource table.
 */

import { le16, le32 } from '../../protocol/binary';
import type { ByteRangeReader } from '../byte-range';
import { bufferRangeReader } from '../byte-range';
import type { DecodedIcon } from '../resource-types/icon-decoder';
import { assembleIcoFromGroup, decodeIco } from './ico';
import { RT_GROUP_ICON, RT_ICON } from './rt';
import { readExact, readSlice } from './read';

const MZ = 0x5a4d;
const NE_SIG = 0x454e; // 'NE'
const INTEGER_TYPE = 0x8000;
const MAX_ALIGN = 16;
const MAX_RES = 2 * 1024 * 1024;

export function sniffNeAfterMz(header: Uint8Array, neBytes: Uint8Array): boolean {
  if (header.length < 64 || le16(header, 0) !== MZ) return false;
  return neBytes.length >= 2 && le16(neBytes, 0) === NE_SIG;
}

type NeRes = {
  typeId: number | null;
  typeName: string | null;
  id: number | null;
  name: string | null;
  offset: number;
  length: number;
};

function nePascal(table: Uint8Array, off: number): string | null {
  if (off < 0 || off >= table.length) return null;
  const n = table[off]!;
  if (off + 1 + n > table.length) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(table[off + 1 + i]!);
  return s;
}

function parseResourceTable(table: Uint8Array, fileBase: number, alignShift: number): NeRes[] {
  const out: NeRes[] = [];
  let p = 2;
  const unit = 1 << alignShift;
  while (p + 8 <= table.length) {
    const typeRaw = le16(table, p);
    if (typeRaw === 0) break;
    const count = le16(table, p + 2);
    p += 8;
    const typeId = typeRaw & INTEGER_TYPE ? typeRaw & ~INTEGER_TYPE : null;
    const typeName = typeId == null ? nePascal(table, typeRaw) : null;
    for (let i = 0; i < count; i++) {
      if (p + 12 > table.length) return out;
      const offsetUnits = le16(table, p);
      const lengthUnits = le16(table, p + 2);
      const idRaw = le16(table, p + 6);
      p += 12;
      const id = idRaw & INTEGER_TYPE ? idRaw & ~INTEGER_TYPE : null;
      const name = id == null ? nePascal(table, idRaw) : null;
      out.push({
        typeId,
        typeName,
        id,
        name,
        offset: fileBase + offsetUnits * unit,
        length: Math.min(MAX_RES, lengthUnits * unit),
      });
    }
  }
  return out;
}

async function loadNeTable(read: ByteRangeReader): Promise<{ table: Uint8Array; fileOff: number; shift: number } | null> {
  const dos = await readExact(read, 0, 64);
  if (!dos || le16(dos, 0) !== MZ) return null;
  const lfanew = le32(dos, 0x3c);
  if (lfanew < 64 || lfanew > 0x100000) return null;
  const ne = await readExact(read, lfanew, 0x40);
  if (!ne || le16(ne, 0) !== NE_SIG) return null;
  const resOff = le16(ne, 0x24);
  if (resOff < 0x40) return null;
  const tableOff = lfanew + resOff;
  const head = await readExact(read, tableOff, 2);
  if (!head) return null;
  const shift = le16(head, 0);
  if (shift > MAX_ALIGN) return null;
  // Type-info list is small; 64KiB covers any realistic NE resource table.
  const table = await readSlice(read, tableOff, 64 * 1024);
  if (table.length < 4) return null;
  return { table, fileOff: 0, shift };
}

export type NeResourceLeaf = NeRes & { bytes: Uint8Array };

export type NeResourceTable = {
  shift: number;
  leaves: NeResourceLeaf[];
};

/** Every NE resource with payload bytes. */
export async function enumerateNeResources(read: ByteRangeReader): Promise<NeResourceTable | null> {
  const loaded = await loadNeTable(read);
  if (!loaded) return null;
  const entries = parseResourceTable(loaded.table, loaded.fileOff, loaded.shift);
  const leaves: NeResourceLeaf[] = [];
  for (const e of entries) {
    const bytes = await readSlice(read, e.offset, e.length);
    if (!bytes.length) continue;
    leaves.push({ ...e, bytes });
  }
  return { shift: loaded.shift, leaves };
}

/** Extract decoded icons from a 16-bit NE executable. */
export async function extractNeIcons(read: ByteRangeReader): Promise<DecodedIcon[]> {
  const table = await enumerateNeResources(read);
  if (!table) return [];
  const iconBlobs = new Map<number, Uint8Array>();
  const groups: Uint8Array[] = [];
  for (const e of table.leaves) {
    if (e.typeId === RT_ICON && e.id != null) iconBlobs.set(e.id, e.bytes);
    else if (e.typeId === RT_GROUP_ICON) groups.push(e.bytes);
  }
  const icons: DecodedIcon[] = [];
  for (const g of groups) {
    const ico = assembleIcoFromGroup(g, iconBlobs);
    if (!ico) continue;
    icons.push(...(await decodeIco(ico)));
  }
  return icons;
}

export async function extractNeIconsFromBuffer(data: Uint8Array): Promise<DecodedIcon[]> {
  return extractNeIcons(bufferRangeReader(data));
}
