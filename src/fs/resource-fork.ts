/**
 * Classic Mac OS resource fork reader (port of LibHfs.ResourceForks.ResourceFork).
 */

import { be16, be32 } from '../protocol/binary';
import { decodeMacRoman } from '../protocol/macroman';
import { type ByteRangeReader, type RangeFill, SparseBytes } from './byte-range';
import { isCompressedResource, maybeDecompressResource, RES_COMPRESSED } from './resource-compress';
import { parseBndl } from './resource-types/bndl';
import { SUPPORTED_ICON_TYPES } from './resource-types/icon-decoder';
import { CDEV_ICON_ID, CUSTOM_ICON_ID, DEFAULT_ICON_ID } from './resource-types/icon-set';

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
  private readonly store: SparseBytes;
  private readonly entries: ResourceEntry[] = [];
  fileHeader: FileHeader | null = null;
  resourceMap: ResourceMap | null = null;

  constructor(store: SparseBytes) {
    this.store = store;
  }

  static fromBytes(bytes: Uint8Array): ResourceFork {
    const rf = new ResourceFork(SparseBytes.fromBuffer(bytes));
    rf.parse();
    return rf;
  }

  /**
   * Header + map through the virtual fork image. With `want`, also faults in
   * those payloads. Other resources populate on `pullBytes`.
   */
  static async fromReader(
    read: ByteRangeReader,
    want?: (type: string, id: number) => boolean,
  ): Promise<ResourceFork | null> {
    const store = new SparseBytes(read);
    const map = await readForkMap(store.asReader());
    if (!map) return null;
    if (want) {
      const entries = await loadMappedPayloads(store.asReader(), map.dataOffset, map.mapped, want);
      return forkFromSparse(map, entries, store);
    }
    return forkFromMap(map, entriesFromMap(map), store);
  }

  /** Resource fork that only holds the given payloads (no full fork image). */
  static fromEntries(entries: ResourceEntry[]): ResourceFork {
    const rf = new ResourceFork(new SparseBytes());
    rf.entries.push(...entries);
    return rf;
  }

  /**
   * Later misses reopen a catalog reader. Drop the live inner reader unless it
   * still points at a buffer that outlives the original session (local VFS).
   */
  bindFill(fill: RangeFill, keepInner = false): void {
    if (!keepInner) this.store.bindInner(null);
    this.store.bindFill(fill);
  }

  static hydrate(store: SparseBytes, entries: ResourceEntry[], header: FileHeader): ResourceFork {
    const rf = new ResourceFork(store);
    rf.entries.push(...entries);
    rf.fileHeader = header;
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
    if (entry.length < 0) return new Uint8Array();
    const raw = this.store.peek(entry.dataOffset, entry.length)?.slice() ?? new Uint8Array();
    return this.cacheDecoded(entry, raw);
  }

  /** True when this entry’s data is already in the sparse image or a payload. */
  hasPayload(entry: ResourceEntry): boolean {
    if (entry.payload !== undefined) return true;
    if (entry.length < 0) return false;
    return this.store.has(entry.dataOffset, entry.length);
  }

  /**
   * Fault this resource at `dataOffset` (length prefix + payload). Unknown
   * lengths probe 512 payload bytes first so a large FETCH_CAP is not a 2MB read.
   */
  async pullBytes(entry: ResourceEntry, maxBytes?: number): Promise<Uint8Array> {
    const cap = maxBytes ?? resourceFetchCap(entry.type);
    if (this.hasPayload(entry)) {
      const have = this.readBytes(entry);
      return have.length > cap ? have.subarray(0, cap) : have;
    }
    if (entry.dataOffset < 0) return new Uint8Array();
    if (entry.length >= 0) {
      const raw = await this.store.slice(
        entry.dataOffset,
        compressedFetchSize(entry.attributes, entry.length, cap),
      );
      const full = await this.ensureCompressed(entry, raw);
      const decoded = this.cacheDecoded(entry, full, true);
      return decoded.length > cap ? decoded.subarray(0, cap) : decoded;
    }
    const got = await this.readPrefixed(entry.dataOffset, entry.attributes, cap, true);
    if (!got) return new Uint8Array();
    entry.length = got.dataLen;
    entry.dataOffset += 4;
    const decoded = this.cacheDecoded(entry, got.payload, true);
    return decoded.length > cap ? decoded.subarray(0, cap) : decoded;
  }

  private cacheDecoded(entry: ResourceEntry, raw: Uint8Array, cacheAlways = false): Uint8Array {
    const decoded = maybeDecompressResource(raw, entry.attributes);
    if (decoded !== raw) {
      entry.payload = decoded;
      entry.length = decoded.length;
      return decoded.slice();
    }
    if (cacheAlways) entry.payload = decoded;
    return decoded;
  }

  private async ensureCompressed(entry: ResourceEntry, raw: Uint8Array): Promise<Uint8Array> {
    if (entry.length < 0 || raw.length >= entry.length) return raw;
    if (!needsFullCompressed(raw, entry.attributes, entry.length)) return raw;
    if (entry.length > MAX_RESOURCE_BYTES) return raw;
    return this.store.slice(entry.dataOffset, entry.length);
  }

  private async readPrefixed(
    prefixPos: number,
    attributes: number,
    cap: number,
    probeFirst = false,
  ): Promise<{ dataLen: number; payload: Uint8Array } | null> {
    return readPrefixedPayload(this.store.asReader(), prefixPos, attributes, cap, probeFirst);
  }

  private parse(): void {
    const hdr = this.store.peek(0, 16);
    if (!hdr || hdr.length < 16) return;

    const dataOffset = be32(hdr, 0);
    const mapOffset = be32(hdr, 4);
    const dataLength = be32(hdr, 8);
    const mapLength = be32(hdr, 12);
    this.fileHeader = { dataOffset, mapOffset, dataLength, mapLength };

    const forkLength = this.store.length;
    if (dataLength > forkLength || forkLength - dataLength < dataOffset) return;
    if (mapLength > forkLength || forkLength - mapLength < mapOffset) return;
    if (dataOffset < mapOffset + mapLength && dataOffset + dataLength > mapOffset) return;
    if (mapOffset + mapLength > forkLength) return;

    const mapBuf = this.store.peek(mapOffset, mapLength);
    if (!mapBuf || mapBuf.length < 30) return;
    this.resourceMap = readResourceMapHeader(mapBuf);
    if (!this.resourceMap) return;

    for (const mapped of listMappedResources(mapBuf)) {
      const dataEntryPos = dataOffset + mapped.dataBlockOffset;
      if (dataEntryPos < 0 || dataEntryPos + 4 > forkLength) continue;
      const lenBuf = this.store.peek(dataEntryPos, 4);
      if (!lenBuf || lenBuf.length < 4) continue;
      const dataLen = be32(lenBuf, 0);
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

export type ForkByteReader = ByteRangeReader;

const MAX_MAP_BYTES = 64 * 1024;
const MAX_RESOURCE_BYTES = 128 * 1024;

const ICON_TYPE_SET = new Set<string>(SUPPORTED_ICON_TYPES);

/**
 * 8-bit color first, then 1-bit families (image + mask). icl8/ics8 have no
 * alpha of their own; ICN# / ics# supply the Finder transparency mask.
 */
const ICON_FETCH_ORDER = [
  'icl8',
  'ics8',
  'ICN#',
  'ics#',
  'icl4',
  'ics4',
  'cicn',
  'ICON',
  'icm8',
  'icm4',
  'icm#',
  'ich8',
  'ich4',
  'ich#',
];

/** Typical on-disk sizes; skip map entries that claim a huge payload. */
const PAYLOAD_MAX: Record<string, number> = {
  BNDL: 8 * 1024,
  FREF: 256,
  'ICN#': 256,
  ICON: 128,
  'ics#': 64,
  'icm#': 48,
  'ich#': 576,
  icl8: 1024,
  ics8: 256,
  icm8: 192,
  ich8: 2304,
  icl4: 512,
  ics4: 128,
  icm4: 96,
  ich4: 1152,
  cicn: 32 * 1024,
  PICT: 2 * 1024 * 1024,
};

/**
 * First-range size when the map has no length: prefix + this many payload bytes.
 * Avoids requesting FETCH_CAP (2MB for PICT) for a 200-byte resource.
 * BNDL stays small so a 256-byte probe does not swallow the next resource.
 */
const PREFIX_PROBE = 512;
const PREFIX_FIRST: Record<string, number> = {
  BNDL: 256,
  FREF: 64,
};

/** Upper bound for a full payload pull (after the length prefix is known). */
const FETCH_CAP: Record<string, number> = {
  BNDL: 8 * 1024,
  FREF: 64,
  'ICN#': 256,
  ICON: 128,
  'ics#': 64,
  'icm#': 48,
  'ich#': 576,
  icl8: 1024,
  ics8: 256,
  icm8: 192,
  ich8: 2304,
  icl4: 512,
  ics4: 128,
  icm4: 96,
  ich4: 1152,
  cicn: 32 * 1024,
  PICT: 2 * 1024 * 1024,
};

export function resourceFetchCap(type: string): number {
  return FETCH_CAP[type] ?? PAYLOAD_MAX[type] ?? 512;
}

export interface FinderIconForkOpts {
  /** Resource ids to fetch in addition to BNDL-mapped Finder icons. */
  extraIds?: number[];
  /** Icon\\r files: pull every icon type in the map (those forks are small). */
  includeAllIcons?: boolean;
}

/** Options for Catalog.loadResourceFork (ranged header/map/payload reads). */
export type ResourceForkLoadOpts = {
  fork?: 'resource' | 'data';
  want?: (type: string, id: number) => boolean;
  finderIcons?: boolean;
  signal?: AbortSignal;
};

interface ForkMap {
  dataOffset: number;
  mapOffset: number;
  mapLength: number;
  dataLength: number;
  mapped: MappedResource[];
}

async function readForkMap(read: ForkByteReader): Promise<ForkMap | null> {
  const hdr = await read(0, 16);
  if (hdr.length < 16) return null;
  const dataOffset = be32(hdr, 0);
  const mapOffset = be32(hdr, 4);
  const dataLength = be32(hdr, 8);
  const mapLength = be32(hdr, 12);
  if (mapLength < 30 || mapLength > MAX_MAP_BYTES) return null;
  const mapBuf = await read(mapOffset, mapLength);
  if (mapBuf.length < 30) return null;
  return {
    dataOffset,
    mapOffset,
    mapLength,
    dataLength,
    mapped: listMappedResources(mapBuf),
  };
}

/** Map listing only: `length` is -1 and `dataOffset` points at the 4-byte prefix. */
function entriesFromMap(map: ForkMap): ResourceEntry[] {
  return map.mapped.map((item) => ({
    name: item.name,
    type: item.type,
    id: item.id,
    length: -1,
    attributes: item.attributes,
    dataOffset: map.dataOffset + item.dataBlockOffset,
  }));
}

function compressedFetchSize(attributes: number, onDisk: number, cap: number): number {
  if (attributes & RES_COMPRESSED) return Math.min(onDisk, MAX_RESOURCE_BYTES);
  return Math.min(onDisk, cap);
}

function needsFullCompressed(raw: Uint8Array, attributes: number, dataLen: number): boolean {
  if (dataLen <= 0 || raw.length >= dataLen) return false;
  return isCompressedResource(raw, attributes);
}

/** One range: 4-byte length prefix plus up to `cap` payload bytes. */
async function readPrefixedBlock(
  read: ForkByteReader,
  prefixPos: number,
  cap: number,
): Promise<{ dataLen: number; payload: Uint8Array } | null> {
  const block = await read(prefixPos, 4 + Math.max(0, cap));
  if (block.length < 4) return null;
  const dataLen = be32(block, 0);
  if (dataLen <= 0) return { dataLen, payload: new Uint8Array() };
  const n = Math.min(dataLen, cap, block.length - 4);
  return { dataLen, payload: n > 0 ? block.subarray(4, 4 + n) : new Uint8Array() };
}

/**
 * Probe PREFIX_PROBE (when `probeFirst`), then fetch only min(on-disk length, cap)
 * at this resource’s map offset. Shared by pullBytes and Finder icon extracts.
 */
async function readPrefixedPayload(
  read: ForkByteReader,
  prefixPos: number,
  attributes: number,
  cap: number,
  probeFirst = true,
): Promise<{ dataLen: number; payload: Uint8Array } | null> {
  const first = probeFirst ? Math.min(cap, PREFIX_PROBE) : cap;
  let got = await readPrefixedBlock(read, prefixPos, first);
  if (!got) return null;
  const need = compressedFetchSize(attributes, got.dataLen, cap);
  if (got.payload.length < need) {
    got = (await readPrefixedBlock(read, prefixPos, need)) ?? got;
  }
  if (
    needsFullCompressed(got.payload, attributes, got.dataLen) &&
    got.dataLen <= MAX_RESOURCE_BYTES &&
    got.payload.length < got.dataLen
  ) {
    got = (await readPrefixedBlock(read, prefixPos, got.dataLen)) ?? got;
  }
  return got;
}

async function loadOneMapped(
  read: ForkByteReader,
  dataOffset: number,
  item: MappedResource,
): Promise<ResourceEntry | null> {
  const pos = dataOffset + item.dataBlockOffset;
  const maxKeep = PAYLOAD_MAX[item.type] ?? MAX_RESOURCE_BYTES;
  const cap = Math.min(resourceFetchCap(item.type), maxKeep);
  const first = PREFIX_FIRST[item.type] ?? PREFIX_PROBE;
  const probed = await readPrefixedBlock(read, pos, Math.min(cap, first));
  if (!probed || probed.dataLen <= 0) return null;
  if (probed.dataLen > maxKeep) {
    return {
      name: item.name,
      type: item.type,
      id: item.id,
      length: probed.dataLen,
      attributes: item.attributes,
      dataOffset: pos + 4,
    };
  }
  const need = compressedFetchSize(item.attributes, probed.dataLen, cap);
  const got =
    probed.payload.length >= need
      ? probed
      : ((await readPrefixedPayload(read, pos, item.attributes, cap)) ?? probed);
  const decoded = maybeDecompressResource(got.payload, item.attributes);
  return {
    name: item.name,
    type: item.type,
    id: item.id,
    length: decoded.length,
    attributes: item.attributes,
    dataOffset: pos + 4,
    payload: decoded,
  };
}

async function loadMappedPayloads(
  read: ForkByteReader,
  dataOffset: number,
  mapped: MappedResource[],
  want: (type: string, id: number) => boolean,
): Promise<ResourceEntry[]> {
  const entries: ResourceEntry[] = [];
  for (const item of mapped) {
    if (!want(item.type, item.id)) continue;
    const entry = await loadOneMapped(read, dataOffset, item);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function loadPreferredIconPayloads(
  read: ForkByteReader,
  dataOffset: number,
  mapped: MappedResource[],
  ids: Set<number>,
  includeAll: boolean,
): Promise<ResourceEntry[]> {
  const byTypeId = new Map<string, MappedResource>();
  const familyIds = new Set<number>();
  for (const item of mapped) {
    if (!ICON_TYPE_SET.has(item.type)) continue;
    if (!includeAll && !ids.has(item.id)) continue;
    familyIds.add(item.id);
    byTypeId.set(`${item.type}:${item.id}`, item);
  }
  const extraTypes = [...ICON_TYPE_SET].filter((t) => !ICON_FETCH_ORDER.includes(t));
  const order = [...ICON_FETCH_ORDER, ...extraTypes];
  const entries: ResourceEntry[] = [];
  for (const id of familyIds) {
    let haveIcl8 = false;
    let haveIcs8 = false;
    let haveIcm8 = false;
    let haveIch8 = false;
    for (const type of order) {
      if (
        !includeAll &&
        ((type === 'icl4' && haveIcl8) ||
          (type === 'ics4' && haveIcs8) ||
          (type === 'icm4' && haveIcm8) ||
          (type === 'ich4' && haveIch8))
      ) {
        continue;
      }
      const item = byTypeId.get(`${type}:${id}`);
      if (!item) continue;
      const entry = await loadOneMapped(read, dataOffset, item);
      if (!entry) continue;
      entries.push(entry);
      if (!entry.payload) continue;
      if (type === 'icl8') haveIcl8 = true;
      if (type === 'ics8') haveIcs8 = true;
      if (type === 'icm8') haveIcm8 = true;
      if (type === 'ich8') haveIch8 = true;
    }
  }
  return entries;
}

function forkFromMap(map: ForkMap, entries: ResourceEntry[], store = new SparseBytes()): ResourceFork {
  return ResourceFork.hydrate(store, entries, {
    dataOffset: map.dataOffset,
    mapOffset: map.mapOffset,
    dataLength: map.dataLength,
    mapLength: map.mapLength,
  });
}

function forkFromSparse(map: ForkMap, entries: ResourceEntry[], store?: SparseBytes): ResourceFork | null {
  if (!entries.length) return null;
  return forkFromMap(map, entries, store);
}

/**
 * Read a resource fork through ranged fetches: 16-byte header, the map, then
 * only resources accepted by `want` (icon types/ids). Does not pull the rest
 * of the fork image.
 */
export async function loadResourceForkPartial(
  read: ForkByteReader,
  want: (type: string, id: number) => boolean,
): Promise<ResourceFork | null> {
  return ResourceFork.fromReader(read, want);
}

/**
 * Header + map, then BNDL/FREF (to learn Finder icon ids), then those
 * icon families plus every FREF local id. Skips CODE and other unmapped ICN#.
 */
export async function loadFinderIconFork(
  read: ForkByteReader,
  opts?: FinderIconForkOpts,
): Promise<ResourceFork | null> {
  const store = new SparseBytes(read);
  const virt = store.asReader();
  const map = await readForkMap(virt);
  if (!map) return null;

  const extraIds = new Set<number>(opts?.extraIds ?? []);
  const meta = await loadMappedPayloads(
    virt,
    map.dataOffset,
    map.mapped,
    (type) => type === 'BNDL' || type === 'FREF',
  );
  const ids = new Set<number>(extraIds);
  const metaFork = ResourceFork.fromEntries(meta);
  const bndl = parseBndl(metaFork);
  if (bndl) {
    for (const sect of bndl.sections) {
      if (!ICON_TYPE_SET.has(sect.code)) continue;
      for (const mapping of sect.mappings) ids.add(mapping.resourceId);
    }
    for (const localId of bndl.extractTypeToLocalMap(metaFork).values()) {
      ids.add(localId);
    }
  }
  if (!ids.size) {
    ids.add(DEFAULT_ICON_ID);
    ids.add(CDEV_ICON_ID);
    ids.add(CUSTOM_ICON_ID);
  }

  const icons = await loadPreferredIconPayloads(
    virt,
    map.dataOffset,
    map.mapped,
    ids,
    opts?.includeAllIcons === true,
  );
  return forkFromSparse(map, [...meta, ...icons], store);
}
