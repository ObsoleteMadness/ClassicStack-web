import { describe, expect, it } from 'vitest';
import { encodeIco, decodeIco, sniffIcoHeader, pickIconNear } from './index';
import type { DecodedIcon } from '../resource-types/icon-decoder';

function solid(width: number, height: number, r: number, g: number, b: number, a = 255): DecodedIcon {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return { typeCode: 'ICO', isColor: true, width, height, pixels };
}

describe('ICO', () => {
  it('sniffs ICONDIR', () => {
    const ico = encodeIco([solid(16, 16, 255, 0, 0)]);
    expect(sniffIcoHeader(ico)).toBe('ico');
    expect(sniffIcoHeader(new Uint8Array([0x4d, 0x5a]))).toBeNull();
  });

  it('round-trips 16 and 32 px 32-bpp frames', async () => {
    const src = [solid(16, 16, 255, 0, 0), solid(32, 32, 0, 0, 255)];
    const ico = encodeIco(src);
    const got = await decodeIco(ico);
    expect(got).toHaveLength(2);
    const small = got.find((i) => i.width === 16)!;
    const large = got.find((i) => i.width === 32)!;
    expect(small.pixels[0]).toBe(255);
    expect(small.pixels[1]).toBe(0);
    expect(small.pixels[2]).toBe(0);
    expect(small.pixels[3]).toBe(255);
    expect(large.pixels[0]).toBe(0);
    expect(large.pixels[2]).toBe(255);
  });

  it('applies the AND mask when 32-bpp alpha is zero', async () => {
    const src = solid(16, 16, 0, 255, 0, 0);
    const ico = encodeIco([src]);
    // AND mask at end of DIB: set pixel 0 transparent already (alpha 0).
    const got = await decodeIco(ico);
    expect(got[0]!.pixels[3]).toBe(0);
  });

  it('picks the nearest size', () => {
    const icons = [solid(16, 16, 1, 0, 0), solid(48, 48, 2, 0, 0), solid(32, 32, 3, 0, 0)];
    expect(pickIconNear(icons, 16)?.width).toBe(16);
    expect(pickIconNear(icons, 32)?.width).toBe(32);
    expect(pickIconNear(icons, 24)?.width).toBe(32);
  });
});
