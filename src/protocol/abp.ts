/**
 * AppleTalk Boot Protocol (ABP) + ChainBoot EBP codecs.
 * Port of ClassicStack core/protocol/abp (Elliot Nunn / Apple SuperMario).
 */

import { appendBe16, appendBe32, be16, be32 } from './binary';

export const DDPType = 10;
export const ClientSocket = 10;
export const Version = 1;
export const MachineMac = 1;
export const DiskSector = 512;
export const BitmapSize = 512;
export const MaxImageBlocks = (BitmapSize - 1) * 8;
export const DDPMaxData = 586;
export const UserNameLength = 34;
export const UserRecordLength = 568;

export const CmdNullCommand = 0;
export const CmdUserRecordRequest = 1;
export const CmdUserRecordReply = 2;
export const CmdBootImageRequest = 3;
export const CmdBootImageReply = 4;
export const CmdImageDone = 5;
export const CmdUserRecordUpdate = 6;
export const CmdUserUpdateReply = 7;

export const CmdChainRead = 128;
export const CmdChainReadData = 129;
export const CmdChainWrite = 130;
export const CmdChainWriteAck = 131;

export const ChainBlockSize = 512;
export const ChunkBlocks = 32;
export const ChainLastFlag = 0x80;

export class AbpError extends Error {
  constructor(
    message: string,
    readonly code: 'short' | 'command' | 'version',
  ) {
    super(message);
    this.name = 'AbpError';
  }
}

export function command(b: Uint8Array): number {
  return b.length === 0 ? 0 : b[0]!;
}

function checkHeader(b: Uint8Array, cmd: number): void {
  if (b.length < 2) throw new AbpError('abp: packet too short', 'short');
  if (b[0] !== cmd) throw new AbpError('abp: unexpected command byte', 'command');
  if (b[1]! > Version) throw new AbpError('abp: unsupported protocol version', 'version');
}

const userRecordRequestLen = 2 + 2 + 4 + UserNameLength;

export interface UserRecordRequest {
  machineID: number;
  timestamp: number;
  userName: Uint8Array;
}

export function unmarshalUserRecordRequest(b: Uint8Array): UserRecordRequest {
  checkHeader(b, CmdUserRecordRequest);
  if (b.length < userRecordRequestLen) throw new AbpError('abp: packet too short', 'short');
  const n = Math.min(b[8]!, UserNameLength - 1);
  return {
    machineID: be16(b, 2),
    timestamp: be32(b, 4),
    userName: b.subarray(9, 9 + n),
  };
}

export function marshalUserRecordRequest(r: UserRecordRequest): Uint8Array {
  const out: number[] = [CmdUserRecordRequest, Version];
  appendBe16(out, r.machineID);
  appendBe32(out, r.timestamp);
  let name = r.userName;
  if (name.length > UserNameLength - 1) name = name.subarray(0, UserNameLength - 1);
  out.push(name.length, ...name);
  while (out.length < userRecordRequestLen) out.push(0);
  return new Uint8Array(out);
}

export interface BootPktRply {
  osID: number;
  userData: number;
  blockSize: number;
  imageID: number;
  result: number;
  imageSize: number;
}

export function marshalBootPktRply(r: BootPktRply): Uint8Array {
  const out: number[] = [CmdUserRecordReply, Version];
  appendBe16(out, r.osID);
  appendBe32(out, r.userData);
  appendBe16(out, r.blockSize);
  appendBe16(out, r.imageID);
  appendBe16(out, r.result & 0xffff);
  appendBe32(out, r.imageSize);
  const buf = new Uint8Array(DDPMaxData);
  buf.set(out);
  return buf;
}

export function unmarshalBootPktRply(b: Uint8Array): BootPktRply {
  checkHeader(b, CmdUserRecordReply);
  if (b.length < 18) throw new AbpError('abp: packet too short', 'short');
  const resultRaw = be16(b, 12);
  return {
    osID: be16(b, 2),
    userData: be32(b, 4),
    blockSize: be16(b, 8),
    imageID: be16(b, 10),
    result: resultRaw > 0x7fff ? resultRaw - 0x10000 : resultRaw,
    imageSize: be32(b, 14),
  };
}

export interface BootImageRequest {
  imageID: number;
  section: number;
  flags: number;
  replyDelay: number;
  bitmap: Uint8Array;
}

export function unmarshalBootImageRequest(b: Uint8Array): BootImageRequest {
  checkHeader(b, CmdBootImageRequest);
  if (b.length < 8) throw new AbpError('abp: packet too short', 'short');
  return {
    imageID: be16(b, 2),
    section: b[4]!,
    flags: b[5]!,
    replyDelay: be16(b, 6),
    bitmap: b.subarray(8),
  };
}

export function marshalBootImageRequest(r: BootImageRequest): Uint8Array {
  const out: number[] = [CmdBootImageRequest, Version];
  appendBe16(out, r.imageID);
  out.push(r.section, r.flags);
  appendBe16(out, r.replyDelay);
  out.push(...r.bitmap);
  return new Uint8Array(out);
}

export interface BootBlock {
  imageID: number;
  blockNo: number;
  data: Uint8Array;
}

export function marshalBootBlock(r: BootBlock): Uint8Array {
  const out = new Uint8Array(6 + r.data.length);
  out[0] = CmdBootImageReply;
  out[1] = Version;
  out[2] = (r.imageID >>> 8) & 0xff;
  out[3] = r.imageID & 0xff;
  out[4] = (r.blockNo >>> 8) & 0xff;
  out[5] = r.blockNo & 0xff;
  out.set(r.data, 6);
  return out;
}

export function unmarshalBootBlock(b: Uint8Array): BootBlock {
  checkHeader(b, CmdBootImageReply);
  if (b.length < 6) throw new AbpError('abp: packet too short', 'short');
  return {
    imageID: be16(b, 2),
    blockNo: be16(b, 4),
    data: b.subarray(6),
  };
}

export interface ChainReadRequest {
  seq: number;
  imageNum: number;
  blockOffset: number;
  blockCount: number;
}

export function unmarshalChainReadRequest(b: Uint8Array): ChainReadRequest {
  if (b.length < 16) throw new AbpError('abp: packet too short', 'short');
  if (b[0] !== CmdChainRead) throw new AbpError('abp: unexpected command byte', 'command');
  return {
    seq: be16(b, 2),
    imageNum: be32(b, 4),
    blockOffset: be32(b, 8),
    blockCount: be32(b, 12),
  };
}

export function marshalChainReadRequest(r: ChainReadRequest): Uint8Array {
  const out: number[] = [CmdChainRead, 0];
  appendBe16(out, r.seq);
  appendBe32(out, r.imageNum);
  appendBe32(out, r.blockOffset);
  appendBe32(out, r.blockCount);
  return new Uint8Array(out);
}

export interface ChainReadData {
  blkIndex: number;
  seq: number;
  data: Uint8Array;
}

export function marshalChainReadData(r: ChainReadData): Uint8Array {
  const out = new Uint8Array(4 + r.data.length);
  out[0] = CmdChainReadData;
  out[1] = r.blkIndex;
  out[2] = (r.seq >>> 8) & 0xff;
  out[3] = r.seq & 0xff;
  out.set(r.data, 4);
  return out;
}

export function unmarshalChainReadData(b: Uint8Array): ChainReadData {
  if (b.length < 4) throw new AbpError('abp: packet too short', 'short');
  if (b[0] !== CmdChainReadData) throw new AbpError('abp: unexpected command byte', 'command');
  return {
    blkIndex: b[1]!,
    seq: be16(b, 2),
    data: b.subarray(4),
  };
}

export interface ChainWriteBlock {
  blkIndex: number;
  seq: number;
  imageNum: number;
  hunkStart: number;
  data: Uint8Array;
}

export function unmarshalChainWriteBlock(b: Uint8Array): ChainWriteBlock {
  if (b.length < 12) throw new AbpError('abp: packet too short', 'short');
  if (b[0] !== CmdChainWrite) throw new AbpError('abp: unexpected command byte', 'command');
  return {
    blkIndex: b[1]!,
    seq: be16(b, 2),
    imageNum: be32(b, 4),
    hunkStart: be32(b, 8),
    data: b.subarray(12),
  };
}

export function marshalChainWriteBlock(r: ChainWriteBlock): Uint8Array {
  const out = new Uint8Array(12 + r.data.length);
  out[0] = CmdChainWrite;
  out[1] = r.blkIndex;
  out[2] = (r.seq >>> 8) & 0xff;
  out[3] = r.seq & 0xff;
  out[4] = (r.imageNum >>> 24) & 0xff;
  out[5] = (r.imageNum >>> 16) & 0xff;
  out[6] = (r.imageNum >>> 8) & 0xff;
  out[7] = r.imageNum & 0xff;
  out[8] = (r.hunkStart >>> 24) & 0xff;
  out[9] = (r.hunkStart >>> 16) & 0xff;
  out[10] = (r.hunkStart >>> 8) & 0xff;
  out[11] = r.hunkStart & 0xff;
  out.set(r.data, 12);
  return out;
}

export interface ChainWriteAck {
  seq: number;
}

export function marshalChainWriteAck(r: ChainWriteAck): Uint8Array {
  const out: number[] = [CmdChainWriteAck, 0];
  appendBe16(out, r.seq);
  return new Uint8Array(out);
}

export function unmarshalChainWriteAck(b: Uint8Array): ChainWriteAck {
  if (b.length < 4) throw new AbpError('abp: packet too short', 'short');
  if (b[0] !== CmdChainWriteAck) throw new AbpError('abp: unexpected command byte', 'command');
  return { seq: be16(b, 2) };
}
