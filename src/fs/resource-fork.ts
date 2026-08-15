/**
 * Classic Mac OS resource fork reader (port of LibHfs.ResourceForks.ResourceFork).
 */

import { be16, be32 } from '../protocol/binary';
import { decodeMacRoman } from '../protocol/macroman';

export interface ResourceEntry {
  name: string | null;
  type: string;
  id: number;
  length: number;
  attributes: number;
  /** Absolute offset of resource data (after the 4-byte length prefix). */
  dataOffset: number;
  /** Present when the fork was loaded as a sparse icon extract. */
  payload?: Uint8Array;
}

export interface FileHeader {
  dataOffset: number;
  mapOffset: number;
  dataLength: number;
  mapLength: number;
}

export interface ResourceReference {
  id: number;
  nameOffset: number;
  attributes: number;
  dataBlockOffset: number;
}

export interface TypeListEntry {
  typeCode: string;
  numResources: number;
  referenceListOffset: number;
  references: ResourceReference[];
}

export interface ResourceMap {
  fileAttributes: number;
  typeListOffset: number;
  nameListOffset: number;
  typeList: TypeListEntry[];
}

function be16s(b: Uint8Array, o = 0): number {
  return (be16(b, o) << 16) >> 16;
}

function readAscii4(b: Uint8Array, o: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(b[o + i] ?? 0x20);
  return s;
}

export class ResourceFork {
  private readonly bytes: Uint8Array;
  private readonly entries: ResourceEntry[] = [];
  fileHeader: FileHeader | null = null;
  resourceMap: ResourceMap | null = null;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  static fromBytes(bytes: Uint8Array): ResourceFork {
    const rf = new ResourceFork(bytes);
    rf.parse();
    return rf;
  }

  /** Resource fork that only holds the given payloads (no full fork image). */
  static fromEntries(entries: ResourceEntry[]): ResourceFork {
    const rf = new ResourceFork(new Uint8Array());
    rf.entries.push(...entries);
    return rf;
  }

  get Entries(): readonly ResourceEntry[] {
    return this.entries;
  }

  /** Prefer lowercase `entries` in TypeScript call sites. */
  get allEntries(): readonly ResourceEntry[] {
    return this.entries;
  }

  findByType(type: string): ResourceEntry[] {
    return this.entries.filter((e) => e.type === type);
  }

  findById(type: string, id: number): ResourceEntry | undefined {
    return this.entries.find((e) => e.type === type && e.id === id);
  }

  findByIdAny(id: number, types: string[]): ResourceEntry[] {
    const set = new Set(types);
    return this.entries.filter((e) => e.id === id && set.has(e.type));
  }

  findByName(type: string, name: string): ResourceEntry | undefined {
    return this.entries.find((e) => e.type === type && e.name === name);
  }

  readBytes(entry: ResourceEntry): Uint8Array {
    if (entry.payload) return entry.payload.slice();
    const end = entry.dataOffset + entry.length;
    if (entry.dataOffset < 0 || end > this.bytes.length) return new Uint8Array();
    return this.bytes.subarray(entry.dataOffset, end).slice();
  }

  private parse(): void {
    if (this.bytes.length < 16) return;

    const dataOffset = be32(this.bytes, 0);
    const mapOffset = be32(this.bytes, 4);
    const dataLength = be32(this.bytes, 8);
    const mapLength = be32(this.bytes, 12);
    this.fileHeader = { dataOffset, mapOffset, dataLength, mapLength };

    const forkLength = this.bytes.length;
    if (dataLength > forkLength || forkLength - dataLength < dataOffset) return;
    if (mapLength > forkLength || forkLength - mapLength < mapOffset) return;
    if (dataOffset < mapOffset + mapLength && dataOffset + dataLength > mapOffset) return;
    if (mapOffset + mapLength > forkLength) return;

    const mapBuf = this.bytes.subarray(mapOffset, mapOffset + mapLength);
    if (mapBuf.length < 30) return;
    this.resourceMap = readResourceMapHeader(mapBuf);
    if (!this.resourceMap) return;

    for (const mapped of listMappedResources(mapBuf)) {
      const dataEntryPos = dataOffset + mapped.dataBlockOffset;
      if (dataEntryPos < 0 || dataEntryPos + 4 > forkLength) continue;
      const dataLen = be32(this.bytes, dataEntryPos);
      this.entries.push({
        name: mapped.name,
        type: mapped.type,
        id: mapped.id,
        length: dataLen,
        attributes: mapped.attributes,
        dataOffset: dataEntryPos + 4,
      });
    }
  }
}

interface MappedResource {
  type: string;
  id: number;
  attributes: number;
  name: string | null;
  dataBlockOffset: number;
}

function readResourceMapHeader(mapBuf: Uint8Array): ResourceMap | null {
  if (mapBuf.length < 30) return null;
  return {
    fileAttributes: be16(mapBuf, 22),
    typeListOffset: be16(mapBuf, 24),
    nameListOffset: be16(mapBuf, 26),
    typeList: [],
  };
}

function listMappedResources(mapBuf: Uint8Array): MappedResource[] {
  const typeListPos = be16(mapBuf, 24);
  const nameListPos = be16(mapBuf, 26);
  if (typeListPos + 2 > mapBuf.length) return [];
  const numTypes = be16s(mapBuf, typeListPos) + 1;
  const typeEntryBase = typeListPos + 2;
  const out: MappedResource[] = [];

  for (let i = 0; i < numTypes; i++) {
    const entryOff = typeEntryBase + i * 8;
    if (entryOff + 8 > mapBuf.length) break;
    const typeCode = readAscii4(mapBuf, entryOff);
    const numRefs = be16s(mapBuf, entryOff + 4) + 1;
    const ofsRefList = be16(mapBuf, entryOff + 6);
    let rl = typeListPos + ofsRefList;
    for (let j = 0; j < numRefs; j++) {
      if (rl + 12 > mapBuf.length) break;
      const resId = be16s(mapBuf, rl);
      const nameOffset = be16s(mapBuf, rl + 2);
      const attributes = mapBuf[rl + 4]!;
      const dataBlockOffset =
        ((mapBuf[rl + 5]! << 16) | (mapBuf[rl + 6]! << 8) | mapBuf[rl + 7]!) >>> 0;
      let resName: string | null = null;
      if (nameOffset !== -1) {
        let nmPos = nameListPos + nameOffset;
        if (nmPos >= 0 && nmPos < mapBuf.length) {
          const nl = mapBuf[nmPos++]!;
          if (nmPos + nl <= mapBuf.length) {
            resName = decodeMacRoman(mapBuf.subarray(nmPos, nmPos + nl));
          }
        }
      }
      out.push({
        type: typeCode,
        id: resId,
        attributes,
        name: resName,
        dataBlockOffset,
      });
      rl += 12;
    }
  }
  return out;
}

export type ForkByteReader = (offset: number, count: number) => Promise<Uint8Array>;

const MAX_MAP_BYTES = 64 * 1024;
const MAX_RESOURCE_BYTES = 128 * 1024;

/**
 * Read a resource fork through ranged fetches: 16-byte header, the map, then
 * only resources accepted by `want` (icon types/ids). Does not pull the rest
 * of the data fork image.
 */
export async function loadResourceForkPartial(
  read: ForkByteReader,
  want: (type: string, id: number) => boolean,
): Promise<ResourceFork | null> {
  const hdr = await read(0, 16);
  if (hdr.length < 16) return null;
  const dataOffset = be32(hdr, 0);
  const mapOffset = be32(hdr, 4);
  const mapLength = be32(hdr, 12);
  if (mapLength < 30 || mapLength > MAX_MAP_BYTES) return null;
  const mapBuf = await read(mapOffset, mapLength);
  if (mapBuf.length < 30) return null;

  const entries: ResourceEntry[] = [];
  for (const mapped of listMappedResources(mapBuf)) {
    if (!want(mapped.type, mapped.id)) continue;
    const pos = dataOffset + mapped.dataBlockOffset;
    const lenBuf = await read(pos, 4);
    if (lenBuf.length < 4) continue;
    const dataLen = be32(lenBuf, 0);
    if (dataLen <= 0 || dataLen > MAX_RESOURCE_BYTES) continue;
    const payload = await read(pos + 4, dataLen);
    entries.push({
      name: mapped.name,
      type: mapped.type,
      id: mapped.id,
      length: payload.length,
      attributes: mapped.attributes,
      dataOffset: 0,
      payload,
    });
  }
  if (!entries.length) return null;
  const rf = ResourceFork.fromEntries(entries);
  rf.fileHeader = {
    dataOffset,
    mapOffset,
    dataLength: be32(hdr, 8),
    mapLength,
  };
  return rf;
}
