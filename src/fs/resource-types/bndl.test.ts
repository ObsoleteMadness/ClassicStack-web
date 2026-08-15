import { describe, expect, it } from 'vitest';
import { ResourceFork, type ResourceEntry } from '../resource-fork';
import { parseBndl } from './bndl';
import { IconSize } from './icon-set';

function entry(type: string, id: number, payload: Uint8Array): ResourceEntry {
  return {
    name: null,
    type,
    id,
    length: payload.length,
    attributes: 0,
    dataOffset: 0,
    payload,
  };
}

/** APPL BNDL id 128: ICN# local 0 → 128, ics# local 0 → 129. */
function encodeBndl(): Uint8Array {
  const buf = new Uint8Array(8 + 2 * 10);
  buf.set([0x41, 0x50, 0x50, 0x4c], 0); // APPL
  buf[4] = 0;
  buf[5] = 128;
  buf[6] = 0;
  buf[7] = 1; // 2 sections
  let p = 8;
  buf.set([0x49, 0x43, 0x4e, 0x23], p); // ICN#
  p += 4;
  buf[p++] = 0;
  buf[p++] = 0; // 1 mapping
  buf[p++] = 0;
  buf[p++] = 0; // local 0
  buf[p++] = 0;
  buf[p++] = 128;
  buf.set([0x69, 0x63, 0x73, 0x23], p); // ics#
  p += 4;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 0;
  buf[p++] = 129;
  return buf;
}

describe('Bndl.extractIcons', () => {
  it('merges small and large icon types that use different resource ids', () => {
    const icn = new Uint8Array(256);
    icn.fill(0xaa, 0, 128);
    icn.fill(0xff, 128, 256);
    const ics = new Uint8Array(64);
    ics.fill(0x55, 0, 32);
    ics.fill(0xff, 32, 64);

    const rf = ResourceFork.fromEntries([
      entry('BNDL', 128, encodeBndl()),
      entry('ICN#', 128, icn),
      entry('ics#', 129, ics),
    ]);

    const bndl = parseBndl(rf);
    expect(bndl).toBeTruthy();
    const set = bndl!.extractIcons(rf).get(0);
    expect(set).toBeTruthy();
    expect(set!.getIconBySize(IconSize.Large, false)?.width).toBe(32);
    expect(set!.getIconBySize(IconSize.Small, false)?.width).toBe(16);
  });

  it('picks icl8 over icl4 over ICN# when BNDL only lists the B&W types', () => {
    const icn = new Uint8Array(256);
    icn.fill(0xaa, 0, 128);
    icn.fill(0xff, 128, 256);
    const ics = new Uint8Array(64);
    ics.fill(0x55, 0, 32);
    ics.fill(0xff, 32, 64);

    const rf = ResourceFork.fromEntries([
      entry('BNDL', 128, encodeBndl()),
      entry('ICN#', 128, icn),
      entry('icl4', 128, new Uint8Array(512)),
      entry('icl8', 128, new Uint8Array(1024)),
      entry('ics#', 129, ics),
      entry('ics4', 129, new Uint8Array(128)),
      entry('ics8', 129, new Uint8Array(256)),
    ]);

    const set = parseBndl(rf)!.extractIcons(rf).get(0);
    expect(set).toBeTruthy();
    expect(set!.getIconBySize(IconSize.Large, true, false)?.typeCode).toBe('icl8');
    expect(set!.getIconBySize(IconSize.Small, true, false)?.typeCode).toBe('ics8');
  });
});
