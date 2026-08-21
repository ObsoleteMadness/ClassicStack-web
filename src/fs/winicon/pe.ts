/**
 * PE (Portable Executable) resource directory.
 * Reads only the COFF headers and .rsrc section (range-friendly).
 */

import { le16, le32 } from '../../protocol/binary';
import type { ByteRangeReader } from '../byte-range';
import { bufferRangeReader } from '../byte-range';
import type { DecodedIcon } from '../resource-types/icon-decoder';
import { assembleIcoFromGroup, decodeIco, wrapSingleIcoImage } from './ico';
import { decodeIcoDib } from './bmp';
import { readExact, readSlice } from './read';
import { RT_GROUP_ICON, RT_ICON } from './rt';

export { RT_GROUP_ICON, RT_ICON } from './rt';

const MZ = 0x5a4d;
const PE_MAGIC32 = 0x10b;
const PE_MAGIC64 = 0x20b;
const MAX_SECTIONS = 96;
const MAX_RSRC = 8 * 1024 * 1024;
const DIR_HIGH = 0x80000000;

type Section = { va: number; vs: number; raw: number; rawSize: number };

function rvaToOff(sections: Section[], rva: number): number | null {
  for (const s of sections) {
    const span = Math.max(s.vs, s.rawSize);
    if (rva >= s.va && rva < s.va + span) return s.raw + (rva - s.va);
  }
  return null;
}

export function sniffPe(header: Uint8Array): boolean {
  if (header.length < 64) return false;
  if (le16(header, 0) !== MZ) return false;
  const lfanew = le32(header, 0x3c);
  if (lfanew < 64 || lfanew > 0x100000) return false;
  return true;
}

type ResData = { rva: number; size: number };

class ResDir {
  constructor(
    readonly named: { nameRva: number; child: number; isDir: boolean }[],
    readonly ids: { id: number; child: number; isDir: boolean }[],
  ) {}
}

function parseDir(buf: Uint8Array, off: number): ResDir | null {
  if (off + 16 > buf.length) return null;
  const nNamed = le16(buf, off + 12);
  const nId = le16(buf, off + 14);
  const total = nNamed + nId;
  if (total > 4096 || off + 16 + total * 8 > buf.length) return null;
  const named: ResDir['named'] = [];
  const ids: ResDir['ids'] = [];
  let p = off + 16;
  for (let i = 0; i < nNamed; i++, p += 8) {
    const name = le32(buf, p);
    const child = le32(buf, p + 4);
    named.push({ nameRva: name & ~DIR_HIGH, child: child & ~DIR_HIGH, isDir: (child & DIR_HIGH) !== 0 });
  }
  for (let i = 0; i < nId; i++, p += 8) {
    const id = le32(buf, p);
    const child = le32(buf, p + 4);
    ids.push({ id, child: child & ~DIR_HIGH, isDir: (child & DIR_HIGH) !== 0 });
  }
  return new ResDir(named, ids);
}

function parseData(buf: Uint8Array, off: number): ResData | null {
  if (off + 16 > buf.length) return null;
  return { rva: le32(buf, off), size: le32(buf, off + 4) };
}

type Seg = { id: number | null; name: string | null };
type LeafPath = { path: Seg[]; data: ResData };

function readUName(buf: Uint8Array, off: number): string | null {
  if (off + 2 > buf.length) return null;
  const n = le16(buf, off);
  if (n > 256 || off + 2 + n * 2 > buf.length) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(le16(buf, off + 2 + i * 2));
  return s;
}

function collectLeaves(buf: Uint8Array, dirOff: number, depth: number, out: LeafPath[], path: Seg[]): void {
  if (depth > 4) return;
  const dir = parseDir(buf, dirOff);
  if (!dir) return;
  const walk = (seg: Seg, child: number, isDir: boolean) => {
    const next = [...path, seg];
    if (isDir) collectLeaves(buf, child, depth + 1, out, next);
    else {
      const data = parseData(buf, child);
      if (data) out.push({ path: next, data });
    }
  };
  for (const e of dir.ids) walk({ id: e.id, name: null }, e.child, e.isDir);
  for (const e of dir.named) walk({ id: null, name: readUName(buf, e.nameRva) }, e.child, e.isDir);
}

async function loadHeaders(read: ByteRangeReader): Promise<{
  sections: Section[];
  resRva: number;
  resSize: number;
  machine: number;
  magic: 'pe32' | 'pe32+';
} | null> {
  const dos = await readExact(read, 0, 64);
  if (!dos || le16(dos, 0) !== MZ) return null;
  const lfanew = le32(dos, 0x3c);
  const sigCoff = await readExact(read, lfanew, 24);
  if (!sigCoff) return null;
  if (le32(sigCoff, 0) !== 0x4550) return null;
  const machine = le16(sigCoff, 4);
  const nSections = le16(sigCoff, 6);
  const optSize = le16(sigCoff, 20);
  if (nSections === 0 || nSections > MAX_SECTIONS || optSize < 96) return null;
  const opt = await readExact(read, lfanew + 24, optSize);
  if (!opt) return null;
  const magicRaw = le16(opt, 0);
  if (magicRaw !== PE_MAGIC32 && magicRaw !== PE_MAGIC64) return null;
  const magic = magicRaw === PE_MAGIC64 ? 'pe32+' : 'pe32';
  const ddOff = magic === 'pe32+' ? 112 : 96;
  if (ddOff + 24 > opt.length) return null;
  const nRva = le32(opt, magic === 'pe32+' ? 108 : 92);
  if (nRva < 3) return null;
  const resRva = le32(opt, ddOff + 16);
  const resSize = le32(opt, ddOff + 20);
  if (!resRva || !resSize || resSize > MAX_RSRC) return null;

  const secOff = lfanew + 24 + optSize;
  const secBuf = await readExact(read, secOff, nSections * 40);
  if (!secBuf) return null;
  const sections: Section[] = [];
  for (let i = 0; i < nSections; i++) {
    const o = i * 40;
    sections.push({
      vs: le32(secBuf, o + 8),
      va: le32(secBuf, o + 12),
      rawSize: le32(secBuf, o + 16),
      raw: le32(secBuf, o + 20),
    });
  }
  return { sections, resRva, resSize, machine, magic };
}

function sliceRva(rsrc: Uint8Array, resRva: number, rva: number, size: number): Uint8Array | null {
  const local = rva - resRva;
  if (local < 0 || local + size > rsrc.length) return null;
  return rsrc.subarray(local, local + size);
}

export type PeResourceLeaf = {
  typeId: number | null;
  typeName: string | null;
  id: number | null;
  name: string | null;
  language: number;
  bytes: Uint8Array;
};

export type PeResourceTable = {
  magic: 'pe32' | 'pe32+';
  machine: number;
  resRva: number;
  resSize: number;
  leaves: PeResourceLeaf[];
};

/** Every PE resource leaf (type / name / language) with payload bytes. */
export async function enumeratePeResources(read: ByteRangeReader): Promise<PeResourceTable | null> {
  const hdr = await loadHeaders(read);
  if (!hdr) return null;
  const fileOff = rvaToOff(hdr.sections, hdr.resRva);
  if (fileOff == null) return null;
  const rsrc = await readSlice(read, fileOff, hdr.resSize);
  if (rsrc.length < 16) return null;
  const raw: LeafPath[] = [];
  collectLeaves(rsrc, 0, 0, raw, []);
  const leaves: PeResourceLeaf[] = [];
  for (const leaf of raw) {
    const type = leaf.path[0];
    const name = leaf.path[1];
    const lang = leaf.path[2];
    const bytes = sliceRva(rsrc, hdr.resRva, leaf.data.rva, leaf.data.size);
    if (!bytes) continue;
    leaves.push({
      typeId: type?.id ?? null,
      typeName: type?.name ?? null,
      id: name?.id ?? null,
      name: name?.name ?? null,
      language: lang?.id ?? 0,
      bytes,
    });
  }
  return { magic: hdr.magic, machine: hdr.machine, resRva: hdr.resRva, resSize: hdr.resSize, leaves };
}

/** Extract decoded icons from a PE image. */
export async function extractPeIcons(read: ByteRangeReader): Promise<DecodedIcon[]> {
  const table = await enumeratePeResources(read);
  if (!table) return [];

  const iconBlobs = new Map<number, Uint8Array>();
  const groups: Uint8Array[] = [];
  for (const leaf of table.leaves) {
    if (leaf.typeId === RT_ICON && leaf.id != null) iconBlobs.set(leaf.id, leaf.bytes);
    else if (leaf.typeId === RT_GROUP_ICON) groups.push(leaf.bytes);
  }

  const icons: DecodedIcon[] = [];
  for (const g of groups) {
    const ico = assembleIcoFromGroup(g, iconBlobs);
    if (!ico) continue;
    icons.push(...(await decodeIco(ico)));
  }
  if (icons.length) return icons;

  for (const e of iconBlobs.values()) {
    if (e.length >= 8 && e[0] === 0x89 && e[1] === 0x50) {
      icons.push(...(await decodeIco(wrapSingleIcoImage(e))));
      continue;
    }
    const dib = decodeIcoDib(e);
    if (dib) icons.push(dib);
  }
  return icons;
}

export async function extractPeIconsFromBuffer(data: Uint8Array): Promise<DecodedIcon[]> {
  return extractPeIcons(bufferRangeReader(data));
}
