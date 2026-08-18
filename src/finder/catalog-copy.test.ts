import { describe, expect, it } from 'vitest';
import type { Catalog, VNode, VfsChangeListener } from '../fs/virtual-fs';
import { AfpFinderAPI } from './afp-finder-api';
import { consumeProgress } from './progress';

const EMPTY = new Uint8Array();

/** Minimal in-memory Catalog for copy/move tests (no IndexedDB). */
class MemCatalog implements Catalog {
  private next = 10;
  private nodes = new Map<number, VNode>();
  constructor() {
    this.nodes.set(2, {
      id: 2,
      parentId: 1,
      name: '',
      isDir: true,
      data: EMPTY,
      resource: EMPTY,
      finderInfo: new Uint8Array(32),
      createDate: 0,
      modDate: 0,
    });
  }
  rootId(): number {
    return 2;
  }
  subscribe(_fn: VfsChangeListener): () => void {
    return () => undefined;
  }
  beginBatch(): void {}
  endBatch(): void {}
  async get(id: number): Promise<VNode | undefined> {
    return this.nodes.get(id);
  }
  async ensureContent(id: number): Promise<VNode | undefined> {
    return this.nodes.get(id);
  }
  async children(parentId: number): Promise<VNode[]> {
    return [...this.nodes.values()].filter((n) => n.parentId === parentId && n.id !== 2);
  }
  async lookup(parentId: number, name: string): Promise<VNode | undefined> {
    return (await this.children(parentId)).find((n) => n.name === name);
  }
  async loadResourceFork(): Promise<null> {
    return null;
  }
  async loadIconResources(): Promise<null> {
    return null;
  }
  async withRangeReader<T>(node: VNode, fn: (read: (o: number, n: number) => Promise<Uint8Array>) => Promise<T>): Promise<T> {
    return fn(async (o, n) => node.data.subarray(o, o + n));
  }
  async mkdir(parentId: number, name: string): Promise<VNode> {
    const n: VNode = {
      id: this.next++,
      parentId,
      name,
      isDir: true,
      data: EMPTY,
      resource: EMPTY,
      finderInfo: new Uint8Array(32),
      createDate: 0,
      modDate: 0,
    };
    this.nodes.set(n.id, n);
    return n;
  }
  async ensureDir(parentId: number, name: string): Promise<VNode> {
    return (await this.lookup(parentId, name)) ?? this.mkdir(parentId, name);
  }
  async createFile(
    parentId: number,
    name: string,
    data: Uint8Array,
    resource = EMPTY,
    finderInfo = new Uint8Array(32),
  ): Promise<VNode> {
    const n: VNode = {
      id: this.next++,
      parentId,
      name,
      isDir: false,
      data,
      resource,
      finderInfo,
      createDate: 0,
      modDate: 0,
      dataBytes: data.length,
      resourceBytes: resource.length,
    };
    this.nodes.set(n.id, n);
    return n;
  }
  async put(node: VNode): Promise<void> {
    this.nodes.set(node.id, node);
  }
  async rename(id: number, newName: string): Promise<void> {
    const n = this.nodes.get(id);
    if (n) n.name = newName;
  }
  async move(id: number, newParent: number): Promise<void> {
    const n = this.nodes.get(id);
    if (n) n.parentId = newParent;
  }
  async remove(id: number): Promise<void> {
    this.nodes.delete(id);
  }
  async importDataTransfer(): Promise<number> {
    return 0;
  }
}

describe('AfpFinderAPI copy/move', () => {
  it('copies a file between catalogs without inspecting kind', async () => {
    const src = new MemCatalog();
    const dest = new MemCatalog();
    const api = new AfpFinderAPI();
    const srcCat = api.bindLocal(src);
    const destCat = api.bindRemote('vol:A', dest);
    const file = await src.createFile(src.rootId(), 'Hello', new Uint8Array([1, 2, 3]), new Uint8Array([9]));
    await destCat.copyFrom(srcCat, file.id, dest.rootId(), { destName: 'Hello' });
    const got = await dest.lookup(dest.rootId(), 'Hello');
    expect(got?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(got?.resource).toEqual(new Uint8Array([9]));
    expect(await src.get(file.id)).toBeDefined();
  });

  it('moveAcross copies then deletes when catalogs differ', async () => {
    const src = new MemCatalog();
    const dest = new MemCatalog();
    const api = new AfpFinderAPI();
    api.bindLocal(src);
    api.bindRemote('vol:A', dest);
    const file = await src.createFile(src.rootId(), 'X', new Uint8Array([7]));
    await consumeProgress(
      api.moveAcross({
        srcSession: 'local',
        destSession: 'vol:A',
        srcId: file.id,
        destParentId: dest.rootId(),
        destName: 'X',
      }),
    );
    expect(await dest.lookup(dest.rootId(), 'X')).toMatchObject({ name: 'X' });
    expect(await src.get(file.id)).toBeUndefined();
  });
});
