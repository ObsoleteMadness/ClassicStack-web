import { describe, it, expect } from 'vitest';
import * as C from './constants';
import { be16, writeBe16, writeBe32 } from '../binary';
import { encodeMacRoman, decodeMacRoman } from '../macroman';

/**
 * Pin FPGetFileDirParms reply framing against ClassicStack
 * (core/service/afp/models_test.go TestFPGetFileDirParmsRes_Header).
 *
 * Wire: FileBitmap(2) DirBitmap(2) type(1) pad(1) <params>
 */
function marshalGetFileDirParms(
  fileBitmap: number,
  dirBitmap: number,
  isDir: boolean,
  params: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(6 + params.length);
  writeBe16(out, 0, fileBitmap);
  writeBe16(out, 2, dirBitmap);
  out[4] = isDir ? 0x80 : 0;
  out[5] = 0;
  out.set(params, 6);
  return out;
}

/** Pack LongName-only params the ClassicStack way: offset(2) then trailing pstring. */
function packLongNameOnly(displayName: string): Uint8Array {
  const name = encodeMacRoman(displayName.slice(0, 31));
  const fixedSize = 2;
  const out: number[] = [];
  // offset from start of params → variable area
  out.push((fixedSize >>> 8) & 0xff, fixedSize & 0xff);
  out.push(name.length, ...name);
  return new Uint8Array(out);
}

/** ClassicStack enumEntry framing. */
function enumEntry(isDir: boolean, params: Uint8Array): Uint8Array {
  let len = 2 + params.length;
  if (len % 2) len++;
  const out = new Uint8Array(len);
  out[0] = len;
  out[1] = isDir ? 0x80 : 0;
  out.set(params, 2);
  return out;
}

describe('FPGetFileDirParms reply', () => {
  it('matches ClassicStack directory header golden', () => {
    const got = marshalGetFileDirParms(0x07fb, 0x0dff, true, new Uint8Array([0xaa]));
    expect([...got]).toEqual([0x07, 0xfb, 0x0d, 0xff, 0x80, 0x00, 0xaa]);
  });

  it('matches ClassicStack file header golden', () => {
    const got = marshalGetFileDirParms(0x07fb, 0x0dff, false, new Uint8Array([0xaa]));
    expect([...got]).toEqual([0x07, 0xfb, 0x0d, 0xff, 0x00, 0x00, 0xaa]);
  });

  it('packs AccessRights for dir bitmap 0x1000 (pcap mount probe)', () => {
    const params = new Uint8Array(4);
    writeBe32(params, 0, C.DirAccessRights);
    const got = marshalGetFileDirParms(0, C.DirBitmapAccessRights, true, params);
    expect([...got]).toEqual([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x87, 0x07, 0x07, 0x07]);
  });

  it('root LongName is the share/volume name via offset+Pascal', () => {
    const params = packLongNameOnly('Browser Share');
    expect(be16(params, 0)).toBe(2);
    const len = params[2]!;
    expect(decodeMacRoman(params.subarray(3, 3 + len))).toBe('Browser Share');
  });

  it('enum entry is [len][type][params] with name offset anchored at params', () => {
    const params = packLongNameOnly('hello.txt');
    const entry = enumEntry(false, params);
    expect(entry[0]).toBe(entry.length);
    expect(entry[1]).toBe(0x00);
    const nameOff = be16(entry, 2);
    expect(decodeMacRoman(entry.subarray(2 + nameOff + 1, 2 + nameOff + 1 + entry[2 + nameOff]!))).toBe(
      'hello.txt',
    );
  });

  it('SetFileDirParms FinderInfo skips preceding ModDate field', () => {
    const bitmap = C.FDBitmapModDate | C.FDBitmapFinderInfo;
    const params = new Uint8Array(4 + 32);
    writeBe32(params, 0, 0x12345678);
    params.set(encodeMacRoman('TEXTttxt'), 4);
    let o = 0;
    if (bitmap & C.FDBitmapAttributes) o += 2;
    if (bitmap & C.FDBitmapParentDID) o += 4;
    if (bitmap & C.FDBitmapCreateDate) o += 4;
    if (bitmap & C.FDBitmapModDate) o += 4;
    if (bitmap & C.FDBitmapBackupDate) o += 4;
    const fi = params.subarray(o, o + 32);
    expect(decodeMacRoman(fi.subarray(0, 8))).toBe('TEXTttxt');
  });
});
