import { describe, expect, it } from 'vitest';
import { expandSitInPlace } from './expand-inplace';
import { buildClassicStore } from './stuffit';
import { bufferRangeReader } from './byte-range';
import type { Catalog, VNode } from './virtual-fs';

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function emptyNode(over: Partial<VNode> & Pick<VNode, 'id' | 'parentId' | 'name'>): VNode {
  return {
    isDir: false,
    data: new Uint8Array(),
    resource: new Uint8Array(),
    finderInfo: new Uint8Array(32),
    createDate: 0,
    modDate: 0,
    ...over,
  };
}

describe('expandSitInPlace', () => {
  it('expands through Catalog.withRangeReader rather than a full download', async () => {
    const packed = buildClassicStore([
      { name: 'Notes', data: ascii('hi'), type: 'TEXT', creator: 'ttxt' },
    ]);
    let nextId = 10;
    const nodes = new Map<number, VNode>();
    const created: VNode[] = [];
    const sit = emptyNode({ id: 5, parentId: 2, name: 'Pack.sit', data: packed, dataBytes: packed.length });
    nodes.set(5, sit);
    let rangeCalls = 0;
    const fs: Pick<
      Catalog,
      'withRangeReader' | 'lookup' | 'remove' | 'ensureDir' | 'createFile' | 'put'
    > = {
      async withRangeReader(node, fn) {
        rangeCalls++;
        expect(node.id).toBe(5);
        return fn(bufferRangeReader(node.data));
      },
      async lookup(parentId, name) {
        for (const n of nodes.values()) {
          if (n.parentId === parentId && n.name.toLowerCase() === name.toLowerCase()) return n;
        }
        return undefined;
      },
      async remove(id) {
        nodes.delete(id);
      },
      async ensureDir(parentId, name) {
        const node = emptyNode({ id: nextId++, parentId, name, isDir: true });
        nodes.set(node.id, node);
        return node;
      },
      async createFile(parentId, name, data, resource = new Uint8Array(), finderInfo = new Uint8Array(32)) {
        const node = emptyNode({ id: nextId++, parentId, name, data, resource, finderInfo });
        nodes.set(node.id, node);
        created.push(node);
        return node;
      },
      async put(node) {
        nodes.set(node.id, { ...node });
      },
    };

    const ok = await expandSitInPlace(fs, sit, {
      fileSize: packed.length,
      resolveConflict: async () => 'cancel',
    });
    expect(ok).toBe(true);
    expect(rangeCalls).toBe(1);
    expect(created.map((n) => n.name)).toEqual(['Notes']);
    expect([...created[0]!.data]).toEqual([...ascii('hi')]);
  });

  it('credits catalog reads, then queues files, then marks the current file expanding', async () => {
    const packed = buildClassicStore([
      { name: 'Notes', data: ascii('hello world'), type: 'TEXT', creator: 'ttxt' },
    ]);
    let nextId = 10;
    const nodes = new Map<number, VNode>();
    const sit = emptyNode({ id: 5, parentId: 2, name: 'Pack.sit', data: packed, dataBytes: packed.length });
    nodes.set(5, sit);
    const fs: Pick<
      Catalog,
      'withRangeReader' | 'lookup' | 'remove' | 'ensureDir' | 'createFile' | 'put'
    > = {
      async withRangeReader(node, fn) {
        return fn(bufferRangeReader(node.data));
      },
      async lookup(parentId, name) {
        for (const n of nodes.values()) {
          if (n.parentId === parentId && n.name.toLowerCase() === name.toLowerCase()) return n;
        }
        return undefined;
      },
      async remove(id) {
        nodes.delete(id);
      },
      async ensureDir(parentId, name) {
        const node = emptyNode({ id: nextId++, parentId, name, isDir: true });
        nodes.set(node.id, node);
        return node;
      },
      async createFile(parentId, name, data, resource = new Uint8Array(), finderInfo = new Uint8Array(32)) {
        const node = emptyNode({ id: nextId++, parentId, name, data, resource, finderInfo });
        nodes.set(node.id, node);
        return node;
      },
      async put(node) {
        nodes.set(node.id, { ...node });
      },
    };
    const events: string[] = [];
    let catalogBytes = 0;
    await expandSitInPlace(fs, sit, {
      fileSize: packed.length,
      resolveConflict: async () => 'cancel',
      track: {
        onStatus: (detail) => events.push(`status:${detail}`),
        onBytes: (n) => {
          catalogBytes += n;
          events.push('bytes');
        },
        onExpandBegin: (_total, files) => events.push(`begin:${files.map((f) => f.name).join(',')}`),
        onExpand: (file) => {
          events.push(`expand:${file.path}`);
          return undefined;
        },
      },
    });
    expect(events[0]).toBe('status:Reading archive');
    expect(catalogBytes).toBeGreaterThan(0);
    const beginAt = events.indexOf('begin:Notes');
    const expandAt = events.indexOf('expand:Notes');
    expect(beginAt).toBeGreaterThan(0);
    expect(expandAt).toBeGreaterThan(beginAt);
    expect(events.slice(1, beginAt).every((e) => e === 'bytes')).toBe(true);
  });

  it('returns false for a non-StuffIt payload so the caller can fall back', async () => {
    const zipish = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0);
    const node = emptyNode({ id: 5, parentId: 2, name: 'Pack.zip', data: zipish });
    const fs: Pick<Catalog, 'withRangeReader' | 'lookup' | 'remove' | 'ensureDir' | 'createFile' | 'put'> = {
      async withRangeReader(n, fn) {
        return fn(bufferRangeReader(n.data));
      },
      async lookup() {
        return undefined;
      },
      async remove() {},
      async ensureDir() {
        throw new Error('unused');
      },
      async createFile() {
        throw new Error('unused');
      },
      async put() {},
    };
    expect(await expandSitInPlace(fs, node, { resolveConflict: async () => 'cancel' })).toBe(false);
  });
});
