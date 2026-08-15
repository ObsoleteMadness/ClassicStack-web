/** MacBinary I/II/III decoder (and encoder for tests). */

import { be16, be32, writeBe16, writeBe32 } from '../protocol/binary';
import { crc16Ccitt } from '../protocol/crc16';
import { decodeMacRoman, encodeMacRoman } from '../protocol/macroman';
import { makeFinderInfo, ostypeFromBytes, type MacFile } from './mac-file';

const HEADER = 128;
const MBII_VERSION = 129;
const MBIII_VERSION = 130;
const MBIN = 0x6d42494e; // 'mBIN'

function forkPad(n: number): number {
  return n === 0 ? 0 : (HEADER - (n % HEADER)) % HEADER;
}

export function parseMacBinary(data: Uint8Array): MacFile | null {
  if (data.length < HEADER) return null;
  if (data[0] !== 0) return null;
  const nameLen = data[1]!;
  if (nameLen < 1 || nameLen > 63) return null;
  if (data[74] !== 0 || data[82] !== 0) return null;

  const dataLen = be32(data, 83);
  const rsrcLen = be32(data, 87);
  if (dataLen > 0x7fffffff || rsrcLen > 0x7fffffff) return null;

  const dataOff = HEADER;
  const rsrcOff = dataOff + dataLen + forkPad(dataLen);
  if (rsrcOff + rsrcLen > data.length) return null;

  const version = data[122]!;
  const storedCrc = be16(data, 124);
  const computedCrc = crc16Ccitt(data.subarray(0, 124));
  if (version === MBII_VERSION || version === MBIII_VERSION) {
    if (storedCrc !== computedCrc) return null;
  } else if (version === 0) {
    if (storedCrc !== 0 && storedCrc !== computedCrc) return null;
    const expected = rsrcOff + rsrcLen + forkPad(rsrcLen);
    if (data.length < expected - forkPad(rsrcLen) || data.length > expected + HEADER) return null;
  } else {
    return null;
  }

  const name = decodeMacRoman(data.subarray(2, 2 + nameLen));
  if (!name || name.includes(':') || name.includes('/')) return null;

  const flags = ((data[73]! << 8) | (version >= MBII_VERSION ? data[101]! : 0)) & 0xffff;
  const finderInfo = makeFinderInfo(
    ostypeFromBytes(data, 65),
    ostypeFromBytes(data, 69),
    flags,
    be16(data, 75),
    be16(data, 77),
    be16(data, 79),
  );
  if (version >= MBIII_VERSION && be32(data, 102) === MBIN) {
    finderInfo[24] = data[106]!;
    finderInfo[25] = data[107]!;
  }

  return {
    name,
    data: data.subarray(dataOff, dataOff + dataLen).slice(),
    resource: data.subarray(rsrcOff, rsrcOff + rsrcLen).slice(),
    finderInfo,
    createDate: be32(data, 91),
    modDate: be32(data, 95),
  };
}

export function buildMacBinary(file: MacFile, version: 129 | 130 = MBII_VERSION): Uint8Array {
  const nameBytes = encodeMacRoman(file.name).subarray(0, 63);
  const dataLen = file.data.length;
  const rsrcLen = file.resource.length;
  const dataPad = forkPad(dataLen);
  const rsrcPad = forkPad(rsrcLen);
  const out = new Uint8Array(HEADER + dataLen + dataPad + rsrcLen + rsrcPad);

  out[1] = nameBytes.length;
  out.set(nameBytes, 2);
  out.set(file.finderInfo.subarray(0, 4), 65);
  out.set(file.finderInfo.subarray(4, 8), 69);
  out[73] = file.finderInfo[8]!;
  writeBe16(out, 75, be16(file.finderInfo, 10));
  writeBe16(out, 77, be16(file.finderInfo, 12));
  writeBe16(out, 79, be16(file.finderInfo, 14));
  writeBe32(out, 83, dataLen);
  writeBe32(out, 87, rsrcLen);
  writeBe32(out, 91, file.createDate ?? 0);
  writeBe32(out, 95, file.modDate ?? 0);
  out[101] = file.finderInfo[9]!;
  if (version === MBIII_VERSION) {
    writeBe32(out, 102, MBIN);
    out[106] = file.finderInfo[24]!;
    out[107] = file.finderInfo[25]!;
  }
  out[122] = version;
  out[123] = MBII_VERSION;
  writeBe16(out, 124, crc16Ccitt(out.subarray(0, 124)));

  out.set(file.data, HEADER);
  out.set(file.resource, HEADER + dataLen + dataPad);
  return out;
}
