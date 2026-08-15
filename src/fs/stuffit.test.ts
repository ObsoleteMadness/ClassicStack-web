import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc16Ibm } from '../protocol/crc16';
import { writeBe16 } from '../protocol/binary';
import { BitReader, decompressSit13, SitError } from './stuffit-codec';
import { buildClassicStore, isStuffItArchive, parseStuffIt, sitUnsupportedTypeCode } from './stuffit';
import { expandArchiveFile, expandIncoming, isExpandableArchive } from './expand-incoming';
import { buildBinHex } from './binhex';
import { makeFinderInfo } from './mac-file';
import { buildMacBinary } from './macbinary';

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

describe('crc16Ibm', () => {
  it('matches CRC-16/IBM of known vectors', () => {
    expect(crc16Ibm(ascii(''))).toBe(0x0000);
    expect(crc16Ibm(ascii('123456789'))).toBe(0xbb3d);
    expect(crc16Ibm(ascii('Hello World\n'))).toBe(0x48fe);
  });
});

describe('BitReader', () => {
  it('zero-extends unchecked reads past the stream', () => {
    const reader = new BitReader(Uint8Array.of(0b1010_0101));
    expect(reader.readBitsLe(8)).toBe(0b1010_0101);
    expect(reader.readBitsLe(1)).toBe(0);
    expect(reader.readBitsLe(15)).toBe(0);
  });
});

describe('Sit13', () => {
  it('zero-extends a terminal stream', () => {
    expect([...decompressSit13(Uint8Array.of(0x10), 4)]).toEqual([0, 0, 0, 0]);
  });

  it('rejects a missing header', () => {
    expect(() => decompressSit13(new Uint8Array(), 1)).toThrow(/SIT13/);
  });
});

describe('classic StuffIt store', () => {
  it('round-trips a text file and resource fork', () => {
    const packed = buildClassicStore([
      {
        name: 'Read Me',
        data: ascii('Hello, Macintosh!\r'),
        resource: Uint8Array.of(0xde, 0xad),
        type: 'TEXT',
        creator: 'ttxt',
        flags: 0x0100,
        createDate: 0xb3d2a000,
        modDate: 0xb3d2b000,
      },
    ]);
    expect(isStuffItArchive(packed)).toBe(true);
    const entries = parseStuffIt(packed);
    expect(entries).toHaveLength(1);
    expect(entries![0]!.name).toBe('Read Me');
    expect([...entries![0]!.data]).toEqual([...ascii('Hello, Macintosh!\r')]);
    expect([...entries![0]!.resource]).toEqual([0xde, 0xad]);
    expect(entries![0]!.fileType).toBe('TEXT');
    expect(entries![0]!.creator).toBe('ttxt');
    expect(entries![0]!.finderFlags).toBe(0x0100);
    expect(entries![0]!.createDate).toBe(0xb3d2a000);
    expect(entries![0]!.modDate).toBe(0xb3d2b000);
  });

  it('expands a dropped .sit into catalog items', () => {
    const packed = buildClassicStore([
      { name: 'Notes', data: ascii('hi') },
      { name: 'App', data: Uint8Array.of(1, 2, 3), type: 'APPL', creator: 'CARO' },
    ]);
    const out = expandIncoming('Stuff.sit', packed);
    expect(out?.map((n) => n.name).sort()).toEqual(['App', 'Notes']);
    const notes = out!.find((n) => n.name === 'Notes');
    expect(notes?.kind).toBe('file');
    if (notes?.kind === 'file') expect([...notes.data]).toEqual([...ascii('hi')]);
  });

  it('parses classic archives whose header magic is ST50', () => {
    const packed = buildClassicStore([{ name: 'Notes', data: ascii('hi') }]);
    packed[0] = 0x53;
    packed[1] = 0x54;
    packed[2] = 0x35;
    packed[3] = 0x30; // ST50
    const entries = parseStuffIt(packed);
    expect(entries?.[0]?.name).toBe('Notes');
  });

  it('parses installer archives whose header magic is ST42', () => {
    const packed = buildClassicStore([{ name: 'Notes', data: ascii('hi') }]);
    packed[0] = 0x53;
    packed[1] = 0x54;
    packed[2] = 0x34;
    packed[3] = 0x32; // ST42
    expect(isStuffItArchive(packed)).toBe(true);
    const entries = parseStuffIt(packed);
    expect(entries?.[0]?.name).toBe('Notes');
    expect([...entries![0]!.data]).toEqual([...ascii('hi')]);
  });

  it('unwraps BinHex around a real StuffIt archive', () => {
    const packed = buildClassicStore([{ name: 'Inside', data: ascii('payload') }]);
    const hqx = buildBinHex({
      name: 'Stuff.sit',
      data: packed,
      resource: new Uint8Array(),
      finderInfo: makeFinderInfo('SIT!', 'SITx'),
    });
    const out = expandIncoming('Stuff.sit.hqx', hqx);
    expect(out).toHaveLength(1);
    expect(out![0]!.name).toBe('Inside');
    if (out![0]!.kind === 'file') expect([...out![0].data]).toEqual([...ascii('payload')]);
  });

  it('unwraps BinHex of MacBinary of StuffIt, including an archive icon resource', () => {
    const packed = buildClassicStore([
      { name: 'Notes', data: ascii('hi') },
      { name: 'App', data: Uint8Array.of(1, 2, 3), type: 'APPL', creator: 'CARO' },
    ]);
    const mb = buildMacBinary({
      name: 'Stuff.sit',
      data: packed,
      resource: Uint8Array.of(0x00, 0x01, 0x02),
      finderInfo: makeFinderInfo('SIT!', 'SITx'),
    });
    const hqx = buildBinHex({
      name: 'Stuff.sit',
      data: mb,
      resource: new Uint8Array(),
      finderInfo: makeFinderInfo('BINA', 'SITx'),
    });
    const out = expandIncoming('Stuff.sit.hqx', hqx);
    expect(out?.map((n) => n.name).sort()).toEqual(['App', 'Notes']);
  });

  it('keeps expanding a StuffIt member that is itself BinHex of StuffIt', () => {
    const inner = buildClassicStore([
      { name: 'Read Me', data: ascii('hello') },
      { name: 'App', data: Uint8Array.of(9), type: 'APPL', creator: 'CARO' },
    ]);
    const hqx = buildBinHex({
      name: 'Disk.sit',
      data: inner,
      resource: Uint8Array.of(0xca, 0xfe),
      finderInfo: makeFinderInfo('SIT!', 'SITx'),
    });
    const outer = buildClassicStore([{ name: 'Disk.sit.hqx', data: hqx }]);
    const out = expandIncoming('Outer.sit', outer);
    expect(out?.map((n) => n.name).sort()).toEqual(['App', 'Read Me']);
    const readme = out!.find((n) => n.name === 'Read Me');
    if (readme?.kind === 'file') expect([...readme.data]).toEqual([...ascii('hello')]);
  });

  it('rejects a classic archive whose stored fork CRC does not match', () => {
    const packed = buildClassicStore([{ name: 'Notes', data: ascii('hi') }]);
    packed[22 + 102] ^= 0xff;
    packed[22 + 103] ^= 0xff;
    writeBe16(packed, 22 + 110, crc16Ibm(packed.subarray(22, 22 + 110)));
    expect(() => parseStuffIt(packed)).toThrow(SitError);
  });
});

const testdata = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'testdata', name)));

// Real archives from https://github.com/ssokolow/stuffit-test-files (CC0).

const REAL_NAMES = ['Test Image', 'Test Text', 'testfile.PICT', 'testfile.jpg', 'testfile.png', 'testfile.txt'];

describe('real StuffIt archives', () => {
  it('expands StuffIt Expander 4.0.2.sit from the welcome pack', () => {
    const packed = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/welcome/Utilities/StuffIt Expander 4.0.2.sit')),
    );
    const entries = parseStuffIt(packed);
    expect(entries?.some((e) => e.isFolder && e.name === 'StuffIt Expander™ 4.0.2')).toBe(true);
    const app = entries?.find((e) => e.name.endsWith('StuffIt Expander™') && !e.isFolder);
    expect(app && !app.isFolder).toBe(true);
    if (app && !app.isFolder) {
      expect(app.fileType).toBe('APPL');
      expect(app.creator).toBe('SITx');
      expect(app.resource.length).toBe(212771);
      expect(crc16Ibm(app.resource)).toBe(0xd806);
    }
    const readme = entries?.find((e) => e.name.includes('Read Me') && !e.isFolder);
    if (readme && !readme.isFolder) {
      expect(crc16Ibm(readme.data)).toBe(0x605d);
      expect(String.fromCharCode(...readme.data.subarray(0, 7))).toBe('StuffIt');
      expect(isStuffItArchive(readme.data)).toBe(false);
      expect(sitUnsupportedTypeCode(readme.data)).toBeNull();
      expect(isExpandableArchive(readme.name, makeFinderInfo(readme.fileType, readme.creator), readme.data)).toBe(
        false,
      );
    }
    const regForm = entries?.find((e) => e.name.includes('Expander Reg. Form') && !e.isFolder);
    if (regForm && !regForm.isFolder) {
      expect(String.fromCharCode(...regForm.data.subarray(0, 7))).toBe('StuffIt');
      expect(regForm.data[82]).toBe(42);
      expect(isStuffItArchive(regForm.data)).toBe(false);
      expect(sitUnsupportedTypeCode(regForm.data)).toBeNull();
    }
    const expanded = expandArchiveFile('StuffIt Expander 4.0.2.sit', packed);
    expect(expanded.some((n) => n.kind === 'dir' && n.name.includes('StuffIt Expander'))).toBe(true);
  });

  const quickTimeSit = join(dirname(fileURLToPath(import.meta.url)), '../../public/welcome/Utilities/QuickTime 3.0.sit');
  it.skipIf(!existsSync(quickTimeSit))('expands a QuickTime installer archive (ST46, method 14)', () => {
    const packed = new Uint8Array(readFileSync(quickTimeSit));
    const entries = parseStuffIt(packed);
    const names = entries?.map((e) => e.name) ?? [];
    expect(names.some((n) => n.includes('Installer'))).toBe(true);
    const readme = entries?.find((e) => e.name.includes('READ ME') && !e.isFolder);
    expect(readme && !readme.isFolder).toBe(true);
    if (readme && !readme.isFolder) {
      expect(readme.data.length).toBe(4294);
      expect(readme.resource.length).toBe(4755);
      expect(readme.fileType).toBe('ttro');
    }
  });

  it('expands ResEdit.sit using classic method 2 (compress LZW)', () => {
    const packed = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../public/welcome/Utilities/ResEdit.sit')),
    );
    const entries = parseStuffIt(packed);
    expect(entries).toHaveLength(1);
    const app = entries![0]!;
    expect(app.name).toBe('ResEdit');
    expect(app.fileType).toBe('APPL');
    expect(app.resource.length).toBe(657523);
  });

  it('expands a StuffIt Deluxe 4.5 classic archive', () => {
    const entries = parseStuffIt(testdata('stuffit45.sit'));
    expect(entries?.map((e) => e.name).sort()).toEqual(REAL_NAMES);
    const text = entries!.find((e) => e.name === 'testfile.txt');
    expect(text && !text.isFolder).toBe(true);
    if (text && !text.isFolder) expect(text.data.length).toBeGreaterThan(0);
  });

  it('expands StuffIt 5 archives using header CRC of the full header with the CRC field cleared', () => {
    const mac = testdata('stuffit5-mac.sit');
    const win = testdata('stuffit5-win.sit');
    const macEntries = parseStuffIt(mac);
    const winEntries = parseStuffIt(win);
    expect(macEntries?.map((e) => e.name).sort()).toEqual(REAL_NAMES);
    expect(winEntries?.length).toBeGreaterThan(0);

    const first = mac.subarray(be32At(mac, 94));
    const headerSize = (first[6]! << 8) | first[7]!;
    const header = first.subarray(0, headerSize);
    const stored = (header[32]! << 8) | header[33]!;
    const cleared = new Uint8Array(header);
    cleared[32] = 0;
    cleared[33] = 0;
    expect(crc16Ibm(cleared)).toBe(stored);
    expect(crc16Ibm(header.subarray(0, 32))).not.toBe(stored);
  });
});

function be32At(data: Uint8Array, o: number): number {
  return ((data[o]! << 24) | (data[o + 1]! << 16) | (data[o + 2]! << 8) | data[o + 3]!) >>> 0;
}
