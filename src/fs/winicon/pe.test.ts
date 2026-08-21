import { describe, expect, it } from 'vitest';
import { writeLe16, writeLe32 } from '../../protocol/binary';
import { encodeIco, extractPeIconsFromBuffer, sniffWinIcon } from './index';
import { buildPeWithIco } from './exe-fixtures';
import type { DecodedIcon } from '../resource-types/icon-decoder';

function solid(width: number, height: number, r: number, g: number, b: number): DecodedIcon {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { typeCode: 'ICO', isColor: true, width, height, pixels };
}

describe('PE icons', () => {
  it('extracts 16/32 frames from RT_GROUP_ICON', async () => {
    const ico = encodeIco([solid(16, 16, 255, 0, 0), solid(32, 32, 0, 128, 0)]);
    const pe = buildPeWithIco(ico);
    expect(sniffWinIcon(pe)).toBe('pe');
    const icons = await extractPeIconsFromBuffer(pe);
    expect(icons.some((i) => i.width === 16 && i.pixels[0] === 255)).toBe(true);
    expect(icons.some((i) => i.width === 32 && i.pixels[1] === 128)).toBe(true);
  });

  it('returns nothing for MZ without a resource directory', async () => {
    const stub = new Uint8Array(128);
    writeLe16(stub, 0, 0x5a4d);
    writeLe32(stub, 0x3c, 0x40);
    writeLe32(stub, 0x40, 0x4550);
    writeLe16(stub, 0x44, 0x14c);
    writeLe16(stub, 0x54, 96);
    writeLe16(stub, 0x58, 0x10b);
    const icons = await extractPeIconsFromBuffer(stub);
    expect(icons).toEqual([]);
  });
});
