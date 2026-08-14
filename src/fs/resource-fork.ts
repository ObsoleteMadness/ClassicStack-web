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

    const fileAttributes = be16(mapBuf, 22);
    const typeListOffset = be16(mapBuf, 24);
    const nameListOffset = be16(mapBuf, 26);
    this.resourceMap = {
      fileAttributes,
      typeListOffset,
      nameListOffset,
      typeList: [],
    };

    const typeListPos = typeListOffset;
    const nameListPos = nameListOffset;
    if (typeListPos + 2 > mapBuf.length) return;

    const numTypes = be16s(mapBuf, typeListPos) + 1;
    const typeEntries: TypeListEntry[] = [];
    const typeEntryBase = typeListPos + 2;

    for (let i = 0; i < numTypes; i++) {
      const entryOff = typeEntryBase + i * 8;
      if (entryOff + 8 > mapBuf.length) break;
      const typeCode = readAscii4(mapBuf, entryOff);
      const numRefs = be16s(mapBuf, entryOff + 4) + 1;
      const ofsRefList = be16(mapBuf, entryOff + 6);
      const tle: TypeListEntry = {
        typeCode,
        numResources: numRefs,
        referenceListOffset: ofsRefList,
        references: [],
      };
      typeEntries.push(tle);
      this.resourceMap.typeList.push(tle);
    }

    for (const tle of typeEntries) {
      let rl = typeListPos + tle.referenceListOffset;
      for (let j = 0; j < tle.numResources; j++) {
        if (rl + 12 > mapBuf.length) break;
        const resId = be16s(mapBuf, rl);
        const nameOffset = be16s(mapBuf, rl + 2);
        const attributes = mapBuf[rl + 4]!;
        const dataBlockOffset =
          ((mapBuf[rl + 5]! << 16) | (mapBuf[rl + 6]! << 8) | mapBuf[rl + 7]!) >>> 0;
        tle.references.push({
          id: resId,
          nameOffset,
          attributes,
          dataBlockOffset,
        });
        rl += 12;
      }
    }

    for (const tle of typeEntries) {
      for (const reference of tle.references) {
        let resName: string | null = null;
        if (reference.nameOffset !== -1) {
          let nmPos = nameListPos + reference.nameOffset;
          if (nmPos >= 0 && nmPos < mapBuf.length) {
            const nl = mapBuf[nmPos++]!;
            if (nmPos + nl <= mapBuf.length) {
              resName = decodeMacRoman(mapBuf.subarray(nmPos, nmPos + nl));
            }
          }
        }

        const dataEntryPos = dataOffset + reference.dataBlockOffset;
        if (dataEntryPos < 0 || dataEntryPos + 4 > forkLength) continue;
        const dataLen = be32(this.bytes, dataEntryPos);
        this.entries.push({
          name: resName,
          type: tle.typeCode,
          id: reference.id,
          length: dataLen,
          attributes: reference.attributes,
          dataOffset: dataEntryPos + 4,
        });
      }
    }
  }
}
