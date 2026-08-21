import { describe, expect, it } from 'vitest';
import { bufferRangeReader } from '../byte-range';
import { encodeIco, extractWinIcons, inspectWinResources, isWinExeName, isWinIconName, isWinVersionName, sniffWinIcon } from './index';
import { buildNeWithIco, buildPeWithIco } from './exe-fixtures';
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

describe('extractWinIcons', () => {
  it('matches Windows icon / executable names', () => {
    expect(isWinIconName('NOTEPAD.EXE')).toBe(true);
    expect(isWinIconName('ssstars.scr')).toBe(true);
    expect(isWinIconName('app.ico')).toBe(true);
    expect(isWinIconName('shell32.dll')).toBe(false);
    expect(isWinIconName('README.TXT')).toBe(false);
    expect(isWinExeName('NOTEPAD.EXE')).toBe(true);
    expect(isWinExeName('shell32.dll')).toBe(true);
    expect(isWinExeName('app.ico')).toBe(false);
    expect(isWinVersionName('NOTEPAD.EXE')).toBe(true);
    expect(isWinVersionName('app.ico')).toBe(false);
  });

  it('sniffs ICO vs PE vs NE', () => {
    const ico = encodeIco([solid(16, 1, 2, 3)]);
    expect(sniffWinIcon(ico)).toBe('ico');
    expect(sniffWinIcon(buildPeWithIco(ico))).toBe('pe');
    expect(sniffWinIcon(buildNeWithIco(ico).subarray(0, 80))).toBe('ne');
  });

  it('decodes a standalone ICO through the range reader', async () => {
    const ico = encodeIco([solid(16, 9, 8, 7)]);
    const icons = await extractWinIcons(bufferRangeReader(ico));
    expect(icons[0]!.pixels[0]).toBe(9);
  });

  it('decodes icons from a PE .exe', async () => {
    const ico = encodeIco([solid(16, 11, 0, 0)]);
    const icons = await extractWinIcons(bufferRangeReader(buildPeWithIco(ico)));
    expect(icons.some((i) => i.pixels[0] === 11)).toBe(true);
  });

  it('decodes icons from an NE .exe', async () => {
    const ico = encodeIco([solid(16, 0, 12, 0)]);
    const icons = await extractWinIcons(bufferRangeReader(buildNeWithIco(ico)));
    expect(icons.some((i) => i.pixels[1] === 12)).toBe(true);
  });

  it('enumerates RT_GROUP_ICON and RT_ICON in a PE image', async () => {
    const ico = encodeIco([solid(16, 1, 0, 0)]);
    const table = await inspectWinResources(bufferRangeReader(buildPeWithIco(ico)));
    expect(table.kind).toBe('pe');
    expect(table.types.map((t) => t.code).sort()).toEqual(['RT_GROUP_ICON', 'RT_ICON']);
    expect(table.entries).toHaveLength(2);
  });

  it('enumerates RT_GROUP_ICON and RT_ICON in an NE image', async () => {
    const ico = encodeIco([solid(16, 0, 1, 0)]);
    const table = await inspectWinResources(bufferRangeReader(buildNeWithIco(ico)));
    expect(table.kind).toBe('ne');
    expect(table.types.map((t) => t.code).sort()).toEqual(['RT_GROUP_ICON', 'RT_ICON']);
  });

  it('lists frames of a standalone ICO', async () => {
    const ico = encodeIco([solid(16, 9, 8, 7), solid(32, 1, 2, 3)]);
    const table = await inspectWinResources(bufferRangeReader(ico));
    expect(table.kind).toBe('ico');
    expect(table.entries).toHaveLength(2);
    expect(table.entries[0]!.name).toBe('16×16');
  });
});
