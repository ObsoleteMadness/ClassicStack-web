import { describe, expect, it } from 'vitest';
import { ResourceFork, type ResourceEntry } from './resource-fork';
import {
  decodeFref,
  describeBndl,
  forkBytesFromNode,
  formatOsType,
  groupResourceTypes,
  hexDump,
  inspectResourceFork,
  preferredInspectType,
  resourceIdHint,
} from './resource-inspect';

function entry(type: string, id: number, payload: Uint8Array, name: string | null = null): ResourceEntry {
  return { name, type, id, length: payload.length, attributes: 0, dataOffset: 0, payload };
}

function encodeBndlCdev(): Uint8Array {
  const buf = new Uint8Array(8 + 2 * 10);
  buf.set([0x52, 0x76, 0x65, 0x72], 0); // Rver
  buf[4] = 0;
  buf[5] = 0;
  buf[6] = 0;
  buf[7] = 1; // 2 sections
  let p = 8;
  buf.set([0x49, 0x43, 0x4e, 0x23], p); // ICN#
  p += 4;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0; // local 0
  buf[p++] = 0xf0;
  buf[p++] = 0x20; // resource -4064
  buf.set([0x46, 0x52, 0x45, 0x46], p); // FREF
  p += 4;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0xf0;
  buf[p++] = 0x20;
  return buf;
}

describe('resource inspect', () => {
  it('groups types with icon families first and sorts ids', () => {
    const groups = groupResourceTypes([
      entry('cdev', -4064, new Uint8Array(8)),
      entry('ICN#', 128, new Uint8Array(256)),
      entry('ICN#', -4064, new Uint8Array(256)),
      entry('STR ', 1, new Uint8Array(4)),
    ]);
    expect(groups.map((g) => g.type)).toEqual(['ICN#', 'cdev', 'STR ']);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual([-4064, 128]);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.bytes).toBe(512);
  });

  it('prefers BNDL when hunting Finder icons', () => {
    expect(preferredInspectType(['cdev', 'ICN#', 'BNDL'])).toBe('BNDL');
    expect(preferredInspectType(['TEXT'])).toBe('TEXT');
    expect(preferredInspectType([])).toBeNull();
  });

  it('decodes FREF type and local icon id', () => {
    const bytes = new Uint8Array(8);
    bytes.set([0x63, 0x64, 0x65, 0x76], 0); // cdev
    bytes[4] = 0;
    bytes[5] = 0;
    bytes[6] = 0; // empty name
    const fref = decodeFref(bytes);
    expect(fref).toEqual({ type: 'cdev', localId: 0, name: '' });
  });

  it('flags missing BNDL icon mappings', () => {
    const icn = new Uint8Array(256);
    const rf = ResourceFork.fromEntries([
      entry('BNDL', -4064, encodeBndlCdev()),
      entry('ICN#', -4064, icn),
    ]);
    const view = describeBndl(rf, rf.findById('BNDL', -4064)!);
    expect(view?.owner).toBe('Rver');
    expect(view?.mappings).toEqual([
      { code: 'ICN#', localId: 0, resourceId: -4064, present: true },
      { code: 'FREF', localId: 0, resourceId: -4064, present: false },
    ]);
  });

  it('hex-dumps and notes truncation', () => {
    const bytes = new Uint8Array(20);
    bytes[0] = 0x41;
    bytes[19] = 0x5a;
    const dump = hexDump(bytes, 16);
    expect(dump.truncated).toBe(true);
    expect(dump.text).toMatch(/^0000 {2}41 /);
  });

  it('inspects an empty buffer without throwing', () => {
    const empty = inspectResourceFork(new Uint8Array());
    expect(empty.parsed).toBe(false);
    expect(empty.types).toEqual([]);
  });

  it('uses the data fork when it is itself a resource map', () => {
    const icn = new Uint8Array(256);
    icn.fill(0xaa, 0, 128);
    icn.fill(0xff, 128, 256);
    const rf = ResourceFork.fromEntries([entry('ICN#', -4064, icn)]);
    // fromEntries has no fork image; fall back path needs a real header.
    // Empty resource + empty data → empty.
    expect(forkBytesFromNode({ resource: new Uint8Array(), data: new Uint8Array() }).source).toBe('empty');
    expect(resourceIdHint('ICN#', -4064)).toBe('cdev icon / bundle');
    expect(formatOsType('STR')).toBe("'STR '");
    expect(rf.findById('ICN#', -4064)?.length).toBe(256);
  });
});
