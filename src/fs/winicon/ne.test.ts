import { describe, expect, it } from 'vitest';
import { encodeIco, extractNeIconsFromBuffer, sniffWinIcon } from './index';
import { buildNeWithIco } from './exe-fixtures';
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

describe('NE icons', () => {
  it('extracts a 32 px icon from the NE resource table', async () => {
    const ico = encodeIco([solid(32, 32, 0, 0, 255)]);
    const ne = buildNeWithIco(ico);
    expect(sniffWinIcon(ne.subarray(0, 80))).toBe('ne');
    const icons = await extractNeIconsFromBuffer(ne);
    expect(icons.some((i) => i.width === 32 && i.pixels[2] === 255)).toBe(true);
  });
});
