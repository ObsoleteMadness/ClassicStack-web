import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc16BinHex, crc16Ccitt, crc16Ibm } from '../protocol/crc16';
import { be16, writeBe16 } from '../protocol/binary';
import { buildBinHex, parseBinHex } from './binhex';
import {
  expandArchiveFile,
  expandFailureMessage,
  expandIncoming,
  isExpandableArchive,
  isStuffItArchive,
} from './expand-incoming';
import { makeFinderInfo } from './mac-file';
import { buildMacBinary, parseMacBinary } from './macbinary';
import { SitError } from './stuffit-codec';
import { buildClassicStore } from './stuffit';

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

const sample = {
  name: 'Read Me',
  data: ascii('Hello, Macintosh!\r'),
  resource: Uint8Array.from([0x00, 0x01, 0x02, 0x90, 0x90, 0x00, 0xff]),
  finderInfo: makeFinderInfo('TEXT', 'ttxt', 0x0100),
  createDate: 0xb3d2a000,
  modDate: 0xb3d2b000,
};

describe('crc16Ccitt', () => {
  it('matches CRC-16/XMODEM of 123456789', () => {
    expect(crc16Ccitt(ascii('123456789'))).toBe(0x31c3);
  });
});

describe('crc16BinHex', () => {
  it('matches Convert::BinHex binhex_crc of a known string', () => {
    // Convert::BinHex t/crc.t — HQX CRC, without the trailing two 0x00 bytes.
    expect(crc16BinHex(ascii('U1SBdxdMHpA2wlW3TOgUHXZ00jvHnkyU/ndXnr9RMElXdQXUAGYrPpf4F8jO'))).toBe(
      35360,
    );
  });

  it('shifts data bits into the LSB, unlike XMODEM', () => {
    expect(crc16BinHex(Uint8Array.of(0x01))).toBe(0x0001);
    expect(crc16Ccitt(Uint8Array.of(0x01))).toBe(0x1021);
  });
});

describe('macbinary', () => {
  it('round-trips name, forks, and Finder info', () => {
    const packed = buildMacBinary(sample);
    expect(packed.length % 128).toBe(0);
    expect(be16(packed, 124)).toBe(crc16Ccitt(packed.subarray(0, 124)));
    const parsed = parseMacBinary(packed);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Read Me');
    expect([...parsed!.data]).toEqual([...sample.data]);
    expect([...parsed!.resource]).toEqual([...sample.resource]);
    expect(String.fromCharCode(...parsed!.finderInfo.subarray(0, 4))).toBe('TEXT');
    expect(String.fromCharCode(...parsed!.finderInfo.subarray(4, 8))).toBe('ttxt');
    expect(be16(parsed!.finderInfo, 8)).toBe(0x0100);
  });

  it('round-trips Mac dates', () => {
    const packed = buildMacBinary({ ...sample, createDate: 0xb3d2a000, modDate: 0xb3d2b000 });
    const parsed = parseMacBinary(packed);
    expect(parsed?.createDate).toBe(0xb3d2a000);
    expect(parsed?.modDate).toBe(0xb3d2b000);
  });

  it('round-trips MacBinary III', () => {
    const packed = buildMacBinary(sample, 130);
    expect(String.fromCharCode(...packed.subarray(102, 106))).toBe('mBIN');
    expect(parseMacBinary(packed)?.name).toBe('Read Me');
  });

  it('rejects a truncated or CRC-corrupt header', () => {
    const packed = buildMacBinary(sample);
    expect(parseMacBinary(packed.subarray(0, 100))).toBeNull();
    packed[10] ^= 0xff;
    expect(parseMacBinary(packed)).toBeNull();
  });

  it('does not treat a random .bin as MacBinary', () => {
    expect(parseMacBinary(ascii('MZ\x90\x00this is not macbinary at all'))).toBeNull();
  });
});

describe('binhex', () => {
  it('round-trips through BinHex 4.0 with RLE of 0x90', () => {
    const packed = buildBinHex(sample);
    const text = String.fromCharCode(...packed);
    expect(text).toContain('BinHex 4.0');
    const parsed = parseBinHex(packed);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Read Me');
    expect([...parsed!.data]).toEqual([...sample.data]);
    expect([...parsed!.resource]).toEqual([...sample.resource]);
    expect(String.fromCharCode(...parsed!.finderInfo.subarray(0, 8))).toBe('TEXTttxt');
  });

  it('skips a mail header before the BinHex banner', () => {
    const body = buildBinHex(sample);
    const prefix = ascii('From: me@example.com\r\nSubject: file\r\n\r\n');
    const mixed = new Uint8Array(prefix.length + body.length);
    mixed.set(prefix);
    mixed.set(body, prefix.length);
    expect(parseBinHex(mixed)?.name).toBe('Read Me');
  });

  it('rejects non-BinHex text', () => {
    expect(parseBinHex(ascii('just a readme\nwith a colon: here\n'))).toBeNull();
  });

  it('decodes a real StuffIt-era HQX (Convert::BinHex eyeball.gif.hqx)', () => {
    const packed = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'testdata/eyeball.gif.hqx')),
    );
    const parsed = parseBinHex(packed);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('eyeball.gif');
    expect(String.fromCharCode(...parsed!.finderInfo.subarray(0, 8))).toBe('????????');
    expect(parsed!.data.length).toBeGreaterThan(0);
    expect(parsed!.data[0]).toBe(0x47); // GIF
    expect(parsed!.data[1]).toBe(0x49);
    expect(parsed!.resource.length).toBe(0);
  });
});

describe('expandIncoming', () => {
  it('unwraps BinHex then MacBinary', () => {
    const mb = buildMacBinary(sample);
    const hqx = buildBinHex({
      name: 'Read Me.bin',
      data: mb,
      resource: new Uint8Array(),
      finderInfo: makeFinderInfo('BINA', 'SITx'),
    });
    const out = expandIncoming('Read Me.bin.hqx', hqx);
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ kind: 'file', name: 'Read Me' });
    if (out![0]!.kind !== 'file') throw new Error('expected file');
    expect([...out![0].data]).toEqual([...sample.data]);
    expect([...out![0].resource]).toEqual([...sample.resource]);
    expect(out![0].createDate).toBe(sample.createDate);
    expect(out![0].modDate).toBe(sample.modDate);
  });

  it('unwraps BinHex of MacBinary even when the MacBinary has a resource fork', () => {
    const mb = buildMacBinary(sample);
    const hqx = buildBinHex({
      name: 'Read Me.bin',
      data: mb,
      resource: Uint8Array.of(0xff),
      finderInfo: makeFinderInfo('BINA', 'SITx'),
    });
    const out = expandIncoming('Read Me.bin.hqx', hqx);
    expect(out).toHaveLength(1);
    if (out![0]!.kind !== 'file') throw new Error('expected file');
    expect(out![0].name).toBe('Read Me');
    expect([...out![0].data]).toEqual([...sample.data]);
    expect([...out![0].resource]).toEqual([...sample.resource]);
  });

  it('leaves a truncated StuffIt header packed', () => {
    const sit = new Uint8Array(64);
    sit.set(ascii('SIT!'), 0);
    expect(isStuffItArchive(sit)).toBe(true);
    expect(expandIncoming('Disk Copy.sit', sit)).toBeNull();
  });

  it('still unwraps BinHex around an unreadable StuffIt stub', () => {
    const sit = new Uint8Array(64);
    sit.set(ascii('SIT!'), 0);
    const hqx = buildBinHex({
      name: 'Disk Copy.sit',
      data: sit,
      resource: new Uint8Array(),
      finderInfo: makeFinderInfo('SIT!', 'SITx'),
    });
    const out = expandIncoming('Disk Copy.sit.hqx', hqx);
    expect(out).toHaveLength(1);
    if (out![0]!.kind !== 'file') throw new Error('expected file');
    expect(out![0].name).toBe('Disk Copy.sit');
    expect([...out![0].data]).toEqual([...sit]);
  });

  it('returns null for ordinary files', () => {
    expect(expandIncoming('notes.txt', ascii('hello'))).toBeNull();
  });
});

describe('isExpandableArchive', () => {
  it('matches .sit / .hqx / .bin / .zip names, StuffIt types, ZIP, and BinHex TEXT/SITx', () => {
    expect(isExpandableArchive('Disk Copy.sit')).toBe(true);
    expect(isExpandableArchive('Read Me.bin.hqx')).toBe(true);
    expect(isExpandableArchive('Read Me.bin')).toBe(true);
    expect(isExpandableArchive('Archive.zip')).toBe(true);
    expect(isExpandableArchive('Read Me', makeFinderInfo('SIT!', 'SITx'))).toBe(true);
    expect(isExpandableArchive('Archive', makeFinderInfo('ZIP ', 'SITx'))).toBe(true);
    expect(isExpandableArchive('Archive', makeFinderInfo('TEXT', 'SITx'))).toBe(true);
    expect(isExpandableArchive('Read Me', makeFinderInfo('TEXT', 'ttxt'))).toBe(false);
    expect(isExpandableArchive('notes.txt')).toBe(false);
  });
});

describe('expandFailureMessage', () => {
  it('says the archive is corrupted when there is no codec/version error', () => {
    expect(expandFailureMessage()).toBe('This archive appears to be corrupted.');
    expect(expandFailureMessage(new SitError('This archive appears to be corrupted.', 'corrupt'))).toBe(
      'This archive appears to be corrupted.',
    );
  });

  it('passes through unsupported type/version from the archive header', () => {
    expect(expandFailureMessage(new SitError('Unsupported type 5', 'unsupported'))).toBe('Unsupported type 5');
    expect(expandFailureMessage(new SitError('Unsupported type SITD', 'unsupported'))).toBe(
      'Unsupported type SITD',
    );
  });
});

describe('expandArchiveFile', () => {
  it('unwraps BinHex and MacBinary the same way drop-import does', () => {
    const mb = buildMacBinary(sample);
    const fromBin = expandArchiveFile('Read Me.bin', mb);
    expect(fromBin).toHaveLength(1);
    expect(fromBin[0]).toMatchObject({ kind: 'file', name: 'Read Me' });
    if (fromBin[0]!.kind !== 'file') throw new Error('expected file');
    expect([...fromBin[0].data]).toEqual([...sample.data]);
    expect([...fromBin[0].resource]).toEqual([...sample.resource]);

    const hqx = buildBinHex({
      name: 'Read Me.bin',
      data: mb,
      resource: new Uint8Array(),
      finderInfo: makeFinderInfo('BINA', 'SITx'),
    });
    const fromHqx = expandArchiveFile('Read Me.bin.hqx', hqx);
    expect(fromHqx).toHaveLength(1);
    if (fromHqx[0]!.kind !== 'file') throw new Error('expected file');
    expect(fromHqx[0].name).toBe('Read Me');
    expect([...fromHqx[0].data]).toEqual([...sample.data]);
    expect([...fromHqx[0].resource]).toEqual([...sample.resource]);
  });

  it('unwraps BinHex around an unreadable StuffIt stub instead of treating it as a failed .sit', () => {
    const sit = new Uint8Array(64);
    sit.set(ascii('SIT!'), 0);
    const hqx = buildBinHex({
      name: 'Disk Copy.sit',
      data: sit,
      resource: new Uint8Array(),
      finderInfo: makeFinderInfo('SIT!', 'SITx'),
    });
    const out = expandArchiveFile('Disk Copy.sit.hqx', hqx);
    expect(out).toHaveLength(1);
    if (out[0]!.kind !== 'file') throw new Error('expected file');
    expect(out[0].name).toBe('Disk Copy.sit');
    expect([...out[0].data]).toEqual([...sit]);
  });

  it('says a truncated BinHex or MacBinary is corrupted, not an unsupported StuffIt type', () => {
    expect(() => expandArchiveFile('Read Me.hqx', ascii('not binhex at all'))).toThrow(SitError);
    try {
      expandArchiveFile('Read Me.hqx', ascii('not binhex at all'));
    } catch (err) {
      expect((err as SitError).code).toBe('corrupt');
      expect((err as SitError).message).toBe('This archive appears to be corrupted.');
    }
    expect(() => expandArchiveFile('Read Me.bin', ascii('MZ\x90\x00not macbinary'))).toThrowError(
      /This archive appears to be corrupted/,
    );
  });

  it('does not report Finder type SIT! for a truncated classic archive', () => {
    const sit = new Uint8Array(64);
    sit.set(ascii('SIT!'), 0);
    expect(() => expandArchiveFile('Disk Copy.sit', sit)).toThrow(SitError);
    try {
      expandArchiveFile('Disk Copy.sit', sit);
    } catch (err) {
      expect(err).toBeInstanceOf(SitError);
      expect((err as SitError).code).toBe('corrupt');
      expect((err as SitError).message).toBe('This archive appears to be corrupted.');
      expect((err as SitError).message).not.toMatch(/SIT!/);
    }
  });

  it('reports unsupported type from the archive magic, not Finder info', () => {
    const sitd = new Uint8Array(64);
    sitd.set(ascii('SITD'), 0);
    expect(() => expandArchiveFile('Archive.sit', sitd)).toThrowError(/Unsupported type SITD/);
  });

  it('reports StuffIt X signature from the file header', () => {
    const sitx = new Uint8Array(64);
    sitx.set(ascii('StuffIt!'), 0);
    expect(() => expandArchiveFile('Archive.sit', sitx)).toThrowError(/Unsupported type StuffIt!/);
  });

  it('reports an unsupported StuffIt 5 version from the archive header', () => {
    const sit5 = new Uint8Array(83);
    sit5.set(ascii('StuffIt (c)1997-'), 0);
    sit5[82] = 6;
    expect(() => expandArchiveFile('Archive.sit', sit5)).toThrowError(/Unsupported type 6/);
  });

  it('throws Unsupported type {method} for an unknown classic method', () => {
    const packed = buildClassicStore([{ name: 'Notes', data: ascii('hi') }]);
    packed[23] = 5;
    writeBe16(packed, 22 + 110, crc16Ibm(packed.subarray(22, 22 + 110)));
    expect(() => expandArchiveFile('Notes.sit', packed)).toThrowError(/Unsupported type 5/);
  });
});

describe('unsupported StuffIt compression', () => {
  it('throws Unsupported type {method} for an unknown classic method', () => {
    const packed = buildClassicStore([{ name: 'Notes', data: ascii('hi') }]);
    packed[23] = 5;
    writeBe16(packed, 22 + 110, crc16Ibm(packed.subarray(22, 22 + 110)));
    expect(() => expandIncoming('Notes.sit', packed)).toThrowError(/Unsupported type 5/);
  });
});
