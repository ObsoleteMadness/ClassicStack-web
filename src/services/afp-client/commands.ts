/** AFP client command builders + reply parsers. */

import { appendBe16, appendBe32, be16, be32 } from '../../protocol/binary';
import { encodeMacRoman, decodeMacRoman } from '../../protocol/macroman';
import * as C from '../../protocol/afp/constants';

function putPString(out: number[], s: string | Uint8Array): void {
  const b = typeof s === 'string' ? encodeMacRoman(s) : s;
  out.push(b.length, ...b);
}

function even(out: number[]): void {
  if (out.length % 2) out.push(0);
}

/**
 * AFP pathname bytes (no length prefix): leading NUL, elements joined by NUL.
 * Empty path → single NUL (“this directory”). Wrapped with putPString on the wire
 * (OmniTalk afpWirePath + PutPString).
 */
export function wirePath(path: string): Uint8Array {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return new Uint8Array([0x00]);
  const elems = trimmed.split('/');
  const parts: number[] = [0x00];
  elems.forEach((e, i) => {
    if (i > 0) parts.push(0x00);
    parts.push(...encodeMacRoman(e));
  });
  return new Uint8Array(parts);
}

/** pathType(1) + Pascal pathname (OmniTalk command marshals). */
function putPath(out: number[], path: string): void {
  out.push(C.PathTypeLongNames);
  putPString(out, wirePath(path));
}

export function loginGuest(version = C.AFPVersion21, uam = C.UAMNoUserAuthent): Uint8Array {
  const out: number[] = [C.CmdLogin];
  putPString(out, version);
  putPString(out, uam);
  return new Uint8Array(out);
}

/** Cleartxt Passwrd: username pstring + even pad + 8-byte null-padded password. */
export function loginCleartext(
  username: string,
  password: string,
  version = C.AFPVersion21,
  uam = C.UAMCleartxtPasswrd,
): Uint8Array {
  const out: number[] = [C.CmdLogin];
  putPString(out, version);
  putPString(out, uam);
  putPString(out, username);
  if (out.length % 2) out.push(0);
  const pw = encodeMacRoman(password).subarray(0, 8);
  for (let i = 0; i < 8; i++) out.push(pw[i] ?? 0);
  return new Uint8Array(out);
}

/** Randnum / 2-Way Randnum: username only in UserAuthInfo. */
export function loginRandnum(username: string, version: string, uam: string): Uint8Array {
  const out: number[] = [C.CmdLogin];
  putPString(out, version);
  putPString(out, uam);
  putPString(out, username);
  return new Uint8Array(out);
}

export function loginCont(id: number, userAuthInfo: Uint8Array): Uint8Array {
  const out: number[] = [C.CmdLoginCont, 0];
  appendBe16(out, id);
  out.push(...userAuthInfo);
  return new Uint8Array(out);
}

export function parseAuthContinue(b: Uint8Array): { id: number; nonce: Uint8Array } {
  if (b.length < 10) return { id: 0, nonce: new Uint8Array(8) };
  return { id: be16(b, 0), nonce: b.subarray(2, 10) };
}

export function matchUam(uams: string[], pattern: RegExp): string | undefined {
  return uams.find((u) => pattern.test(u));
}

/** Newest advertised AFP version this client ranks, using the server's exact string. */
const AFP_VERSION_RANK: Record<string, number> = {
  'AFPVersion 1.1': 1,
  'AFPVersion 2.0': 2,
  'AFPVersion 2.1': 3,
  'AFP2.2': 4,
  'AFPVersion 2.2': 4,
  AFPX03: 5,
  'AFP3.0': 5,
};

export function pickAfpVersion(versions: string[], fallback = C.AFPVersion21): string {
  let best = '';
  let bestRank = 0;
  for (const v of versions) {
    const r = AFP_VERSION_RANK[v] ?? 0;
    if (r > bestRank) {
      best = v;
      bestRank = r;
    }
  }
  return best || fallback;
}

/** Server's advertised cleartext UAM spelling (e.g. `Cleartxt passwrd`). */
export function pickCleartextUam(uams: string[]): string {
  const want = C.UAMCleartxtPasswrd.toLowerCase();
  return uams.find((u) => u.toLowerCase() === want) ?? C.UAMCleartxtPasswrd;
}

export function pickGuestUam(uams: string[]): string {
  return uams.find((u) => /no user authent/i.test(u)) ?? C.UAMNoUserAuthent;
}

export function closeVol(volId: number): Uint8Array {
  const out: number[] = [C.CmdCloseVol, 0];
  appendBe16(out, volId);
  return new Uint8Array(out);
}

export function logout(): Uint8Array {
  return new Uint8Array([C.CmdLogout, 0]);
}

export function getSrvrParms(): Uint8Array {
  return new Uint8Array([C.CmdGetSrvrParms, 0]);
}

export function parseSrvrParms(b: Uint8Array): { serverTime: number; volumes: { flags: number; name: string }[] } {
  if (b.length < 5) return { serverTime: 0, volumes: [] };
  const serverTime = be32(b, 0);
  const count = b[4]!;
  const volumes: { flags: number; name: string }[] = [];
  let o = 5;
  for (let i = 0; i < count && o < b.length; i++) {
    const flags = b[o++]!;
    const len = b[o++]!;
    const name = decodeMacRoman(b.subarray(o, o + len));
    o += len;
    if ((1 + len) % 2) o++; // pad after odd-length Pascal name
    volumes.push({ flags, name });
  }
  return { serverTime, volumes };
}

export function openVol(name: string, bitmap = C.VolBitmapID | C.VolBitmapSignature): Uint8Array {
  const out: number[] = [C.CmdOpenVol, 0];
  appendBe16(out, bitmap);
  putPString(out, name);
  return new Uint8Array(out);
}

export function parseOpenVol(b: Uint8Array): { volId: number } {
  // Reply: bitmap echo then params; VolID is typically after signature fields.
  // Minimal: many servers return bitmap(2) + ... + volID. OmniTalk ParseVolParams:
  // walk bitmap. For ID-only bitmap bit5: after attrs/sig/dates...
  // Simplified parse: if body has at least 4 bytes after optional fields, find volID.
  if (b.length < 4) return { volId: 0 };
  const bitmap = be16(b, 0);
  let o = 2;
  if (bitmap & C.VolBitmapAttributes) o += 2;
  if (bitmap & C.VolBitmapSignature) o += 2;
  if (bitmap & C.VolBitmapCreateDate) o += 4;
  if (bitmap & C.VolBitmapModDate) o += 4;
  if (bitmap & (1 << 4)) o += 4; // backup
  let volId = 0;
  if (bitmap & C.VolBitmapID) {
    volId = be16(b, o);
    o += 2;
  }
  return { volId };
}

export function enumerate(
  volId: number,
  dirId: number,
  fileBitmap: number,
  dirBitmap: number,
  reqCount = 20,
  startIndex = 1,
  maxReplySize = 4624,
  path = '',
): Uint8Array {
  const out: number[] = [C.CmdEnumerate, 0];
  appendBe16(out, volId);
  appendBe32(out, dirId);
  appendBe16(out, fileBitmap);
  appendBe16(out, dirBitmap);
  appendBe16(out, reqCount);
  appendBe16(out, startIndex);
  appendBe16(out, maxReplySize);
  putPath(out, path);
  return new Uint8Array(out);
}

export interface DirEntry {
  isDir: boolean;
  name: string;
  cnid: number;
  parentId: number;
  dataLen: number;
  rsrcLen: number;
  createDate: number;
  modDate: number;
  finderInfo: Uint8Array;
}

export function parseEnumerate(b: Uint8Array, fileBitmap: number, dirBitmap: number): DirEntry[] {
  if (b.length < 6) return [];
  // Reply: fileBitmap(2) dirBitmap(2) count(2) then
  // {entryLen(1) type(1) <params>}×count — OmniTalk ParseEnumerateReply / server buildEnumRecord.
  const fbm = be16(b, 0);
  const dbm = be16(b, 2);
  const count = be16(b, 4);
  const entries: DirEntry[] = [];
  let o = 6;
  for (let i = 0; i < count && o < b.length; i++) {
    if (o + 2 > b.length) break;
    const entryLen = b[o]!;
    const typeByte = b[o + 1]!;
    if (entryLen < 2 || o + entryLen > b.length) break;
    const isDir = (typeByte & 0x80) !== 0;
    const bm = isDir ? dbm || dirBitmap : fbm || fileBitmap;
    const params = b.subarray(o + 2, o + entryLen);
    entries.push(parseParms(params, bm, isDir));
    o += entryLen;
  }
  return entries;
}

function parseParms(b: Uint8Array, bitmap: number, isDir: boolean): DirEntry {
  let o = 0;
  const entry: DirEntry = {
    isDir,
    name: '',
    cnid: 0,
    parentId: 0,
    dataLen: 0,
    rsrcLen: 0,
    createDate: 0,
    modDate: 0,
    finderInfo: new Uint8Array(32),
  };
  if (bitmap & C.FDBitmapAttributes) o += 2;
  if (bitmap & C.FDBitmapParentDID) {
    entry.parentId = be32(b, o);
    o += 4;
  }
  if (bitmap & C.FDBitmapCreateDate) {
    entry.createDate = be32(b, o);
    o += 4;
  }
  if (bitmap & C.FDBitmapModDate) {
    entry.modDate = be32(b, o);
    o += 4;
  }
  if (bitmap & C.FDBitmapBackupDate) o += 4;
  if (bitmap & C.FDBitmapFinderInfo) {
    entry.finderInfo = b.subarray(o, o + 32).slice();
    o += 32;
  }
  let longNameOff = 0;
  if (bitmap & C.FDBitmapLongName) {
    longNameOff = be16(b, o);
    o += 2;
  }
  if (bitmap & C.FDBitmapShortName) o += 2; // offset
  if (!isDir) {
    if (bitmap & C.FileBitmapFileNum) {
      entry.cnid = be32(b, o);
      o += 4;
    }
    if (bitmap & C.FileBitmapDataForkLen) {
      entry.dataLen = be32(b, o);
      o += 4;
    }
    if (bitmap & C.FileBitmapRsrcForkLen) {
      entry.rsrcLen = be32(b, o);
      o += 4;
    }
  } else {
    if (bitmap & C.DirBitmapDirID) {
      entry.cnid = be32(b, o);
      o += 4;
    }
    if (bitmap & C.DirBitmapOffspring) o += 2;
  }
  // Long name is a Pascal string at offset from start of parameters (or absolute in record).
  // OmniTalk stores offset relative to start of the parameter block.
  if (longNameOff > 0 && longNameOff < b.length) {
    const len = b[longNameOff]!;
    entry.name = decodeMacRoman(b.subarray(longNameOff + 1, longNameOff + 1 + len));
  }
  return entry;
}

export function createFile(volId: number, dirId: number, name: string, softCreate = 0): Uint8Array {
  const out: number[] = [C.CmdCreateFile, softCreate];
  appendBe16(out, volId);
  appendBe32(out, dirId);
  putPath(out, name);
  return new Uint8Array(out);
}

export function createDir(volId: number, dirId: number, name: string): Uint8Array {
  const out: number[] = [C.CmdCreateDir, 0];
  appendBe16(out, volId);
  appendBe32(out, dirId);
  putPath(out, name);
  return new Uint8Array(out);
}

export function deletePath(volId: number, dirId: number, path: string): Uint8Array {
  const out: number[] = [C.CmdDelete, 0];
  appendBe16(out, volId);
  appendBe32(out, dirId);
  putPath(out, path);
  return new Uint8Array(out);
}

export function rename(volId: number, dirId: number, path: string, newName: string): Uint8Array {
  const out: number[] = [C.CmdRename, 0];
  appendBe16(out, volId);
  appendBe32(out, dirId);
  putPath(out, path);
  even(out);
  putPath(out, newName);
  return new Uint8Array(out);
}

export function moveAndRename(
  volId: number,
  srcDir: number,
  srcPath: string,
  dstDir: number,
  newName: string,
): Uint8Array {
  const out: number[] = [C.CmdMoveAndRename, 0];
  appendBe16(out, volId);
  appendBe32(out, srcDir);
  appendBe32(out, dstDir);
  putPath(out, srcPath);
  even(out);
  putPath(out, ''); // dest path empty = dest dir
  even(out);
  putPath(out, newName);
  return new Uint8Array(out);
}

export function openFork(
  volId: number,
  dirId: number,
  bitmap: number,
  access: number,
  forkFlag: number,
  path: string,
): Uint8Array {
  const out: number[] = [C.CmdOpenFork, forkFlag];
  appendBe16(out, volId);
  appendBe32(out, dirId);
  appendBe16(out, bitmap);
  appendBe16(out, access);
  putPath(out, path);
  return new Uint8Array(out);
}

export function parseOpenFork(b: Uint8Array): { forkRef: number; forkLen: number } {
  // Reply: bitmap(2) forkRef(2) ... data/rsrc length depending on bitmap
  if (b.length < 4) return { forkRef: 0, forkLen: 0 };
  const bitmap = be16(b, 0);
  const forkRef = be16(b, 2);
  let o = 4;
  // skip params per bitmap briefly — length often at end
  void bitmap;
  let forkLen = 0;
  if (b.length >= o + 4) forkLen = be32(b, b.length - 4);
  return { forkRef, forkLen };
}

export function readFork(forkRef: number, offset: number, count: number): Uint8Array {
  const out: number[] = [C.CmdRead, 0];
  appendBe16(out, forkRef);
  appendBe32(out, offset);
  appendBe32(out, count);
  // newLineMask + newLineChar (14-byte fixed FPRead block; OmniTalk / System 7.5 PFS)
  out.push(0, 0);
  return new Uint8Array(out);
}

/** 12-byte FPWrite header for ASP two-phase Write (data pulled via WriteContinue). */
export function writeFork(forkRef: number, offset: number, reqCount: number, fromEnd = 0): Uint8Array {
  const out: number[] = [C.CmdWrite, fromEnd];
  appendBe16(out, forkRef);
  appendBe32(out, offset);
  appendBe32(out, reqCount);
  return new Uint8Array(out);
}

export function parseWriteReply(b: Uint8Array): number {
  if (b.length < 4) return 0;
  return be32(b, 0);
}

export function closeFork(forkRef: number): Uint8Array {
  const out: number[] = [C.CmdCloseFork, 0];
  appendBe16(out, forkRef);
  return new Uint8Array(out);
}

/**
 * FPSetFileDirParms with FinderInfo (and optional preceding date fields so the
 * FinderInfo bytes land at the correct offset for the requested bitmap).
 */
export function setFileDirParms(
  volId: number,
  dirId: number,
  bitmap: number,
  path: string,
  finderInfo: Uint8Array,
  dates?: { createDate?: number; modDate?: number; backupDate?: number; attributes?: number },
): Uint8Array {
  const out: number[] = [C.CmdSetFileDirParms, 0];
  appendBe16(out, volId);
  appendBe32(out, dirId);
  appendBe16(out, bitmap);
  putPath(out, path);
  even(out); // param block word-aligned from start of command (OmniTalk)
  if (bitmap & C.FDBitmapAttributes) appendBe16(out, dates?.attributes ?? 0);
  if (bitmap & C.FDBitmapParentDID) appendBe32(out, 0);
  if (bitmap & C.FDBitmapCreateDate) appendBe32(out, dates?.createDate ?? 0);
  if (bitmap & C.FDBitmapModDate) appendBe32(out, dates?.modDate ?? 0);
  if (bitmap & C.FDBitmapBackupDate) appendBe32(out, dates?.backupDate ?? 0);
  if (bitmap & C.FDBitmapFinderInfo) {
    for (let i = 0; i < 32; i++) out.push(finderInfo[i] ?? 0);
  }
  return new Uint8Array(out);
}

export function parseServerInfo(b: Uint8Array): {
  serverName: string;
  versions: string[];
  uams: string[];
  flags: number;
} {
  if (b.length < 10) return { serverName: '', versions: [], uams: [], flags: 0 };
  const machineOff = be16(b, 0);
  const versOff = be16(b, 2);
  const uamOff = be16(b, 4);
  const flags = be16(b, 8);
  let o = 10;
  const nameLen = b[o] ?? 0;
  const serverName = decodeMacRoman(b.subarray(o + 1, o + 1 + nameLen));
  const versions = readPList(b, versOff);
  const uams = readPList(b, uamOff);
  void machineOff;
  return { serverName, versions, uams, flags };
}

/** FPGetSrvrMsg request: cmd(1) pad(1) messageType(2) bitmap(2). */
export function getSrvrMsg(messageType: number, bitmap = C.SrvrMsgBitmapText): Uint8Array {
  const out: number[] = [C.CmdGetSrvrMsg, 0];
  appendBe16(out, messageType);
  appendBe16(out, bitmap);
  return new Uint8Array(out);
}

/** Reply: messageType(2) bitmap(2) PascalString(message). */
export function parseGetSrvrMsg(b: Uint8Array): { messageType: number; bitmap: number; text: string } {
  if (b.length < 4) return { messageType: 0, bitmap: 0, text: '' };
  const messageType = be16(b, 0);
  const bitmap = be16(b, 2);
  if (b.length < 5) return { messageType, bitmap, text: '' };
  const n = b[4]!;
  const text = decodeMacRoman(b.subarray(5, 5 + Math.min(n, b.length - 5)));
  return { messageType, bitmap, text };
}

function readPList(b: Uint8Array, off: number): string[] {
  if (off <= 0 || off >= b.length) return [];
  const count = b[off]!;
  let o = off + 1;
  const out: string[] = [];
  for (let i = 0; i < count && o < b.length; i++) {
    const len = b[o++]!;
    out.push(decodeMacRoman(b.subarray(o, o + len)));
    o += len;
  }
  return out;
}

export const DEFAULT_FILE_BITMAP =
  C.FDBitmapAttributes |
  C.FDBitmapParentDID |
  C.FDBitmapCreateDate |
  C.FDBitmapModDate |
  C.FDBitmapFinderInfo |
  C.FDBitmapLongName |
  C.FileBitmapFileNum |
  C.FileBitmapDataForkLen |
  C.FileBitmapRsrcForkLen;

export const DEFAULT_DIR_BITMAP =
  C.FDBitmapAttributes |
  C.FDBitmapParentDID |
  C.FDBitmapCreateDate |
  C.FDBitmapModDate |
  C.FDBitmapFinderInfo |
  C.FDBitmapLongName |
  C.DirBitmapDirID |
  C.DirBitmapOffspring;
