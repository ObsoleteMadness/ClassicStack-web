import { describe, expect, it } from 'vitest';
import { ResourceFork, loadFinderIconFork, loadResourceForkPartial } from './resource-fork';
import { decodeIcon, decodeICNHash, type DecodedIcon } from './resource-types/icon-decoder';
import { IconSet, IconSize } from './resource-types/icon-set';

function writeAscii4(buf: Uint8Array, o: number, s: string): void {
  for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i) ?? 0x20;
}

/** Classic resource fork with the given payloads (empty name list). */
function buildResourceFork(resources: { type: string; id: number; data: Uint8Array }[]): Uint8Array {
  const byType = new Map<string, { id: number; dataBlockOffset: number }[]>();
  const dataParts: Uint8Array[] = [];
  let dataOff = 0;
  for (const r of resources) {
    const block = new Uint8Array(4 + r.data.length);
    new DataView(block.buffer).setUint32(0, r.data.length);
    block.set(r.data, 4);
    const list = byType.get(r.type) ?? [];
    list.push({ id: r.id, dataBlockOffset: dataOff });
    byType.set(r.type, list);
    dataParts.push(block);
    dataOff += block.length;
  }
  const dataSection = new Uint8Array(dataOff);
  let p = 0;
  for (const part of dataParts) {
    dataSection.set(part, p);
    p += part.length;
  }

  const types = [...byType.keys()];
  const typeListOffset = 28;
  const typeListHeader = 2;
  const typeEntriesSize = types.length * 8;
  const nameListOffset = typeListOffset + typeListHeader + typeEntriesSize + resources.length * 12;
  const map = new Uint8Array(nameListOffset);
  map[24] = (typeListOffset >> 8) & 0xff;
  map[25] = typeListOffset & 0xff;
  map[26] = (nameListOffset >> 8) & 0xff;
  map[27] = nameListOffset & 0xff;
  const numTypesM1 = types.length - 1;
  map[typeListOffset] = (numTypesM1 >> 8) & 0xff;
  map[typeListOffset + 1] = numTypesM1 & 0xff;

  let refCursor = typeListHeader + typeEntriesSize;
  types.forEach((type, i) => {
    const entryOff = typeListOffset + 2 + i * 8;
    writeAscii4(map, entryOff, type);
    const refs = byType.get(type)!;
    const nM1 = refs.length - 1;
    map[entryOff + 4] = (nM1 >> 8) & 0xff;
    map[entryOff + 5] = nM1 & 0xff;
    map[entryOff + 6] = (refCursor >> 8) & 0xff;
    map[entryOff + 7] = refCursor & 0xff;
    let rl = typeListOffset + refCursor;
    for (const ref of refs) {
      const id = ref.id & 0xffff;
      map[rl] = (id >> 8) & 0xff;
      map[rl + 1] = id & 0xff;
      map[rl + 2] = 0xff;
      map[rl + 3] = 0xff;
      map[rl + 4] = 0;
      map[rl + 5] = (ref.dataBlockOffset >> 16) & 0xff;
      map[rl + 6] = (ref.dataBlockOffset >> 8) & 0xff;
      map[rl + 7] = ref.dataBlockOffset & 0xff;
      rl += 12;
      refCursor += 12;
    }
  });

  const dataOffset = 16;
  const mapOffset = dataOffset + dataSection.length;
  const out = new Uint8Array(mapOffset + map.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, dataOffset);
  view.setUint32(4, mapOffset);
  view.setUint32(8, dataSection.length);
  view.setUint32(12, map.length);
  out.set(dataSection, dataOffset);
  out.set(map, mapOffset);
  return out;
}

function icnPayload(): Uint8Array {
  const iconData = new Uint8Array(256);
  for (let i = 0; i < 128; i++) iconData[i] = 0xaa;
  for (let i = 128; i < 256; i++) iconData[i] = 0xff;
  return iconData;
}

function buildForkWithICN(): Uint8Array {
  return buildResourceFork([{ type: 'ICN#', id: 128, data: icnPayload() }]);
}

function applBndl(): Uint8Array {
  const bndl = new Uint8Array(8 + 2 * 10);
  bndl.set([0x41, 0x50, 0x50, 0x4c], 0);
  bndl[5] = 128;
  bndl[7] = 1;
  let p = 8;
  bndl.set([0x46, 0x52, 0x45, 0x46], p);
  p += 4;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 128;
  bndl.set([0x49, 0x43, 0x4e, 0x23], p);
  p += 4;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 0;
  bndl[p++] = 128;
  return bndl;
}

function applFref(): Uint8Array {
  const fref = new Uint8Array(6);
  fref.set([0x41, 0x50, 0x50, 0x4c], 0);
  return fref;
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

  it('does not pull unmapped ICN# payloads when loading Finder icons', async () => {
    const noise = new Uint8Array(256);
    noise.fill(0x11);
    const fork = buildResourceFork([
      { type: 'BNDL', id: 128, data: applBndl() },
      { type: 'FREF', id: 128, data: applFref() },
      { type: 'ICN#', id: 128, data: icnPayload() },
      { type: 'ICN#', id: 999, data: noise },
    ]);
    const parsed = ResourceFork.fromBytes(fork);
    const extra = parsed.findById('ICN#', 999)!;
    const extraStart = extra.dataOffset;
    const extraEnd = extra.dataOffset + extra.length;

    const reads: { offset: number; count: number }[] = [];
    const rf = await loadFinderIconFork(async (offset, count) => {
      reads.push({ offset, count });
      return fork.subarray(offset, offset + count);
    });
    expect(rf?.findById('ICN#', 128)?.length).toBe(256);
    expect(rf?.findById('ICN#', 999)).toBeUndefined();
    expect(rf?.findById('BNDL', 128)).toBeTruthy();
    const payloadReads = reads.filter(
      (r) => r.offset < extraEnd && r.offset + r.count > extraStart,
    );
    expect(payloadReads).toEqual([]);
    expect(reads.reduce((n, r) => n + r.count, 0)).toBeLessThan(fork.length);
  });

  it('parses the same map through fromReader as fromBytes without a full-fork read', async () => {
    const fork = buildForkWithICN();
    const fromBuf = ResourceFork.fromBytes(fork);
    const reads: { offset: number; count: number }[] = [];
    const fromRead = await ResourceFork.fromReader(async (offset, count) => {
      reads.push({ offset, count });
      return fork.subarray(offset, Math.min(fork.length, offset + count));
    });
    expect(fromRead?.findById('ICN#', 128)?.length).toBe(fromBuf.findById('ICN#', 128)?.length);
    expect(reads.some((r) => r.offset === 0 && r.count === fork.length)).toBe(false);
    expect(reads[0]).toEqual({ offset: 0, count: 16 });
  });
});
