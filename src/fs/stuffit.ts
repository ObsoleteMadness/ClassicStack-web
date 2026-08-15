/** StuffIt 1.x (`SIT!`) and StuffIt 5 parsers. Layout and CRC match The Unarchiver (XADStuffItParser / XADStuffIt5Parser). */

import { be16, be32, writeBe16, writeBe32 } from '../protocol/binary';
import { crc16Ibm } from '../protocol/crc16';
import { decodeMacRoman, encodeMacRoman } from '../protocol/macroman';
import { decompressClassic, decompressSit5, SitError } from './stuffit-codec';
import { ostypeFromBytes } from './mac-file';

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

const SIT_ENTRY = 112;
const START_FOLDER = 0x20;
const END_FOLDER = 0x21;
/** Classic archive magics (4-byte header) that share the SIT! / rLau layout. */
const CLASSIC_MAGICS = new Set(['SIT!', 'ST46', 'ST50', 'ST60', 'ST65', 'STin', 'STi2', 'STi3', 'STi4']);

function headerMagic(data: Uint8Array): string {
  return ostypeFromBytes(data, 0);
}

function hasRLau(data: Uint8Array): boolean {
  return data.length >= 14 && ostypeFromBytes(data, 10) === 'rLau';
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
  return hasRLau(data) && CLASSIC_MAGICS.has(headerMagic(data));
}

function isSit5(data: Uint8Array): boolean {
  return (
    data.length >= 7 &&
    data[0] === 0x53 &&
    data[1] === 0x74 &&
    data[2] === 0x75 &&
    data[3] === 0x66 &&
    data[4] === 0x66 &&
    data[5] === 0x49 &&
    data[6] === 0x74
  );
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

function parseClassic(data: Uint8Array): SitEntry[] {
  const totalSize = Math.min(be32(data, 6), data.length);
  const entries: SitEntry[] = [];
  const path: string[] = [];
  let pos = 22;
  while (pos + SIT_ENTRY <= totalSize) {
    const header = data.subarray(pos, pos + SIT_ENTRY);
    if (crc16Ibm(header.subarray(0, 110)) !== be16(header, 110)) {
      throw new SitError('This archive appears to be corrupted.', 'corrupt');
    }
    pos += SIT_ENTRY;
    const rsrcMethod = header[0]!;
    const dataMethod = header[1]!;
    const rsrcFolder = rsrcMethod & ~0x90;
    const dataFolder = dataMethod & ~0x90;
    const nameLen = Math.min(header[2]!, 31);
    const name = readName(header.subarray(3, 3 + nameLen));
    const full = path.length ? `${path.join('/')}/${name}` : name;
    if (rsrcFolder === START_FOLDER || dataFolder === START_FOLDER) {
      entries.push({
        name: full,
        data: new Uint8Array(),
        resource: new Uint8Array(),
        fileType: ostypeFromBytes(header, 66),
        creator: ostypeFromBytes(header, 70),
        isFolder: true,
        finderFlags: be16(header, 74),
        createDate: be32(header, 76),
        modDate: be32(header, 80),
      });
      path.push(name);
      continue;
    }
    if (rsrcFolder === END_FOLDER || dataFolder === END_FOLDER) {
      path.pop();
      continue;
    }
    const rsrcUlen = be32(header, 84);
    const dataUlen = be32(header, 88);
    const rsrcClen = be32(header, 92);
    const dataClen = be32(header, 96);
    const rsrcCrc = be16(header, 100);
    const dataCrc = be16(header, 102);
    if (pos + rsrcClen + dataClen > data.length) {
      throw new SitError('This archive appears to be corrupted.', 'corrupt');
    }
    const rsrcPacked = data.subarray(pos, pos + rsrcClen);
    pos += rsrcClen;
    const dataPacked = data.subarray(pos, pos + dataClen);
    pos += dataClen;
    const dataMeth = dataMethod & 0x0f;
    const rsrcMeth = rsrcMethod & 0x0f;
    const dataFork = decompressFork('classic', dataPacked, dataMeth, dataUlen);
    const rsrcFork = decompressFork('classic', rsrcPacked, rsrcMeth, rsrcUlen);
    requireForkCrc(rsrcFork, rsrcCrc, rsrcMeth);
    requireForkCrc(dataFork, dataCrc, dataMeth);
    entries.push({
      name: full,
      data: dataFork,
      resource: rsrcFork,
      fileType: ostypeFromBytes(header, 66),
      creator: ostypeFromBytes(header, 70),
      isFolder: false,
      finderFlags: be16(header, 74),
      createDate: be32(header, 76),
      modDate: be32(header, 80),
    });
  }
  return entries;
}

function parseSit5(data: Uint8Array): SitEntry[] {
  const archiveVersion = data[82]!;
  const archiveFlags = data[83]!;
  if (archiveVersion !== 5) throw new SitError(`Unsupported type ${archiveVersion}`, 'unsupported');
  if ((archiveFlags & 0x80) !== 0) throw new SitError('Unsupported type encrypted', 'unsupported');
  // Archive header: totalsize@84, unknown@88, numfiles@92, first entry offset@94 (Unarchiver).
  let numTotal = be16(data, 92);
  let cursor = be32(data, 94);
  const entries: SitEntry[] = [];
  const dirs = new Map<number, string>();
  let i = 0;
  while (i < numTotal) {
    if (cursor + 48 > data.length) break;
    if (be32(data, cursor) !== 0xa5a5a5a5) throw new SitError('This archive appears to be corrupted.', 'corrupt');
    const entryStart = cursor;
    const entryVersion = data[cursor + 4]!;
    const headerSize = be16(data, cursor + 6);
    if (headerSize < 48 || entryStart + headerSize > data.length) {
      throw new SitError('This archive appears to be corrupted.', 'corrupt');
    }
    const header = data.subarray(entryStart, entryStart + headerSize);
    if (sit5HeaderCrc(header) !== be16(header, 32)) {
      throw new SitError('This archive appears to be corrupted.', 'corrupt');
    }
    const headerEnd = entryStart + headerSize;
    const entryFlags = data[cursor + 9]!;
    const ctime = be32(data, cursor + 10);
    const mtime = be32(data, cursor + 14);
    const nextOff = be32(data, cursor + 22);
    const dirOff = be32(data, cursor + 26);
    const nameLen = be16(data, cursor + 30);
    const dataUlen = be32(data, cursor + 34);
    const dataClen = be32(data, cursor + 38);
    const dataCrc = be16(data, cursor + 42);
    const isDir = (entryFlags & 0x40) !== 0;
    let pos = entryStart + 46;
    let dataMeth = 0;
    let dirFiles = 0;
    if (isDir) {
      dirFiles = be16(data, pos);
      pos += 2;
      if (dataUlen === 0xffffffff) {
        numTotal++;
        i++;
        cursor = headerEnd;
        continue;
      }
    } else {
      dataMeth = data[pos]!;
      const passLen = data[pos + 1]!;
      pos += 2;
      if ((entryFlags & 0x20) !== 0 || passLen !== 0) {
        throw new SitError('Unsupported type encrypted', 'unsupported');
      }
    }
    const namePart = readName(data.subarray(pos, pos + nameLen));
    pos += nameLen;
    if (isDir && nameLen === 0) {
      cursor = nextOff !== 0 ? nextOff : headerEnd;
      continue;
    }
    const parentPath = dirs.get(dirOff) ?? '';
    const name = parentPath ? `${parentPath}/${namePart}` : namePart;
    if (isDir) dirs.set(entryStart, name);
    if (pos < headerEnd) {
      const commentSize = be16(data, pos);
      pos += 4 + commentSize;
    }
    const something = be16(data, pos);
    pos += 4;
    const fileType = ostypeFromBytes(data, pos);
    const creator = ostypeFromBytes(data, pos + 4);
    const finderFlags = be16(data, pos + 8);
    pos += 10 + (entryVersion === 1 ? 22 : 18);
    let rsrcUlen = 0;
    let rsrcClen = 0;
    let rsrcMeth = 0;
    let rsrcCrc = 0;
    const hasRsrc = !isDir && (something & 0x01) !== 0;
    if (hasRsrc) {
      // ulen, clen, crc16, reserved, method, passlen — 14 bytes (not 12).
      rsrcUlen = be32(data, pos);
      rsrcClen = be32(data, pos + 4);
      rsrcCrc = be16(data, pos + 8);
      rsrcMeth = data[pos + 12]!;
      const rsrcPass = data[pos + 13]!;
      pos += 14;
      if ((entryFlags & 0x20) !== 0 && rsrcPass > 0) pos += rsrcPass;
    }
    if (isDir) {
      entries.push({
        name,
        data: new Uint8Array(),
        resource: new Uint8Array(),
        fileType,
        creator,
        isFolder: true,
        finderFlags,
        createDate: ctime,
        modDate: mtime,
      });
      numTotal += dirFiles;
      cursor = dataUlen !== 0 && dataUlen !== 0xffffffff ? dataUlen : pos;
    } else {
      const dataStart = pos;
      if (dataStart + rsrcClen + dataClen > data.length) {
        throw new SitError('This archive appears to be corrupted.', 'corrupt');
      }
      const rPacked = hasRsrc && rsrcClen > 0 ? data.subarray(dataStart, dataStart + rsrcClen) : new Uint8Array();
      const dPacked =
        dataClen > 0 ? data.subarray(dataStart + rsrcClen, dataStart + rsrcClen + dataClen) : new Uint8Array();
      const dataFork = decompressFork('sit5', dPacked, dataMeth, dataUlen);
      const rsrcFork = decompressFork('sit5', rPacked, rsrcMeth, rsrcUlen);
      requireForkCrc(rsrcFork, rsrcCrc, rsrcMeth);
      requireForkCrc(dataFork, dataCrc, dataMeth);
      entries.push({
        name,
        data: dataFork,
        resource: rsrcFork,
        fileType,
        creator,
        isFolder: false,
        finderFlags,
        createDate: ctime,
        modDate: mtime,
      });
      cursor = dataStart + rsrcClen + dataClen;
    }
    i++;
  }
  return entries;
}

export function parseStuffIt(data: Uint8Array): SitEntry[] | null {
  try {
    const unsupported = sitUnsupportedTypeCode(data);
    if (unsupported) throw new SitError(`Unsupported type ${unsupported}`, 'unsupported');
    if (data.length < 22) return null;
    if (isClassic(data)) return parseClassic(data);
    if (data.length >= 80 && isSit5(data)) return parseSit5(data);
    return null;
  } catch (err) {
    if (err instanceof SitError && (err.code === 'unsupported' || err.code === 'corrupt')) throw err;
    return null;
  }
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
  if (hasRLau(data) && !CLASSIC_MAGICS.has(magic)) return magic;
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
