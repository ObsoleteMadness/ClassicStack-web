/** AFP volume as a Finder Catalog (same API as IndexedDB VirtualFS). */

import { CNIDRoot, macTime } from '../protocol/afp/constants';
import type { AfpClient } from '../services/afp-client/client';
import { unescapeHostFilename } from '../protocol/host-filename';
import { parseAppleDouble, parseAppleSingle, AS_MAGIC, AD_MAGIC } from './appledouble';
import { be32 } from '../protocol/binary';
import type { Catalog, VNode, VfsChangeListener } from './virtual-fs';

const EMPTY = new Uint8Array();

export class RemoteVfs implements Catalog {
  private client: AfpClient;
  private volumeName: string;
  private nodes = new Map<number, VNode>();
  private forksLoaded = new Set<number>();
  private listeners = new Set<VfsChangeListener>();
  private batchDepth = 0;
  private batchParents = new Set<number>();

  constructor(client: AfpClient, volumeName: string) {
    this.client = client;
    this.volumeName = volumeName;
    this.nodes.set(this.rootId(), this.makeRoot());
  }

  rootId(): number {
    return CNIDRoot;
  }

  subscribe(fn: VfsChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    if (this.batchDepth <= 0) return;
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchParents.size > 0) {
      const parentIds = [...this.batchParents];
      this.batchParents.clear();
      this.emit(parentIds);
    }
  }

  async get(id: number): Promise<VNode | undefined> {
    const node = this.nodes.get(id) ?? (id === this.rootId() ? this.ensureRoot() : undefined);
    if (!node || node.isDir) return node;
    if (!this.forksLoaded.has(id)) await this.hydrateForks(node);
    return node;
  }

  async children(parentId: number): Promise<VNode[]> {
    const entries = await this.client.list(parentId);
    const kids: VNode[] = [];
    for (const e of entries) {
      if (!e.cnid) continue;
      kids.push(this.adopt(e, parentId));
    }
    return kids;
  }

  async lookup(parentId: number, name: string): Promise<VNode | undefined> {
    const lower = name.toLowerCase();
    const kids = await this.children(parentId);
    return kids.find((n) => n.name.toLowerCase() === lower);
  }

  async mkdir(parentId: number, name: string): Promise<VNode> {
    const existing = await this.lookup(parentId, name);
    if (existing) throw new Error('exists');
    await this.client.mkdir(name, parentId);
    const node = (await this.lookup(parentId, name)) ?? this.placeholderDir(parentId, name);
    this.notify(parentId);
    return node;
  }

  async ensureDir(parentId: number, name: string): Promise<VNode> {
    const existing = await this.lookup(parentId, name);
    if (existing?.isDir) return existing;
    if (existing) throw new Error('exists');
    return this.mkdir(parentId, name);
  }

  async createFile(
    parentId: number,
    name: string,
    data: Uint8Array,
    resource = new Uint8Array(),
    finderInfo = new Uint8Array(32),
  ): Promise<VNode> {
    await this.client.writeFile(name, data, parentId, false);
    if (resource.length) await this.client.writeFile(name, resource, parentId, true);
    if (finderInfo.some((b) => b !== 0)) {
      await this.client.setFinderInfo(name, finderInfo, parentId);
    }
    const node =
      (await this.lookup(parentId, name)) ??
      this.placeholderFile(parentId, name, data, resource, finderInfo);
    if (node) {
      node.data = data;
      node.resource = resource;
      node.finderInfo = finderInfo;
      node.dataBytes = data.length;
      node.resourceBytes = resource.length;
      this.forksLoaded.add(node.id);
      this.nodes.set(node.id, node);
    }
    this.notify(parentId);
    return node;
  }

  async put(node: VNode): Promise<void> {
    this.nodes.set(node.id, node);
    await this.client.setFinderInfo(node.name, node.finderInfo, node.parentId);
    this.notify(node.parentId);
  }

  async rename(id: number, newName: string): Promise<void> {
    const n = this.nodes.get(id) ?? (await this.get(id));
    if (!n) throw new Error('not found');
    if (n.id === this.rootId()) throw new Error('cannot rename volume root');
    await this.client.rename(n.name, newName, n.parentId);
    n.name = newName;
    n.modDate = macTime();
    this.nodes.set(id, n);
    this.notify(n.parentId);
  }

  async move(id: number, newParent: number): Promise<void> {
    const n = this.nodes.get(id) ?? (await this.get(id));
    if (!n) throw new Error('not found');
    if (n.id === this.rootId()) throw new Error('cannot move volume root');
    if (n.parentId === newParent) return;
    await this.client.moveAndRename(n.parentId, n.name, newParent, n.name);
    const oldParent = n.parentId;
    n.parentId = newParent;
    n.modDate = macTime();
    this.nodes.set(id, n);
    this.notify(oldParent, newParent);
  }

  async remove(id: number): Promise<void> {
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.id === this.rootId()) throw new Error('cannot delete volume root');
    if (n.isDir) {
      const kids = await this.children(id);
      for (const k of kids) await this.remove(k.id);
    }
    await this.client.remove(n.name, n.parentId);
    this.nodes.delete(id);
    this.forksLoaded.delete(id);
    this.notify(n.parentId);
  }

  async importDataTransfer(
    parentId: number,
    dt: DataTransfer,
    opts?: {
      onScan?: (total: number) => void;
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<number> {
    const files = [...dt.files];
    opts?.onScan?.(files.length);
    this.beginBatch();
    let done = 0;
    try {
      for (const file of files) {
        await this.importBlob(parentId, file);
        done++;
        opts?.onProgress?.(done, files.length);
      }
      return files.length;
    } finally {
      this.endBatch();
    }
  }

  private async importBlob(parentId: number, file: File): Promise<VNode> {
    const buf = new Uint8Array(await file.arrayBuffer());
    const name = unescapeHostFilename(file.name);
    if (name.startsWith('._') && name.length > 2) {
      const ad = parseAppleDouble(buf);
      if (ad) {
        const target = name.slice(2);
        const existing = await this.lookup(parentId, target);
        if (existing && !existing.isDir) {
          const data = this.forksLoaded.has(existing.id)
            ? existing.data
            : await this.client.readFile(existing.name, parentId, false);
          return this.createFile(parentId, target, data, ad.resource, ad.finderInfo);
        }
        return this.createFile(parentId, target, new Uint8Array(), ad.resource, ad.finderInfo);
      }
    }
    if (buf.length >= 4 && be32(buf, 0) === AS_MAGIC) {
      const as = parseAppleSingle(buf);
      if (as) return this.createFile(parentId, name, as.data, as.resource, as.finderInfo);
    }
    if (buf.length >= 4 && be32(buf, 0) === AD_MAGIC) {
      const ad = parseAppleDouble(buf);
      if (ad) return this.createFile(parentId, name, new Uint8Array(), ad.resource, ad.finderInfo);
    }
    return this.createFile(parentId, name, buf);
  }

  private async hydrateForks(node: VNode): Promise<void> {
    try {
      node.data = await this.client.readFile(node.name, node.parentId, false);
    } catch {
      node.data = EMPTY;
    }
    try {
      node.resource = await this.client.readFile(node.name, node.parentId, true);
    } catch {
      node.resource = EMPTY;
    }
    node.dataBytes = node.data.length;
    node.resourceBytes = node.resource.length;
    this.forksLoaded.add(node.id);
    this.nodes.set(node.id, node);
  }

  private adopt(
    e: {
      name: string;
      isDir: boolean;
      cnid: number;
      parentId: number;
      dataLen: number;
      rsrcLen: number;
      createDate: number;
      modDate: number;
      finderInfo: Uint8Array;
    },
    parentId: number,
  ): VNode {
    const prev = this.nodes.get(e.cnid);
    const node: VNode = {
      id: e.cnid,
      parentId: e.parentId || parentId,
      name: e.name,
      isDir: e.isDir,
      data: prev && this.forksLoaded.has(e.cnid) ? prev.data : EMPTY,
      resource: prev && this.forksLoaded.has(e.cnid) ? prev.resource : EMPTY,
      finderInfo: e.finderInfo?.length ? e.finderInfo.slice() : new Uint8Array(32),
      createDate: e.createDate,
      modDate: e.modDate,
      dataBytes: e.isDir ? 0 : e.dataLen,
      resourceBytes: e.isDir ? 0 : e.rsrcLen,
    };
    if (!e.isDir && this.forksLoaded.has(e.cnid) && prev) {
      node.dataBytes = prev.data.length;
      node.resourceBytes = prev.resource.length;
    } else if (!e.isDir) {
      this.forksLoaded.delete(e.cnid);
    }
    this.nodes.set(e.cnid, node);
    return node;
  }

  private makeRoot(): VNode {
    return {
      id: this.rootId(),
      parentId: 1,
      name: this.volumeName,
      isDir: true,
      data: EMPTY,
      resource: EMPTY,
      finderInfo: new Uint8Array(32),
      createDate: 0,
      modDate: 0,
    };
  }

  private ensureRoot(): VNode {
    let n = this.nodes.get(this.rootId());
    if (!n) {
      n = this.makeRoot();
      this.nodes.set(n.id, n);
    }
    return n;
  }

  private placeholderDir(parentId: number, name: string): VNode {
    const node: VNode = {
      id: Date.now() & 0x7fffffff,
      parentId,
      name,
      isDir: true,
      data: EMPTY,
      resource: EMPTY,
      finderInfo: new Uint8Array(32),
      createDate: macTime(),
      modDate: macTime(),
    };
    this.nodes.set(node.id, node);
    return node;
  }

  private placeholderFile(
    parentId: number,
    name: string,
    data: Uint8Array,
    resource: Uint8Array,
    finderInfo: Uint8Array,
  ): VNode {
    const node: VNode = {
      id: Date.now() & 0x7fffffff,
      parentId,
      name,
      isDir: false,
      data,
      resource,
      finderInfo,
      createDate: macTime(),
      modDate: macTime(),
      dataBytes: data.length,
      resourceBytes: resource.length,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  private notify(...parentIds: number[]): void {
    if (this.batchDepth > 0) {
      for (const id of parentIds) this.batchParents.add(id);
      return;
    }
    this.emit(parentIds);
  }

  private emit(parentIds: number[]): void {
    const change = { parentIds: [...new Set(parentIds)] };
    for (const fn of this.listeners) {
      try {
        fn(change);
      } catch {
        /* ignore */
      }
    }
  }
}
