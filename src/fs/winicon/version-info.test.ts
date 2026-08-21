import { describe, expect, it } from 'vitest';
import { bufferRangeReader } from '../byte-range';
import { encodeIco, extractWinVersion, isWinVersionName, winVersionForGetInfo } from './index';
import { buildPeWithIco } from './exe-fixtures';
import type { DecodedIcon } from '../resource-types/icon-decoder';

function solid(width: number, r: number, g: number, b: number): DecodedIcon {
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let i = 0; i < width * width; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { typeCode: 'ICO', isColor: true, width, height: width, pixels };
}

describe('Win VERSIONINFO Get Info', () => {
  it('matches .exe / .dll / .scr / .ocx names', () => {
    expect(isWinVersionName('NOTEPAD.EXE')).toBe(true);
    expect(isWinVersionName('foo.DLL')).toBe(true);
    expect(isWinVersionName('ssstars.scr')).toBe(true);
    expect(isWinVersionName('ctrl.ocx')).toBe(true);
    expect(isWinVersionName('app.ico')).toBe(false);
    expect(isWinVersionName('shell32.cpl')).toBe(false);
  });

  it('maps VERSIONINFO strings to Get Info rows', () => {
    expect(
      winVersionForGetInfo([
        { key: 'FileVersion', value: '4.0.0.0' },
        { key: 'ProductVersion', value: '4.0' },
        { key: 'ProductName', value: 'Windows NT' },
        { key: 'FileDescription', value: 'Notepad' },
        { key: 'LegalCopyright', value: '© Microsoft Corp.' },
        { key: 'CompanyName', value: 'Microsoft Corporation' },
      ]),
    ).toEqual({
      version: '4.0.0.0',
      productVersion: '4.0',
      product: 'Windows NT',
      description: 'Notepad',
      copyright: '© Microsoft Corp.',
      company: 'Microsoft Corporation',
    });
  });

  it('ignores 0.0.0.0 binary versions', () => {
    expect(winVersionForGetInfo([{ key: 'FileVersion', value: '0.0.0.0' }])).toBeNull();
    expect(
      winVersionForGetInfo([
        { key: 'FileVersion', value: '0.0.0.0' },
        { key: 'FileDescription', value: 'Setup' },
      ]),
    ).toEqual({
      version: '',
      productVersion: '',
      product: '',
      description: 'Setup',
      copyright: '',
      company: '',
    });
  });

  it('returns null when a PE has no RT_VERSION', async () => {
    const ico = encodeIco([solid(16, 1, 0, 0)]);
    expect(await extractWinVersion(bufferRangeReader(buildPeWithIco(ico)))).toBeNull();
  });
});
