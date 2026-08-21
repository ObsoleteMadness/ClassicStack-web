import { describe, expect, it } from 'vitest';
import { writeLe16, writeLe32 } from '../../protocol/binary';
import { decodeBmp, sniffBmp } from './bmp';

function rgbBmp(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const stride = (width * 3 + 3) & ~3;
  const pixels = stride * height;
  const off = 54;
  const out = new Uint8Array(off + pixels);
  out[0] = 0x42;
  out[1] = 0x4d;
  writeLe32(out, 2, out.length);
  writeLe32(out, 10, off);
  writeLe32(out, 14, 40);
  writeLe32(out, 18, width);
  writeLe32(out, 22, height);
  writeLe16(out, 26, 1);
  writeLe16(out, 28, 24);
  writeLe32(out, 34, pixels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = off + y * stride + x * 3;
      out[p] = b;
      out[p + 1] = g;
      out[p + 2] = r;
    }
  }
  return out;
}

describe('BMP files', () => {
  it('sniffs BITMAPFILEHEADER', () => {
    expect(sniffBmp(rgbBmp(2, 2, 1, 2, 3))).toBe(true);
    expect(sniffBmp(new Uint8Array([0x4d, 0x5a]))).toBe(false);
  });

  it('decodes a 24-bpp BMP to RGBA', () => {
    const icon = decodeBmp(rgbBmp(2, 2, 255, 0, 128));
    expect(icon).not.toBeNull();
    expect(icon!.width).toBe(2);
    expect(icon!.height).toBe(2);
    expect(icon!.pixels[0]).toBe(255);
    expect(icon!.pixels[1]).toBe(0);
    expect(icon!.pixels[2]).toBe(128);
    expect(icon!.pixels[3]).toBe(255);
  });
});
