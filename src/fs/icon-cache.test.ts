import { describe, expect, it } from 'vitest';
import { ResourceFork, type ResourceEntry } from './resource-fork';
import { iconSetForFile, isCdevStyleType } from './icon-cache';
import { CDEV_ICON_ID, IconSize } from './resource-types/icon-set';

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

function icn(): Uint8Array {
  const data = new Uint8Array(256);
  data.fill(0xaa, 0, 128);
  data.fill(0xff, 128, 256);
  return data;
}

function finder(type: string, creator: string): Uint8Array {
  const fi = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    fi[i] = type.charCodeAt(i) ?? 0x20;
    fi[4 + i] = creator.charCodeAt(i) ?? 0x20;
  }
  return fi;
}

describe('iconSetForFile', () => {
  it('treats INIT and cdev as cdev-style types', () => {
    expect(isCdevStyleType('cdev')).toBe(true);
    expect(isCdevStyleType('INIT')).toBe(true);
    expect(isCdevStyleType('APPL')).toBe(false);
  });

  it('uses ICN# -4064 for a cdev with no BNDL', () => {
    const rf = ResourceFork.fromEntries([entry('ICN#', CDEV_ICON_ID, icn())]);
    const set = iconSetForFile(rf, 'cdev', finder('cdev', 'Rver'));
    expect(set?.getIconBySize(IconSize.Large, false)?.typeCode).toBe('ICN#');
  });

  it('uses ICN# -4064 for an INIT extension', () => {
    const rf = ResourceFork.fromEntries([entry('ICN#', CDEV_ICON_ID, icn())]);
    const set = iconSetForFile(rf, 'INIT', finder('INIT', 'Rver'));
    expect(set?.getIconBySize(IconSize.Large, false)?.typeCode).toBe('ICN#');
  });

  it('falls back to any ICN# in the fork when ids are not 128 or -4064', () => {
    const rf = ResourceFork.fromEntries([entry('ICN#', 256, icn())]);
    const set = iconSetForFile(rf, '????', finder('????', '????'));
    expect(set?.icons.some((i) => i.typeCode === 'ICN#')).toBe(true);
  });

  it('prefers icl8 from a BNDL that only maps ICN#', () => {
    const fref = new Uint8Array(6);
    fref.set([0x41, 0x50, 0x50, 0x4c], 0); // APPL
    const bndl = new Uint8Array(8 + 2 * 10);
    bndl.set([0x41, 0x50, 0x50, 0x4c], 0);
    bndl[5] = 128;
    bndl[7] = 1; // 2 sections
    let p = 8;
    bndl.set([0x46, 0x52, 0x45, 0x46], p); // FREF
    p += 4;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 128;
    bndl.set([0x49, 0x43, 0x4e, 0x23], p); // ICN#
    p += 4;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 0;
    bndl[p++] = 128;

    const rf = ResourceFork.fromEntries([
      entry('BNDL', 128, bndl),
      entry('FREF', 128, fref),
      entry('ICN#', 128, icn()),
      entry('icl4', 128, new Uint8Array(512)),
      entry('icl8', 128, new Uint8Array(1024)),
    ]);
    const set = iconSetForFile(rf, 'APPL', finder('APPL', 'TEST'));
    expect(set?.getIconBySize(IconSize.Large, true, false)?.typeCode).toBe('icl8');
  });
});
