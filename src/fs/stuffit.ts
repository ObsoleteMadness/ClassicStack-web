/** StuffIt 1.x (`SIT!`) and StuffIt 5 parsers. Layout and CRC match The Unarchiver (XADStuffItParser / XADStuffIt5Parser). */

import { be16, be32, writeBe16, writeBe32 } from '../protocol/binary';
import { crc16Ibm } from '../protocol/crc16';
import { decodeMacRoman, encodeMacRoman } from '../protocol/macroman';
import { decompressClassic, decompressSit5, SitError } from './stuffit-codec';
import { ostypeFromBytes } from './mac-file';
import type { ByteRangeReader } from './byte-range';

export type SitFormat = 'classic' | 'sit5';

export type SitEntry = {
  name: string;
  data: Uint8Array;
  resource: Uint8Array;
  fileType: string;
  creator: string;
  isFolder: boolean;
  finderFlags: number;
  createDate: number;
  modDate: number;
};

/** StuffIt catalog row: metadata and packed-fork offsets, without decompressed data. */
export type SitPackedMember = {
  name: string;
  isFolder: boolean;
  fileType: string;
  creator: string;
  finderFlags: number;
  createDate: number;
  modDate: number;
  format: SitFormat;
  dataOffset: number;
  dataClen: number;
  dataUlen: number;
  dataMeth: number;
  dataCrc: number;
  rsrcOffset: number;
  rsrcClen: number;
  rsrcUlen: number;
  rsrcMeth: number;
  rsrcCrc: number;
};

const SIT_ENTRY = 112;
const START_FOLDER = 0x20;
const END_FOLDER = 0x21;
function headerMagic(data: Uint8Array): string {
  return ostypeFromBytes(data, 0);
}

function hasRLau(data: Uint8Array): boolean {
  return data.length >= 14 && ostypeFromBytes(data, 10) === 'rLau';
}

/** Unarchiver XADStuffItParser: SIT! or installer STdd / STin / STi0–9 with rLau. */
function isClassicMagic(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  if (headerMagic(data) === 'SIT!') return true;
  if (data[0] !== 0x53 || data[1] !== 0x54) return false;
  const c2 = data[2]!;
  const c3 = data[3]!;
  if (c2 === 0x69) return c3 === 0x6e || (c3 >= 0x30 && c3 <= 0x39);
  return c2 >= 0x30 && c2 <= 0x39 && c3 >= 0x30 && c3 <= 0x39;
}

function sitxSignature(data: Uint8Array): string | null {
  if (data.length < 8) return null;
  const sig = String.fromCharCode(...data.subarray(0, 8));
  if (sig === 'StuffIt!' || sig === 'StuffIt?') return sig;
  return null;
}

function readName(bytes: Uint8Array): string {
  return decodeMacRoman(bytes).replace(/\0+$/, '');
}

function isClassic(data: Uint8Array): boolean {
  return hasRLau(data) && isClassicMagic(data);
}

/**
 * Unarchiver XADStuffIt5Parser: 100-byte header whose first 80 bytes match
 * `StuffIt (c)1997-XXXX Aladdin Systems, Inc., http://www.aladdinsys.com/StuffIt/\r\n`
 * (year digits are wildcards). A leading `StuffIt` is not enough — Expander
 * documents such as “Expander Reg. Form” start that way and are not archives.
 */
const SIT5_BANNER_PREFIX = 'StuffIt (c)1997-';
const SIT5_BANNER_SUFFIX = ' Aladdin Systems, Inc., http://www.aladdinsys.com/StuffIt/\r\n';

function isSit5(data: Uint8Array): boolean {
  if (data.length < 100) return false;
  for (let i = 0; i < SIT5_BANNER_PREFIX.length; i++) {
    if (data[i] !== SIT5_BANNER_PREFIX.charCodeAt(i)) return false;
  }
  const suffixAt = SIT5_BANNER_PREFIX.length + 4;
  for (let i = 0; i < SIT5_BANNER_SUFFIX.length; i++) {
    if (data[suffixAt + i] !== SIT5_BANNER_SUFFIX.charCodeAt(i)) return false;
  }
  return true;
}

export function isStuffItArchive(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  if (sitxSignature(data) || headerMagic(data) === 'SITD') return true;
  if (data.length >= 22 && (isClassic(data) || isSit5(data))) return true;
  return headerMagic(data) === 'SIT!';
}

function decompressFork(
  format: SitFormat,
  packed: Uint8Array,
  method: number,
  uncompLen: number,
): Uint8Array {
  if (uncompLen === 0) return new Uint8Array();
  return format === 'sit5'
    ? decompressSit5(packed, method, uncompLen)
    : decompressClassic(packed, method, uncompLen);
}

/** IBM CRC-16 of uncompressed fork data. Method 15 (Arsenic) stores CRC-32 in-band instead. */
/** IBM CRC-16 of uncompressed stored forks. Compressed methods skip this until codecs match Unarchiver byte-for-byte. */
function requireForkCrc(bytes: Uint8Array, stored: number, method: number): void {
  if ((method & 0x0f) !== 0 || stored === 0) return;
  if (crc16Ibm(bytes) !== stored) {
    throw new SitError('This archive appears to be corrupted.', 'corrupt');
  }
}

/** StuffIt 5 entry header CRC: IBM CRC-16 of `headerSize` bytes with the CRC field cleared. */
function sit5HeaderCrc(header: Uint8Array): number {
  const cleared = new Uint8Array(header);
  if (cleared.length >= 34) {
    cleared[32] = 0;
    cleared[33] = 0;
  }
  return crc16Ibm(cleared);
}

const CORRUPT = () => new SitError('This archive appears to be corrupted.', 'corrupt');

async function readExact(read: ByteRangeReader, offset: number, count: number): Promise<Uint8Array> {
  if (count <= 0) return new Uint8Array();
  const buf = await read(offset, count);
  if (buf.length < count) throw CORRUPT();
  return buf.length === count ? buf : buf.subarray(0, count);
}

type ClassicHeader = {
  name: string;
  rsrcFolder: number;
  dataFolder: number;
  rsrcMeth: number;
  dataMeth: number;
  fileType: string;
  creator: string;
  finderFlags: number;
  createDate: number;
  modDate: number;
  rsrcUlen: number;
  dataUlen: number;
  rsrcClen: number;
  dataClen: number;
  rsrcCrc: number;
  dataCrc: number;
};

function decodeClassicHeader(header: Uint8Array): ClassicHeader {
  if (crc16Ibm(header.subarray(0, 110)) !== be16(header, 110)) throw CORRUPT();
  const rsrcMethod = header[0]!;
  const dataMethod = header[1]!;
  const nameLen = Math.min(header[2]!, 31);
  return {
    name: readName(header.subarray(3, 3 + nameLen)),
    rsrcFolder: rsrcMethod & ~0x90,
    dataFolder: dataMethod & ~0x90,
    rsrcMeth: rsrcMethod & 0x0f,
    dataMeth: dataMethod & 0x0f,
    fileType: ostypeFromBytes(header, 66),
    creator: ostypeFromBytes(header, 70),
    finderFlags: be16(header, 74),
    createDate: be32(header, 76),
    modDate: be32(header, 80),
    rsrcUlen: be32(header, 84),
    dataUlen: be32(header, 88),
    rsrcClen: be32(header, 92),
    dataClen: be32(header, 96),
    rsrcCrc: be16(header, 100),
    dataCrc: be16(header, 102),
  };
}

function packedFolder(
  format: SitFormat,
  name: string,
  fileType: string,
  creator: string,
  finderFlags: number,
  createDate: number,
  modDate: number,
): SitPackedMember {
  return {
    name,
    isFolder: true,
    fileType,
    creator,
    finderFlags,
    createDate,
    modDate,
    format,
    dataOffset: 0,
    dataClen: 0,
    dataUlen: 0,
    dataMeth: 0,
    dataCrc: 0,
    rsrcOffset: 0,
    rsrcClen: 0,
    rsrcUlen: 0,
    rsrcMeth: 0,
    rsrcCrc: 0,
  };
}

function memberFromClassic(full: string, h: ClassicHeader, rsrcOffset: number, dataOffset: number): SitPackedMember {
  return {
    name: full,
    isFolder: false,
    fileType: h.fileType,
    creator: h.creator,
    finderFlags: h.finderFlags,
    createDate: h.createDate,
    modDate: h.modDate,
    format: 'classic',
    dataOffset,
    dataClen: h.dataClen,
    dataUlen: h.dataUlen,
    dataMeth: h.dataMeth,
    dataCrc: h.dataCrc,
    rsrcOffset,
    rsrcClen: h.rsrcClen,
    rsrcUlen: h.rsrcUlen,
    rsrcMeth: h.rsrcMeth,
    rsrcCrc: h.rsrcCrc,
  };
}

function walkClassicHeaders(totalSize: number, readHeader: (pos: number) => Uint8Array): SitPackedMember[] {
  const members: SitPackedMember[] = [];
  const path: string[] = [];
  let pos = 22;
  while (pos + SIT_ENTRY <= totalSize) {
    const h = decodeClassicHeader(readHeader(pos));
    pos += SIT_ENTRY;
    const full = path.length ? `${path.join('/')}/${h.name}` : h.name;
    if (h.rsrcFolder === START_FOLDER || h.dataFolder === START_FOLDER) {
      members.push(packedFolder('classic', full, '    ', '    ', h.finderFlags, h.createDate, h.modDate));
      path.push(h.name);
      continue;
    }
    if (h.rsrcFolder === END_FOLDER || h.dataFolder === END_FOLDER) {
      path.pop();
      continue;
    }
    const rsrcOffset = pos;
    pos += h.rsrcClen;
    const dataOffset = pos;
    pos += h.dataClen;
    members.push(memberFromClassic(full, h, rsrcOffset, dataOffset));
  }
  return members;
}

function parseClassic(data: Uint8Array): SitEntry[] {
  const totalSize = Math.min(be32(data, 6), data.length);
  const members = walkClassicHeaders(totalSize, (pos) => data.subarray(pos, pos + SIT_ENTRY));
  return members.map((m) => extractSitMemberSync(data, m));
}

async function parseClassicFromReader(read: ByteRangeReader, prefix: Uint8Array, fileSize?: number): Promise<SitPackedMember[]> {
  const declared = be32(prefix, 6);
  const totalSize = fileSize != null ? Math.min(declared, fileSize) : declared;
  const members: SitPackedMember[] = [];
  const path: string[] = [];
  let pos = 22;
  while (pos + SIT_ENTRY <= totalSize) {
    const h = decodeClassicHeader(await readExact(read, pos, SIT_ENTRY));
    pos += SIT_ENTRY;
    const full = path.length ? `${path.join('/')}/${h.name}` : h.name;
    if (h.rsrcFolder === START_FOLDER || h.dataFolder === START_FOLDER) {
      members.push(packedFolder('classic', full, '    ', '    ', h.finderFlags, h.createDate, h.modDate));
      path.push(h.name);
      continue;
    }
    if (h.rsrcFolder === END_FOLDER || h.dataFolder === END_FOLDER) {
      path.pop();
      continue;
    }
    const rsrcOffset = pos;
    pos += h.rsrcClen;
    const dataOffset = pos;
    pos += h.dataClen;
    members.push(memberFromClassic(full, h, rsrcOffset, dataOffset));
  }
  return members;
}

function extractSitMemberSync(data: Uint8Array, m: SitPackedMember): SitEntry {
  if (m.isFolder) {
    return {
      name: m.name,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      fileType: m.fileType,
      creator: m.creator,
      isFolder: true,
      finderFlags: m.finderFlags,
      createDate: m.createDate,
      modDate: m.modDate,
    };
  }
  const end = m.rsrcOffset + m.rsrcClen > m.dataOffset + m.dataClen ? m.rsrcOffset + m.rsrcClen : m.dataOffset + m.dataClen;
  if (end > data.length) throw CORRUPT();
  const rPacked = m.rsrcClen > 0 ? data.subarray(m.rsrcOffset, m.rsrcOffset + m.rsrcClen) : new Uint8Array();
  const dPacked = m.dataClen > 0 ? data.subarray(m.dataOffset, m.dataOffset + m.dataClen) : new Uint8Array();
  return finishSitMember(m, dPacked, rPacked);
}

function finishSitMember(m: SitPackedMember, dPacked: Uint8Array, rPacked: Uint8Array): SitEntry {
  const dataFork = decompressFork(m.format, dPacked, m.dataMeth, m.dataUlen);
  const rsrcFork = decompressFork(m.format, rPacked, m.rsrcMeth, m.rsrcUlen);
  requireForkCrc(rsrcFork, m.rsrcCrc, m.rsrcMeth);
  requireForkCrc(dataFork, m.dataCrc, m.dataMeth);
  return {
    name: m.name,
    data: dataFork,
    resource: rsrcFork,
    fileType: m.fileType,
    creator: m.creator,
    isFolder: false,
    finderFlags: m.finderFlags,
    createDate: m.createDate,
    modDate: m.modDate,
  };
}

/** Decompress one catalog member through ranged fork reads. */
export async function extractSitMember(read: ByteRangeReader, m: SitPackedMember): Promise<SitEntry> {
  if (m.isFolder) {
    return {
      name: m.name,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      fileType: m.fileType,
      creator: m.creator,
      isFolder: true,
      finderFlags: m.finderFlags,
      createDate: m.createDate,
      modDate: m.modDate,
    };
  }
  const rPacked = m.rsrcClen > 0 ? await readExact(read, m.rsrcOffset, m.rsrcClen) : new Uint8Array();
  const dPacked = m.dataClen > 0 ? await readExact(read, m.dataOffset, m.dataClen) : new Uint8Array();
  return finishSitMember(m, dPacked, rPacked);
}

type Sit5Dummy = { kind: 'dummy'; nextCursor: number };
type Sit5Skip = { kind: 'skip'; nextCursor: number };
type Sit5Dir = {
  kind: 'dir';
  name: string;
  parentDirOff: number;
  fileType: string;
  creator: string;
  finderFlags: number;
  createDate: number;
  modDate: number;
  dirFiles: number;
  nextCursor: number;
};
type Sit5File = {
  kind: 'file';
  name: string;
  parentDirOff: number;
  fileType: string;
  creator: string;
  finderFlags: number;
  createDate: number;
  modDate: number;
  dataMeth: number;
  dataUlen: number;
  dataClen: number;
  dataCrc: number;
  rsrcMeth: number;
  rsrcUlen: number;
  rsrcClen: number;
  rsrcCrc: number;
  dataStart: number;
  nextCursor: number;
};
type Sit5Layout = Sit5Dummy | Sit5Skip | Sit5Dir | Sit5File;

/** Parse one StuffIt 5 entry from bytes starting at that entry. `null` means the slice is too short. */
function readSit5Layout(b: Uint8Array, entryStart: number): Sit5Layout | null {
  if (b.length < 48) return null;
  if (be32(b, 0) !== 0xa5a5a5a5) throw CORRUPT();
  const entryVersion = b[4]!;
  const headerSize = be16(b, 6);
  if (headerSize < 48) throw CORRUPT();
  if (headerSize > b.length) return null;
  const header = b.subarray(0, headerSize);
  if (sit5HeaderCrc(header) !== be16(header, 32)) throw CORRUPT();
  const headerEndAbs = entryStart + headerSize;
  const entryFlags = b[9]!;
  const ctime = be32(b, 10);
  const mtime = be32(b, 14);
  const nextOff = be32(b, 22);
  const dirOff = be32(b, 26);
  const nameLen = be16(b, 30);
  const dataUlen = be32(b, 34);
  const dataClen = be32(b, 38);
  const dataCrc = be16(b, 42);
  const isDir = (entryFlags & 0x40) !== 0;
  let pos = 46;
  let dataMeth = 0;
  let dirFiles = 0;
  if (isDir) {
    if (pos + 2 > b.length) return null;
    dirFiles = be16(b, pos);
    pos += 2;
    if (dataUlen === 0xffffffff) return { kind: 'dummy', nextCursor: headerEndAbs };
  } else {
    if (pos + 2 > b.length) return null;
    dataMeth = b[pos]!;
    const passLen = b[pos + 1]!;
    pos += 2;
    if ((entryFlags & 0x20) !== 0 || passLen !== 0) {
      throw new SitError('Unsupported type encrypted', 'unsupported');
    }
  }
  if (pos + nameLen > b.length) return null;
  const namePart = readName(b.subarray(pos, pos + nameLen));
  pos += nameLen;
  if (isDir && nameLen === 0) {
    return { kind: 'skip', nextCursor: nextOff !== 0 ? nextOff : headerEndAbs };
  }
  if (pos < headerSize) {
    if (pos + 2 > b.length) return null;
    const commentSize = be16(b, pos);
    pos += 4 + commentSize;
  }
  if (pos + 14 > b.length) return null;
  const something = be16(b, pos);
  pos += 4;
  const fileType = ostypeFromBytes(b, pos);
  const creator = ostypeFromBytes(b, pos + 4);
  const finderFlags = be16(b, pos + 8);
  pos += 10 + (entryVersion === 1 ? 22 : 18);
  if (pos > b.length) return null;
  let rsrcUlen = 0;
  let rsrcClen = 0;
  let rsrcMeth = 0;
  let rsrcCrc = 0;
  const hasRsrc = !isDir && (something & 0x01) !== 0;
  if (hasRsrc) {
    if (pos + 14 > b.length) return null;
    rsrcUlen = be32(b, pos);
    rsrcClen = be32(b, pos + 4);
    rsrcCrc = be16(b, pos + 8);
    rsrcMeth = b[pos + 12]!;
    const rsrcPass = b[pos + 13]!;
    pos += 14;
    if ((entryFlags & 0x20) !== 0 && rsrcPass > 0) {
      pos += rsrcPass;
      if (pos > b.length) return null;
    }
  }
  if (isDir) {
    return {
      kind: 'dir',
      name: namePart,
      parentDirOff: dirOff,
      fileType,
      creator,
      finderFlags,
      createDate: ctime,
      modDate: mtime,
      dirFiles,
      nextCursor: dataUlen !== 0 && dataUlen !== 0xffffffff ? dataUlen : entryStart + pos,
    };
  }
  const dataStart = entryStart + pos;
  return {
    kind: 'file',
    name: namePart,
    parentDirOff: dirOff,
    fileType,
    creator,
    finderFlags,
    createDate: ctime,
    modDate: mtime,
    dataMeth,
    dataUlen,
    dataClen,
    dataCrc,
    rsrcMeth,
    rsrcUlen,
    rsrcClen,
    rsrcCrc,
    dataStart,
    nextCursor: dataStart + rsrcClen + dataClen,
  };
}

function sit5FullName(dirs: Map<number, string>, parentDirOff: number, namePart: string): string {
  const parentPath = dirs.get(parentDirOff) ?? '';
  return parentPath ? `${parentPath}/${namePart}` : namePart;
}

function applySit5Layout(
  layout: Sit5Layout,
  entryStart: number,
  dirs: Map<number, string>,
  members: SitPackedMember[],
  numTotal: number,
): { cursor: number; numTotal: number; consumed: boolean } {
  if (layout.kind === 'dummy') {
    return { cursor: layout.nextCursor, numTotal: numTotal + 1, consumed: true };
  }
  if (layout.kind === 'skip') {
    return { cursor: layout.nextCursor, numTotal, consumed: false };
  }
  const name = sit5FullName(dirs, layout.parentDirOff, layout.name);
  if (layout.kind === 'dir') {
    dirs.set(entryStart, name);
    members.push(
      packedFolder('sit5', name, layout.fileType, layout.creator, layout.finderFlags, layout.createDate, layout.modDate),
    );
    return { cursor: layout.nextCursor, numTotal: numTotal + layout.dirFiles, consumed: true };
  }
  members.push({
    name,
    isFolder: false,
    fileType: layout.fileType,
    creator: layout.creator,
    finderFlags: layout.finderFlags,
    createDate: layout.createDate,
    modDate: layout.modDate,
    format: 'sit5',
    dataOffset: layout.dataStart + layout.rsrcClen,
    dataClen: layout.dataClen,
    dataUlen: layout.dataUlen,
    dataMeth: layout.dataMeth,
    dataCrc: layout.dataCrc,
    rsrcOffset: layout.dataStart,
    rsrcClen: layout.rsrcClen,
    rsrcUlen: layout.rsrcUlen,
    rsrcMeth: layout.rsrcMeth,
    rsrcCrc: layout.rsrcCrc,
  });
  return { cursor: layout.nextCursor, numTotal, consumed: true };
}

function parseSit5Catalog(data: Uint8Array): SitPackedMember[] {
  const archiveVersion = data[82]!;
  const archiveFlags = data[83]!;
  if (archiveVersion !== 5) throw new SitError(`Unsupported type ${archiveVersion}`, 'unsupported');
  if ((archiveFlags & 0x80) !== 0) throw new SitError('Unsupported type encrypted', 'unsupported');
  let numTotal = be16(data, 92);
  let cursor = be32(data, 94);
  const members: SitPackedMember[] = [];
  const dirs = new Map<number, string>();
  let i = 0;
  while (i < numTotal) {
    if (cursor >= data.length) break;
    const layout = readSit5Layout(data.subarray(cursor), cursor);
    if (!layout) {
      if (data.length - cursor < 48) break;
      throw CORRUPT();
    }
    const next = applySit5Layout(layout, cursor, dirs, members, numTotal);
    cursor = next.cursor;
    numTotal = next.numTotal;
    if (next.consumed) i++;
  }
  return members;
}

async function parseSit5FromReader(read: ByteRangeReader, prefix: Uint8Array): Promise<SitPackedMember[]> {
  const archiveVersion = prefix[82]!;
  const archiveFlags = prefix[83]!;
  if (archiveVersion !== 5) throw new SitError(`Unsupported type ${archiveVersion}`, 'unsupported');
  if ((archiveFlags & 0x80) !== 0) throw new SitError('Unsupported type encrypted', 'unsupported');
  let numTotal = be16(prefix, 92);
  let cursor = be32(prefix, 94);
  const members: SitPackedMember[] = [];
  const dirs = new Map<number, string>();
  let i = 0;
  while (i < numTotal) {
    const layout = await readSit5LayoutFromReader(read, cursor);
    if (!layout) break;
    const next = applySit5Layout(layout, cursor, dirs, members, numTotal);
    cursor = next.cursor;
    numTotal = next.numTotal;
    if (next.consumed) i++;
  }
  return members;
}

async function readSit5LayoutFromReader(read: ByteRangeReader, cursor: number): Promise<Sit5Layout | null> {
  let want = 256;
  for (;;) {
    const bytes = await read(cursor, want);
    if (bytes.length === 0) return null;
    const layout = readSit5Layout(bytes, cursor);
    if (layout) return layout;
    if (bytes.length < want) throw CORRUPT();
    want *= 2;
    if (want > 1_048_576) throw CORRUPT();
  }
}

function parseSit5(data: Uint8Array): SitEntry[] {
  return parseSit5Catalog(data).map((m) => extractSitMemberSync(data, m));
}

export function parseStuffIt(data: Uint8Array): SitEntry[] | null {
  try {
    const unsupported = sitUnsupportedTypeCode(data);
    if (unsupported) throw new SitError(`Unsupported type ${unsupported}`, 'unsupported');
    if (data.length < 22) return null;
    if (isClassic(data)) return parseClassic(data);
    if (isSit5(data)) return parseSit5(data);
    return null;
  } catch (err) {
    if (err instanceof SitError && (err.code === 'unsupported' || err.code === 'corrupt')) throw err;
    return null;
  }
}

/**
 * Read StuffIt headers through ranged fork reads. Packed fork payloads are not fetched.
 * Returns null when the payload is not a StuffIt archive.
 */
export async function parseStuffItFromReader(
  read: ByteRangeReader,
  fileSize?: number,
): Promise<SitPackedMember[] | null> {
  const prefix = await read(0, 100);
  const unsupported = sitUnsupportedTypeCode(prefix);
  if (unsupported) throw new SitError(`Unsupported type ${unsupported}`, 'unsupported');
  if (prefix.length >= 22 && isClassic(prefix)) return parseClassicFromReader(read, prefix, fileSize);
  if (isSit5(prefix)) return parseSit5FromReader(read, prefix);
  return null;
}


/**
 * Archive signature / codec from the StuffIt file header (not Finder type/creator).
 * `SIT!` is a supported classic magic — callers should treat a failed SIT! parse as corrupt.
 */
export function sitUnsupportedTypeCode(data: Uint8Array): string | null {
  if (data.length < 4) return null;
  const sitx = sitxSignature(data);
  if (sitx) return sitx;
  const magic = headerMagic(data);
  if (isSit5(data)) {
    if (data.length > 82 && data[82] !== 5) return String(data[82]!);
    return null;
  }
  if (hasRLau(data) && !isClassicMagic(data)) return magic;
  if (magic === 'SITD') return magic;
  return null;
}

/** User-facing error when Expand cannot unpack `data`. */
export function stuffItExpandError(data: Uint8Array, err?: unknown): SitError {
  if (err instanceof SitError) return err;
  const type = sitUnsupportedTypeCode(data);
  if (type) return new SitError(`Unsupported type ${type}`, 'unsupported');
  return new SitError('This archive appears to be corrupted.', 'corrupt');
}

/** Build a classic store-only archive (tests / round-trip). */
export function buildClassicStore(files: { name: string; data: Uint8Array; resource?: Uint8Array; type?: string; creator?: string; flags?: number; createDate?: number; modDate?: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(22);
  header.set([0x53, 0x49, 0x54, 0x21]); // SIT!
  writeBe16(header, 4, files.length);
  header.set([0x72, 0x4c, 0x61, 0x75], 10); // rLau
  parts.push(header);
  for (const f of files) {
    const encoded = encodeMacRoman(f.name).subarray(0, 31);
    const nameBytes = new Uint8Array(31);
    nameBytes.set(encoded);
    const rsrc = f.resource ?? new Uint8Array();
    const entry = new Uint8Array(SIT_ENTRY);
    entry[1] = 0;
    entry[0] = 0;
    entry[2] = encoded.length;
    entry.set(nameBytes, 3);
    const type = f.type ?? 'TEXT';
    const creator = f.creator ?? 'ttxt';
    for (let i = 0; i < 4; i++) {
      entry[66 + i] = type.charCodeAt(i) || 0x20;
      entry[70 + i] = creator.charCodeAt(i) || 0x20;
    }
    writeBe16(entry, 74, f.flags ?? 0);
    writeBe32(entry, 76, f.createDate ?? 0);
    writeBe32(entry, 80, f.modDate ?? 0);
    writeBe32(entry, 84, rsrc.length);
    writeBe32(entry, 88, f.data.length);
    writeBe32(entry, 92, rsrc.length);
    writeBe32(entry, 96, f.data.length);
    writeBe16(entry, 100, crc16Ibm(rsrc));
    writeBe16(entry, 102, crc16Ibm(f.data));
    writeBe16(entry, 110, crc16Ibm(entry.subarray(0, 110)));
    parts.push(entry, rsrc, f.data);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  writeBe32(header, 6, total);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
