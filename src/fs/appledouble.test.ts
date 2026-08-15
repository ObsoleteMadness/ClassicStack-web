import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { buildAppleDouble, parseAppleDouble, zipSidecarPath, zipStore } from './appledouble';
import { crc32 } from '../protocol/crc32';

function le16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function le32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

describe('appledouble', () => {
  it('round-trips finder + resource', () => {
    const fi = new Uint8Array(32);
    fi[0] = 0x54;
    fi[1] = 0x45;
    fi[2] = 0x58;
    fi[3] = 0x54;
    const rsrc = new Uint8Array([1, 2, 3, 4]);
    const built = buildAppleDouble(fi, rsrc);
    const parsed = parseAppleDouble(built)!;
    expect(parsed.finderInfo[0]).toBe(0x54);
    expect([...parsed.resource]).toEqual([1, 2, 3, 4]);
  });
});

describe('zipSidecarPath', () => {
  it('places ._Name beside the data fork for AppleDouble', () => {
    expect(zipSidecarPath('Read Me.txt')).toBe('._Read Me.txt');
    expect(zipSidecarPath('Welcome/Read Me.txt', 'appledouble')).toBe('Welcome/._Read Me.txt');
  });

  it('nests ._Name under __MACOSX for Mac OS X zips', () => {
    expect(zipSidecarPath('Read Me.txt', 'macosx')).toBe('__MACOSX/._Read Me.txt');
    expect(zipSidecarPath('Welcome/Utilities/Notes.txt', 'macosx')).toBe(
      '__MACOSX/Welcome/Utilities/._Notes.txt',
    );
  });
});

describe('zipStore', () => {
  it('writes CRC and sizes in both local and central headers', () => {
    const data = new TextEncoder().encode('hello zip');
    const zip = zipStore([{ name: 'hello.txt', data }]);
    const crc = crc32(data);

    expect(le32(zip, 0)).toBe(0x04034b50);
    expect(le16(zip, 4)).toBe(20);
    expect(le16(zip, 8)).toBe(0);
    expect(le32(zip, 14)).toBe(crc);
    expect(le32(zip, 18)).toBe(data.length);
    expect(le32(zip, 22)).toBe(data.length);

    const nameLen = le16(zip, 26);
    const centralOff = 30 + nameLen + data.length;
    expect(le32(zip, centralOff)).toBe(0x02014b50);
    expect(le32(zip, centralOff + 16)).toBe(crc);
    expect(le32(zip, centralOff + 20)).toBe(data.length);
    expect(le32(zip, centralOff + 24)).toBe(data.length);
    expect(le32(zip, centralOff + 42)).toBe(0);
  });

  it('round-trips nested AppleDouble pairs through unzip', () => {
    const fi = new Uint8Array(32);
    fi.set([0x54, 0x45, 0x58, 0x54]);
    const data = new TextEncoder().encode('Read Me');
    const ad = buildAppleDouble(fi, new Uint8Array([9, 8, 7]));
    const zip = zipStore([
      { name: 'Welcome/Read Me.txt', data },
      { name: zipSidecarPath('Welcome/Read Me.txt', 'macosx'), data: ad },
    ]);
    const files = unzipSync(zip);
    expect(new TextDecoder().decode(files['Welcome/Read Me.txt'])).toBe('Read Me');
    const parsed = parseAppleDouble(files['__MACOSX/Welcome/._Read Me.txt']!)!;
    expect([...parsed.resource]).toEqual([9, 8, 7]);
  });
});
