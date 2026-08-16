import { describe, expect, it } from 'vitest';
import { ResourceFork, type ResourceEntry } from './resource-fork';
import {
  HAS_BUNDLE,
  HAS_CUSTOM_ICON,
  IconCache,
  iconForkLoadOptions,
  iconSetForFile,
  isCdevStyleType,
  shouldReadIconFork,
} from './icon-cache';
import { CDEV_ICON_ID, CUSTOM_ICON_ID, IconSize } from './resource-types/icon-set';
import type { VNode } from './virtual-fs';

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

function finder(type: string, creator: string, flags = 0): Uint8Array {
  const fi = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    fi[i] = type.charCodeAt(i) ?? 0x20;
    fi[4 + i] = creator.charCodeAt(i) ?? 0x20;
  }
  fi[8] = (flags >> 8) & 0xff;
  fi[9] = flags & 0xff;
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

describe('shouldReadIconFork', () => {
  it('skips ordinary documents with no bundle or custom-icon flag', () => {
    expect(shouldReadIconFork(finder('TEXT', 'ttxt'), 'TEXT')).toBe(false);
  });

  it('reads APPL, cdev, bundle-bit, and custom-icon files', () => {
    expect(shouldReadIconFork(finder('APPL', 'TEST'), 'APPL')).toBe(true);
    expect(shouldReadIconFork(finder('cdev', 'Rver'), 'cdev')).toBe(true);
    expect(shouldReadIconFork(finder('TEXT', 'ttxt', HAS_BUNDLE), 'TEXT')).toBe(true);
    expect(shouldReadIconFork(finder('TEXT', 'ttxt', HAS_CUSTOM_ICON), 'TEXT')).toBe(true);
  });

  it('skips a bundled app once its type/creator is cached', () => {
    const cached = { small: 'data:image/png,x', large: 'data:image/png,x' };
    expect(shouldReadIconFork(finder('APPL', 'TEST'), 'APPL', cached)).toBe(false);
    expect(
      shouldReadIconFork(finder('APPL', 'TEST'), 'APPL', {
        small: '/icons/APPL16.png',
        large: '/icons/APPL32.png',
      }),
    ).toBe(false);
  });
});

describe('iconForkLoadOptions', () => {
  it('asks for the custom-icon family on Icon\\r files', () => {
    const node: VNode = {
      id: 1,
      parentId: 2,
      name: 'Icon\r',
      isDir: false,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: finder('icon', 'MACS', HAS_CUSTOM_ICON),
      createDate: 0,
      modDate: 0,
    };
    const opts = iconForkLoadOptions(node);
    expect(opts.includeAllIcons).toBe(true);
    expect(opts.extraIds).toContain(CUSTOM_ICON_ID);
  });
});

describe('IconCache.getForNode', () => {
  it('does not look up Icon\\r inside a closed folder', async () => {
    const cache = new IconCache();
    let probes = 0;
    const dir: VNode = {
      id: 4,
      parentId: 2,
      name: 'Folder',
      isDir: true,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: new Uint8Array(32),
      createDate: 0,
      modDate: 0,
    };
    await cache.getForNode(dir, undefined, async () => {
      probes += 1;
      return null;
    });
    expect(probes).toBe(0);
  });
});
