/** QuickDraw ColorTable / clut parser (LibHfs.ResourceForks.ResourceTypes.ColorTable). */

import { be16, be32 } from '../../protocol/binary';

function be16s(b: Uint8Array, o: number): number {
  return (be16(b, o) << 16) >> 16;
}

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

export interface ColorSpec {
  colorIndex: number;
  color: RgbColor;
}

export interface ColorTable {
  seed: number;
  flags: number;
  size: number;
  colors: ColorSpec[];
}

export function parseColorTable(data: Uint8Array, off: { o: number }): ColorTable {
  if (data.length - off.o < 8) throw new Error('Data too short to be a valid CLUT resource.');
  const seed = be32(data, off.o) | 0;
  off.o += 4;
  // LibHfs reads flags as little-endian ushort (matches observed cicn tables).
  const flags = data[off.o]! | (data[off.o + 1]! << 8);
  off.o += 2;
  const size = be16(data, off.o);
  off.o += 2;

  const colors: ColorSpec[] = [];
  for (let i = 0; i < size + 1; i++) {
    if (off.o + 8 > data.length) throw new Error('Data too short for the specified number of colors.');
    const colorIndex = be16s(data, off.o);
    off.o += 2;
    const red = be16(data, off.o);
    off.o += 2;
    const green = be16(data, off.o);
    off.o += 2;
    const blue = be16(data, off.o);
    off.o += 2;
    colors.push({ colorIndex, color: { red, green, blue } });
  }
  return { seed, flags, size, colors };
}
