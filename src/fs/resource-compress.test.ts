import { describe, expect, it } from 'vitest';
import { decompressResource, maybeDecompressResource, RES_COMPRESSED } from './resource-compress';
import { ResourceFork } from './resource-fork';

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function range(start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = start + i;
  return out;
}

function type8(decompressedLength: number, dcmpId: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(18 + body.length);
  out.set(hex('a89f657200120801'));
  out[8] = (decompressedLength >>> 24) & 0xff;
  out[9] = (decompressedLength >>> 16) & 0xff;
  out[10] = (decompressedLength >>> 8) & 0xff;
  out[11] = decompressedLength & 0xff;
  out[12] = 0x80;
  out[13] = 0x03;
  out[14] = (dcmpId >> 8) & 0xff;
  out[15] = dcmpId & 0xff;
  out.set(body, 18);
  return out;
}

function type9(decompressedLength: number, params: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(18 + body.length);
  out.set(hex('a89f657200120901'));
  out[8] = (decompressedLength >>> 24) & 0xff;
  out[9] = (decompressedLength >>> 16) & 0xff;
  out[10] = (decompressedLength >>> 8) & 0xff;
  out[11] = decompressedLength & 0xff;
  out[12] = 0;
  out[13] = 2;
  out.set(hex(params), 14);
  out.set(body, 18);
  return out;
}

function writeAscii4(buf: Uint8Array, o: number, s: string): void {
  for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i) ?? 0x20;
}

function buildResourceFork(
  resources: { type: string; id: number; data: Uint8Array; attributes?: number }[],
): Uint8Array {
  const byType = new Map<string, { id: number; dataBlockOffset: number; attributes: number }[]>();
  const dataParts: Uint8Array[] = [];
  let dataOff = 0;
  for (const r of resources) {
    const block = new Uint8Array(4 + r.data.length);
    new DataView(block.buffer).setUint32(0, r.data.length);
    block.set(r.data, 4);
    const list = byType.get(r.type) ?? [];
    list.push({ id: r.id, dataBlockOffset: dataOff, attributes: r.attributes ?? 0 });
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
      map[rl + 4] = ref.attributes;
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

describe('compressed resources', () => {
  it('decompresses dcmp 0 fixed-table codes', () => {
    const data = type8(358, 0, concat(range(0x4b, 0xfe), Uint8Array.of(0xff)));
    const out = decompressResource(data);
    expect(out.length).toBe(358);
    expect([...out.subarray(0, 16)]).toEqual([...hex('00004eba00084e75000c4ead20532f0b')]);
  });

  it('decompresses dcmp 0 stored literals, backreferences, and repeats', () => {
    expect([...decompressResource(type8(4, 0, Uint8Array.of(0x11, 0x41, 0x42, 0x23, 0xff)))]).toEqual([
      0x41, 0x42, 0x41, 0x42,
    ]);
    expect([...decompressResource(type8(5, 0, Uint8Array.of(0xfe, 0x02, 0x41, 0x04, 0xff)))]).toEqual([
      0x41, 0x41, 0x41, 0x41, 0x41,
    ]);
    expect([...decompressResource(type8(3, 0, Uint8Array.of(0x01, 0x41, 0x42, 0x01, 0x43, 0x44, 0xff)))]).toEqual([
      0x41, 0x42, 0x43,
    ]);
  });

  it('decompresses dcmp 1 literals and the fixed table', () => {
    const table = type8(82, 1, concat(range(0xd5, 0xfe), Uint8Array.of(0xff)));
    expect(decompressResource(table).length).toBe(82);
    expect([...decompressResource(table).subarray(0, 8)]).toEqual([...hex('0000000100020003')]);
    expect([...decompressResource(type8(4, 1, Uint8Array.of(0x11, 0x41, 0x42, 0x20, 0xff)))]).toEqual([
      0x41, 0x42, 0x41, 0x42,
    ]);
    expect([...decompressResource(type8(4, 1, Uint8Array.of(0xd1, 0x02, 0x41, 0x42, 0x20, 0xff)))]).toEqual([
      0x41, 0x42, 0x41, 0x42,
    ]);
  });

  it('decompresses dcmp 2 default, tagged, custom, and odd-length streams', () => {
    const untagged = type9(512, '00000000', range(0, 256));
    const out = decompressResource(untagged);
    expect(out.length).toBe(512);
    expect([...out.subarray(0, 16)]).toEqual([...hex('000000084eba206e4e75000c00047000')]);
    expect([...decompressResource(type9(6, '00000002', Uint8Array.of(0b11100000, 0, 1, 2)))]).toEqual([
      0x00, 0x00, 0x00, 0x08, 0x4e, 0xba,
    ]);
    expect([...decompressResource(type9(3, '00000000', Uint8Array.of(0x00, 0x99)))]).toEqual([0x00, 0x00, 0x99]);
    expect([
      ...decompressResource(type9(6, '00000101', concat(hex('48692121'), Uint8Array.of(0, 1, 0)))),
    ]).toEqual([...hex('486921214869')]);
  });

  it('leaves uncompressed data unchanged', () => {
    const raw = Uint8Array.of(1, 2, 3, 4);
    expect(maybeDecompressResource(raw)).toBe(raw);
  });

  it('reads decompressed bytes from a resource fork', async () => {
    const compressed = type8(4, 0, Uint8Array.of(0x11, 0x41, 0x42, 0x23, 0xff));
    const fork = buildResourceFork([{ type: 'STR ', id: 128, data: compressed, attributes: RES_COMPRESSED }]);
    const rf = ResourceFork.fromBytes(fork);
    const ent = rf.findById('STR ', 128)!;
    expect([...rf.readBytes(ent)]).toEqual([0x41, 0x42, 0x41, 0x42]);
    expect(ent.length).toBe(4);

    const fromRead = await ResourceFork.fromReader(async (offset, count) =>
      fork.subarray(offset, Math.min(fork.length, offset + count)),
    );
    const lazy = fromRead!.findById('STR ', 128)!;
    const pulled = await fromRead!.pullBytes(lazy, 2);
    expect([...pulled]).toEqual([0x41, 0x42]);
    expect([...fromRead!.readBytes(lazy)]).toEqual([0x41, 0x42, 0x41, 0x42]);
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
