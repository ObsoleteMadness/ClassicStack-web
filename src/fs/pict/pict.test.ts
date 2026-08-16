import { describe, expect, it } from 'vitest';
import { be16 } from '../../protocol/binary';
import { decodePackBits, encodePackBits } from './packbits';
import { decodePict } from './pict';

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function i16(n: number): number[] {
  return u16(n & 0xffff);
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function rect(t: number, l: number, b: number, r: number): number[] {
  return [...i16(t), ...i16(l), ...i16(b), ...i16(r)];
}

function v2Prefix(frame: number[]): number[] {
  return [
    ...u16(0),
    ...frame,
    ...u16(0x0011),
    ...u16(0x02ff),
    ...u16(0x0c00),
    ...u16(0xfffe),
    ...u16(0),
    ...u32(0x00480000),
    ...u32(0x00480000),
    ...frame,
    ...u32(0),
  ];
}

function pixmap8(width: number, height: number, packType = 0): number[] {
  const rowBytes = 0x8000 | width;
  return [
    ...u16(rowBytes),
    ...rect(0, 0, height, width),
    ...u16(0),
    ...u16(packType),
    ...u32(0),
    ...u32(0x00480000),
    ...u32(0x00480000),
    ...u16(0),
    ...u16(8),
    ...u16(1),
    ...u16(8),
    ...u32(0),
    ...u32(0),
    ...u32(0),
  ];
}

function clut2(): number[] {
  return [
    ...u32(0),
    ...u16(0),
    ...u16(1),
    ...u16(0),
    ...u16(0xffff),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...u16(0),
    ...u16(0xffff),
    ...u16(0),
  ];
}

describe('PackBits', () => {
  it('decodes the TIFF reference stream', () => {
    const src = Uint8Array.of(
      0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03, 0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa,
    );
    const out = decodePackBits(src, 24);
    expect([...out]).toEqual([
      0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0x22, 0xaa, 0xaa,
      0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    ]);
  });

  it('round-trips bytes and 16-bit units', () => {
    const bytes = Uint8Array.from({ length: 80 }, (_, i) => (i % 9 === 0 ? 0x42 : i & 0xff));
    expect(decodePackBits(encodePackBits(bytes), bytes.length)).toEqual(bytes);
    const words = new Uint8Array(40);
    for (let i = 0; i < 20; i++) {
      const v = i < 8 ? 0xa5a5 : 0x1000 + i;
      words[i * 2] = v >> 8;
      words[i * 2 + 1] = v & 0xff;
    }
    expect(decodePackBits(encodePackBits(words, 2), words.length, 2)).toEqual(words);
  });
});

describe('PICT', () => {
  it('renders the Inside Macintosh vector listing', () => {
    const bytes = Uint8Array.from([
      ...u16(0x0078),
      ...rect(0, 0, 0x6c, 0xa8),
      ...u16(0x0011),
      ...u16(0x02ff),
      ...u16(0x0c00),
      ...u16(0xfffe),
      ...u16(0),
      ...u32(0x00480000),
      ...u32(0x00480000),
      ...rect(2, 2, 0x6e, 0xaa),
      ...u16(0),
      ...u16(0x001e),
      ...u16(0x0001),
      ...u16(0x000a),
      ...rect(2, 2, 0x6e, 0xaa),
      ...u16(0x000a),
      0x77, 0xdd, 0x77, 0xdd, 0x77, 0xdd, 0x77, 0xdd,
      ...u16(0x0034),
      ...rect(2, 2, 0x6e, 0xaa),
      ...u16(0x000a),
      0x88, 0x22, 0x88, 0x22, 0x88, 0x22, 0x88, 0x22,
      ...u16(0x005c),
      ...u16(0x0008),
      ...u16(0x0008),
      ...u16(0x0071),
      ...u16(0x001a),
      ...rect(2, 2, 0x6e, 0xaa),
      ...i16(0x6e),
      ...i16(0x0002),
      ...i16(0x0002),
      ...i16(0x0054),
      ...i16(0x006e),
      ...i16(0x00aa),
      ...i16(0x006e),
      ...i16(0x0002),
      ...u16(0x00ff),
    ]);
    const pic = decodePict(bytes);
    expect(pic).not.toBeNull();
    expect(pic!.width).toBe(0xa8);
    expect(pic!.height).toBe(0x6c);
    expect(pic!.ops.some((o) => o.kind === 'rect' && o.verb === 'fill')).toBe(true);
    expect(pic!.ops.some((o) => o.kind === 'oval' && o.verb === 'fill')).toBe(true);
    expect(pic!.ops.some((o) => o.kind === 'poly' && o.verb === 'paint')).toBe(true);
  });

  it('decodes a 1-bit packed BitsRect', () => {
    const width = 16;
    const height = 2;
    const rowBytes = 2;
    const row0 = Uint8Array.of(0xff, 0x00);
    const row1 = Uint8Array.of(0x00, 0xff);
    const bytes = Uint8Array.from([
      ...v2Prefix(rect(0, 0, height, width)),
      ...u16(0x0098),
      ...u16(rowBytes),
      ...rect(0, 0, height, width),
      ...rect(0, 0, height, width),
      ...rect(0, 0, height, width),
      ...u16(0),
      ...row0,
      ...row1,
      ...u16(0x00ff),
    ]);
    const pic = decodePict(bytes);
    const bit = pic?.ops.find((o) => o.kind === 'bitmap');
    expect(bit?.kind).toBe('bitmap');
    if (bit?.kind !== 'bitmap') return;
    expect(bit.image.width).toBe(16);
    expect(bit.image.height).toBe(2);
    expect([...bit.image.pixels.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...bit.image.pixels.subarray(15 * 4, 15 * 4 + 4)]).toEqual([255, 255, 255, 255]);
  });

  it('decodes an 8-bit PackBitsRect with a CLUT', () => {
    const width = 16;
    const height = 1;
    const pixels = Uint8Array.from({ length: 16 }, (_, i) => (i < 8 ? 0 : 1));
    const packed = encodePackBits(pixels);
    const bytes = Uint8Array.from([
      ...v2Prefix(rect(0, 0, height, width)),
      ...u16(0x0098),
      ...pixmap8(width, height),
      ...clut2(),
      ...rect(0, 0, height, width),
      ...rect(0, 0, height, width),
      ...u16(0),
      packed.length,
      ...packed,
      ...u16(0x00ff),
    ]);
    const pic = decodePict(bytes);
    const bit = pic?.ops.find((o) => o.kind === 'bitmap');
    expect(bit?.kind).toBe('bitmap');
    if (bit?.kind !== 'bitmap') return;
    expect([...bit.image.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...bit.image.pixels.subarray(8 * 4, 8 * 4 + 4)]).toEqual([0, 255, 0, 255]);
  });

  it('decodes a 4-bit PackBitsRect', () => {
    const width = 16;
    const height = 1;
    const rowBytes = 0x8000 | 8;
    const raw = Uint8Array.from({ length: 8 }, () => 0x01);
    const packed = encodePackBits(raw);
    const bytes = Uint8Array.from([
      ...v2Prefix(rect(0, 0, height, width)),
      ...u16(0x0098),
      ...u16(rowBytes),
      ...rect(0, 0, height, width),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(0x00480000),
      ...u32(0x00480000),
      ...u16(0),
      ...u16(4),
      ...u16(1),
      ...u16(4),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...clut2(),
      ...rect(0, 0, height, width),
      ...rect(0, 0, height, width),
      ...u16(0),
      packed.length,
      ...packed,
      ...u16(0x00ff),
    ]);
    const pic = decodePict(bytes);
    const bit = pic?.ops.find((o) => o.kind === 'bitmap');
    expect(bit?.kind).toBe('bitmap');
    if (bit?.kind !== 'bitmap') return;
    expect([...bit.image.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...bit.image.pixels.subarray(4, 8)]).toEqual([0, 255, 0, 255]);
  });

  it('decodes 16-bit DirectBitsRect packType 3', () => {
    const width = 4;
    const height = 1;
    const rowBytes = 0x8000 | 8;
    const red555 = 0x7c00;
    const words = new Uint8Array(8);
    for (let i = 0; i < 4; i++) {
      words[i * 2] = red555 >> 8;
      words[i * 2 + 1] = red555 & 0xff;
    }
    const packed = encodePackBits(words, 2);
    const bytes = Uint8Array.from([
      ...v2Prefix(rect(0, 0, height, width)),
      ...u16(0x009a),
      ...u32(0x000000ff),
      ...u16(rowBytes),
      ...rect(0, 0, height, width),
      ...u16(0),
      ...u16(3),
      ...u32(0),
      ...u32(0x00480000),
      ...u32(0x00480000),
      ...u16(16),
      ...u16(16),
      ...u16(1),
      ...u16(16),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...rect(0, 0, height, width),
      ...rect(0, 0, height, width),
      ...u16(0),
      packed.length,
      ...packed,
      ...u16(0x00ff),
    ]);
    const pic = decodePict(bytes);
    const bit = pic?.ops.find((o) => o.kind === 'bitmap');
    expect(bit?.kind).toBe('bitmap');
    if (bit?.kind !== 'bitmap') return;
    expect(bit.image.pixels[0]).toBe(255);
    expect(bit.image.pixels[1]).toBe(0);
    expect(bit.image.pixels[2]).toBe(0);
  });

  it('decodes 24-bit DirectBitsRect packType 4', () => {
    const width = 2;
    const height = 1;
    const rowBytes = 0x8000 | 8;
    const planar = Uint8Array.of(0xff, 0x00, 0x00, 0xff, 0x00, 0x00);
    const packed = encodePackBits(planar);
    const bytes = Uint8Array.from([
      ...v2Prefix(rect(0, 0, height, width)),
      ...u16(0x009a),
      ...u32(0x000000ff),
      ...u16(rowBytes),
      ...rect(0, 0, height, width),
      ...u16(0),
      ...u16(4),
      ...u32(0),
      ...u32(0x00480000),
      ...u32(0x00480000),
      ...u16(16),
      ...u16(32),
      ...u16(3),
      ...u16(8),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...rect(0, 0, height, width),
      ...rect(0, 0, height, width),
      ...u16(0),
      packed.length,
      ...packed,
      ...u16(0x00ff),
    ]);
    const pic = decodePict(bytes);
    const bit = pic?.ops.find((o) => o.kind === 'bitmap');
    expect(bit?.kind).toBe('bitmap');
    if (bit?.kind !== 'bitmap') return;
    expect([...bit.image.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...bit.image.pixels.subarray(4, 8)]).toEqual([0, 255, 0, 255]);
  });

  it('skips a 512-byte file header', () => {
    const inner = Uint8Array.from([
      ...v2Prefix(rect(0, 0, 8, 8)),
      ...u16(0x0030),
      ...rect(0, 0, 8, 8),
      ...u16(0x00ff),
    ]);
    const bytes = new Uint8Array(512 + inner.length);
    bytes.set(inner, 512);
    const pic = decodePict(bytes);
    expect(pic?.ops.some((o) => o.kind === 'rect')).toBe(true);
  });
});
