import { describe, expect, it } from 'vitest';
import { ResourceFork, loadResourceForkPartial } from './resource-fork';
import { decodeIcon, decodeICNHash, type DecodedIcon } from './resource-types/icon-decoder';
import { IconSet, IconSize } from './resource-types/icon-set';

/** Build a minimal resource fork containing a single ICN# id 128 (bitmap+mask). */
function buildForkWithICN(): Uint8Array {
  const iconData = new Uint8Array(256);
  // Simple diagonal pattern in first plane; full mask in second
  for (let i = 0; i < 128; i++) iconData[i] = 0xaa;
  for (let i = 128; i < 256; i++) iconData[i] = 0xff;

  // Resource data block: 4-byte length + data
  const dataBlock = new Uint8Array(4 + 256);
  dataBlock[0] = 0;
  dataBlock[1] = 0;
  dataBlock[2] = 1;
  dataBlock[3] = 0; // length 256
  dataBlock.set(iconData, 4);

  // Map layout (classic):
  // 0..15 reserved header copy
  // 16..19 next map
  // 20..21 file ref
  // 22..23 attributes
  // 24..25 type list offset (from start of map)
  // 26..27 name list offset
  // type list at offset 28: numTypes-1, then type entries
  const typeListOffset = 28;
  const nameListOffset = 28 + 2 + 8 + 12; // after type count + 1 type entry + 1 ref
  const mapLen = nameListOffset; // empty name list
  const dataOffset = 16;
  const mapOffset = dataOffset + dataBlock.length;

  const map = new Uint8Array(mapLen);
  // type list offset / name list offset
  map[24] = (typeListOffset >> 8) & 0xff;
  map[25] = typeListOffset & 0xff;
  map[26] = (nameListOffset >> 8) & 0xff;
  map[27] = nameListOffset & 0xff;

  // num types - 1 = 0
  map[typeListOffset] = 0;
  map[typeListOffset + 1] = 0;
  // type 'ICN#'
  map[typeListOffset + 2] = 0x49; // I
  map[typeListOffset + 3] = 0x43; // C
  map[typeListOffset + 4] = 0x4e; // N
  map[typeListOffset + 5] = 0x23; // #
  // num refs - 1 = 0
  map[typeListOffset + 6] = 0;
  map[typeListOffset + 7] = 0;
  // ref list offset from type list start = 2 + 8 = 10
  map[typeListOffset + 8] = 0;
  map[typeListOffset + 9] = 10;

  const refOff = typeListOffset + 10;
  // id 128
  map[refOff] = 0;
  map[refOff + 1] = 128;
  // name offset -1
  map[refOff + 2] = 0xff;
  map[refOff + 3] = 0xff;
  map[refOff + 4] = 0; // attrs
  // data block offset (3 bytes) = 0 relative to data section
  map[refOff + 5] = 0;
  map[refOff + 6] = 0;
  map[refOff + 7] = 0;

  const out = new Uint8Array(mapOffset + mapLen);
  // header
  const view = new DataView(out.buffer);
  view.setUint32(0, dataOffset);
  view.setUint32(4, mapOffset);
  view.setUint32(8, dataBlock.length);
  view.setUint32(12, mapLen);
  out.set(dataBlock, dataOffset);
  out.set(map, mapOffset);
  return out;
}

describe('resource fork + icon decode', () => {
  it('parses ICN# from a synthetic resource fork', () => {
    const rf = ResourceFork.fromBytes(buildForkWithICN());
    expect(rf.allEntries.length).toBe(1);
    const ent = rf.findById('ICN#', 128);
    expect(ent).toBeTruthy();
    expect(ent!.length).toBe(256);

    const set = IconSet.fromResourceFork(128, rf);
    expect(set).toBeTruthy();
    const large = set!.getIconBySize(IconSize.Large, false);
    expect(large?.width).toBe(32);
    expect(large?.height).toBe(32);
    expect(large?.pixels.length).toBe(32 * 32 * 4);
    // Mask fully opaque
    expect(large!.pixels[3]).toBe(255);
  });

  it('decodes 1-bit ICN# bitmap+mask', () => {
    const data = new Uint8Array(256);
    data.fill(0xff, 0, 128); // all black
    data.fill(0xff, 128, 256); // opaque mask
    const icon = decodeICNHash(data);
    expect(icon?.width).toBe(32);
    expect(icon?.pixels[0]).toBe(0); // black
    expect(icon?.pixels[3]).toBe(255);
  });

  it('decodes icl8 with system palette', () => {
    const data = new Uint8Array(1024);
    data.fill(0); // white
    data[0] = 255; // black at first pixel (index 255 in clut8 is black)
    const icon = decodeIcon('icl8', data);
    expect(icon?.isColor).toBe(true);
    expect(icon?.width).toBe(32);
    expect(icon?.pixels[0]).toBe(0);
    expect(icon?.pixels[1]).toBe(0);
    expect(icon?.pixels[2]).toBe(0);
  });

  it('prefers 8-bit over 4-bit over B&W for the same size', () => {
    const bw: DecodedIcon = {
      typeCode: 'ICN#',
      isColor: false,
      width: 32,
      height: 32,
      pixels: new Uint8ClampedArray(32 * 32 * 4),
    };
    const bit4: DecodedIcon = {
      typeCode: 'icl4',
      isColor: true,
      width: 32,
      height: 32,
      pixels: new Uint8ClampedArray(32 * 32 * 4),
    };
    const bit8: DecodedIcon = {
      typeCode: 'icl8',
      isColor: true,
      width: 32,
      height: 32,
      pixels: new Uint8ClampedArray(32 * 32 * 4),
    };
    // Deliberately insert lower-depth first (old fork-order bug).
    const set = new IconSet([bw, bit4, bit8]);
    const picked = set.getIconBySize(IconSize.Large, true, false);
    expect(picked?.typeCode).toBe('icl8');
    expect(set.largeColor?.typeCode).toBe('icl8');
  });

  it('loads only header, map, and matching icon resources from a fork reader', async () => {
    const fork = buildForkWithICN();
    const reads: { offset: number; count: number }[] = [];
    const rf = await loadResourceForkPartial(
      async (offset, count) => {
        reads.push({ offset, count });
        return fork.subarray(offset, offset + count);
      },
      (type, id) => type === 'ICN#' && id === 128,
    );
    expect(rf).toBeTruthy();
    expect(rf!.findById('ICN#', 128)?.length).toBe(256);
    const set = IconSet.fromResourceFork(128, rf!);
    expect(set?.getIconBySize(IconSize.Large, false)?.width).toBe(32);
    const total = reads.reduce((n, r) => n + r.count, 0);
    expect(reads.some((r) => r.offset === 0 && r.count === fork.length)).toBe(false);
    expect(reads[0]).toEqual({ offset: 0, count: 16 });
    expect(total).toBeGreaterThan(16);
  });
});
