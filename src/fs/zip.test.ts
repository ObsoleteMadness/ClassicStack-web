import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { buildAppleDouble, zipStore } from './appledouble';
import { buildBinHex } from './binhex';
import {
  expandArchiveFile,
  expandIncoming,
  isExpandableArchive,
  isZipArchive,
} from './expand-incoming';
import { makeFinderInfo } from './mac-file';
import { SitError } from './stuffit-codec';
import { parseZip } from './zip';

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function fileNode(nodes: ReturnType<typeof expandIncoming>, name: string) {
  const hit = nodes?.find((n) => n.name === name);
  if (hit?.kind !== 'file') throw new Error(`expected file ${name}`);
  return hit;
}

const sampleFi = makeFinderInfo('TEXT', 'ttxt', 0x0100);
const sampleRsrc = Uint8Array.from([0x00, 0x01, 0x02, 0x90]);
const sampleAd = buildAppleDouble(sampleFi, sampleRsrc);
const sampleData = ascii('Hello, Macintosh!\r');

describe('isZipArchive', () => {
  it('matches local-file and empty-archive signatures', () => {
    expect(isZipArchive(zipStore([{ name: 'a.txt', data: ascii('a') }]))).toBe(true);
    expect(isZipArchive(ascii('hello'))).toBe(false);
    expect(isZipArchive(new Uint8Array())).toBe(false);
  });
});

describe('parseZip AppleDouble', () => {
  it('merges a ._ sidecar next to the data fork', () => {
    const zip = zipStore([
      { name: 'Welcome/Read Me.txt', data: sampleData },
      { name: 'Welcome/._Read Me.txt', data: sampleAd },
    ]);
    const members = parseZip(zip)!;
    const file = members.find((m) => m.path === 'Welcome/Read Me.txt');
    expect(file).toBeDefined();
    expect(file!.isFolder).toBe(false);
    expect([...file!.data]).toEqual([...sampleData]);
    expect([...file!.resource]).toEqual([...sampleRsrc]);
    expect(String.fromCharCode(...file!.finderInfo.subarray(0, 8))).toBe('TEXTttxt');
    expect(members.some((m) => m.path.includes('._'))).toBe(false);
  });

  it('merges __MACOSX AppleDouble and omits that folder', () => {
    const zip = zipStore([
      { name: 'Read Me.txt', data: sampleData },
      { name: '__MACOSX/._Read Me.txt', data: sampleAd },
      { name: '__MACOSX/.DS_Store', data: ascii('junk') },
    ]);
    const members = parseZip(zip)!;
    expect(members.some((m) => m.path.startsWith('__MACOSX'))).toBe(false);
    const file = members.find((m) => m.path === 'Read Me.txt')!;
    expect([...file.resource]).toEqual([...sampleRsrc]);
    expect(String.fromCharCode(...file.finderInfo.subarray(0, 8))).toBe('TEXTttxt');
  });

  it('lets __MACOSX win when both sidecar styles are present', () => {
    const other = buildAppleDouble(makeFinderInfo('PICT', 'ogle'), Uint8Array.of(9, 9));
    const zip = zipStore([
      { name: 'Art', data: ascii('pict') },
      { name: '._Art', data: other },
      { name: '__MACOSX/._Art', data: sampleAd },
    ]);
    const file = parseZip(zip)!.find((m) => m.path === 'Art')!;
    expect(String.fromCharCode(...file.finderInfo.subarray(0, 8))).toBe('TEXTttxt');
    expect([...file.resource]).toEqual([...sampleRsrc]);
  });

  it('applies __MACOSX folder AppleDouble and nested file sidecars', () => {
    const folderAd = buildAppleDouble(makeFinderInfo('    ', '    ', 0x0400), new Uint8Array());
    const zip = zipStore([
      { name: 'Welcome/Read Me.txt', data: sampleData },
      { name: '__MACOSX/._Welcome', data: folderAd },
      { name: '__MACOSX/Welcome/._Read Me.txt', data: sampleAd },
    ]);
    const members = parseZip(zip)!;
    const dir = members.find((m) => m.isFolder && m.path === 'Welcome')!;
    expect(dir.finderInfo[8]).toBe(0x04);
    const file = members.find((m) => m.path === 'Welcome/Read Me.txt')!;
    expect([...file.resource]).toEqual([...sampleRsrc]);
  });

  it('creates a resource-only file from a sidecar with no data fork', () => {
    const zip = zipStore([{ name: '._Icon', data: sampleAd }]);
    const file = parseZip(zip)!.find((m) => m.path === 'Icon')!;
    expect(file.data.length).toBe(0);
    expect([...file.resource]).toEqual([...sampleRsrc]);
  });

  it('skips .DS_Store and zip-slip paths', () => {
    const zip = zipStore([
      { name: 'Keep.txt', data: ascii('ok') },
      { name: '.DS_Store', data: ascii('finder') },
      { name: '../Escape.txt', data: ascii('no') },
    ]);
    const paths = parseZip(zip)!.map((m) => m.path);
    expect(paths).toEqual(['Keep.txt']);
  });
});

describe('expandIncoming zip', () => {
  it('expands a stored zip into catalog items', () => {
    const zip = zipStore([
      { name: 'Notes.txt', data: ascii('hi') },
      { name: 'App', data: Uint8Array.of(1, 2, 3) },
    ]);
    const out = expandIncoming('Stuff.zip', zip);
    expect(out?.map((n) => n.name).sort()).toEqual(['App', 'Notes.txt']);
    expect([...fileNode(out, 'Notes.txt').data]).toEqual([...ascii('hi')]);
  });

  it('expands a deflated zip', () => {
    const zip = zipSync({ 'Read Me.txt': sampleData });
    const out = expandIncoming('Pack.zip', zip);
    expect(out).toHaveLength(1);
    expect([...fileNode(out, 'Read Me.txt').data]).toEqual([...sampleData]);
  });

  it('keeps expanding a zip member that is BinHex', () => {
    const hqx = buildBinHex({
      name: 'Read Me',
      data: sampleData,
      resource: sampleRsrc,
      finderInfo: sampleFi,
    });
    const zip = zipStore([{ name: 'Read Me.hqx', data: hqx }]);
    const out = expandIncoming('Pack.zip', zip);
    expect(out).toHaveLength(1);
    const file = fileNode(out, 'Read Me');
    expect([...file.data]).toEqual([...sampleData]);
    expect([...file.resource]).toEqual([...sampleRsrc]);
  });

  it('returns null for ordinary files', () => {
    expect(expandIncoming('notes.txt', ascii('hello'))).toBeNull();
  });
});

describe('isExpandableArchive zip', () => {
  it('matches .zip names and ZIP  type', () => {
    expect(isExpandableArchive('Archive.zip')).toBe(true);
    expect(isExpandableArchive('Archive', makeFinderInfo('ZIP ', 'SITx'))).toBe(true);
    expect(isExpandableArchive('notes.txt')).toBe(false);
  });
});

describe('expandArchiveFile zip', () => {
  it('says a truncated zip is corrupted', () => {
    const zip = zipStore([{ name: 'a.txt', data: ascii('a') }]);
    expect(() => expandArchiveFile('Pack.zip', zip.subarray(0, 8))).toThrow(SitError);
    try {
      expandArchiveFile('Pack.zip', zip.subarray(0, 8));
    } catch (err) {
      expect((err as SitError).code).toBe('corrupt');
    }
  });
});
