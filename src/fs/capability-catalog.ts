/** In-memory Catalog parameterized by capabilities (tests + SMB/NCP/EDFS stubs). */

import { bufferRangeReader, type ByteRangeReader } from './byte-range';
import { importDataTransferInto, type ImportProgress } from './import-transfer';
import type { ResourceFork } from './resource-fork';
import {
  joinStorePath,
  refKey,
  type CatalogCapabilities,
  type NodeRef,
} from './catalog-caps';
import type {
  Catalog,
  ChildrenBatchListener,
  CnidVNode,
  PathVNode,
  VfsChangeListener,
  VNode,
} from './virtual-fs';
import { nodeRef, parentRef } from './virtual-fs';

const EMPTY = new Uint8Array();
const ROOT_CNID = 2;

function emptyForks(): Pick<VNode, 'data' | 'resource' | 'finderInfo'> {
  return { data: EMPTY, resource: EMPTY, finderInfo: new Uint8Array(32) };
}

export class CapabilityCatalog implements Catalog {
  readonly reportsChunkedBytes = false;
  private caps: CatalogCapabilities;
  private cnidNodes = new Map<number, CnidVNode>();
  private pathNodes = new Map<string, PathVNode>();
  private nextId = 100;
  private listeners = new Set<VfsChangeListener>();
  private batchDepth = 0;
  private batchParents = new Set<string>();

  constructor(caps: CatalogCapabilities) {
    this.caps = caps;
    if (caps.addressBy === 'cnid') {
      this.cnidNodes.set(ROOT_CNID, {
        addr: 'cnid',
        id: ROOT_CNID,
        parentId: 1,
        name: '',
        isDir: true,
        createDate: Date.now(),
        modDate: Date.now(),
        ...emptyForks(),
      });
    } else {
      this.pathNodes.set('', {
        addr: 'path',
        path: '',
        parentPath: '',
        name: '',
        isDir: true,
        createDate: Date.now(),
        modDate: Date.now(),
        ...emptyForks(),
      });
    }
  }

  capabilities(): CatalogCapabilities {
    return this.caps;
  }

  rootId(): NodeRef {
    return this.caps.addressBy === 'path' ? '' : ROOT_CNID;
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
    if (this.batchDepth === 0 && this.batchParents.size) {
      const parentIds = [...this.batchParents].map((k) => (k.startsWith('p:') ? k.slice(2) : Number(k.slice(2))));
      this.batchParents.clear();
      this.emit(parentIds);
    }
  }

  async get(ref: NodeRef): Promise<VNode | undefined> {
    if (this.caps.addressBy === 'path') {
      if (typeof ref !== 'string') return undefined;
      return this.pathNodes.get(ref);
    }
    if (typeof ref === 'string') return this.resolvePath(ref);
    return this.cnidNodes.get(ref);
  }

  async ensureContent(ref: NodeRef): Promise<VNode | undefined> {
    return this.get(ref);
  }

  async children(parent: NodeRef, onBatch?: ChildrenBatchListener): Promise<VNode[]> {
    const kids: VNode[] = [];
    if (this.caps.addressBy === 'path') {
      const p = String(parent);
      for (const n of this.pathNodes.values()) {
        if (n.path !== p && n.parentPath === p) kids.push(n);
      }
    } else {
      const id = Number(parent);
      for (const n of this.cnidNodes.values()) {
        if (n.parentId === id && n.id !== id) kids.push(n);
      }
    }
    await onBatch?.(kids);
    return kids;
  }

  async lookup(parent: NodeRef, name: string): Promise<VNode | undefined> {
    const kids = await this.children(parent);
    const lower = name.toLowerCase();
    return kids.find((n) => n.name.toLowerCase() === lower);
  }

  async resolvePath(path: string): Promise<VNode | undefined> {
    if (this.caps.addressBy === 'path') return this.get(path);
    const parts = path.split('/').filter(Boolean);
    let cur: VNode | undefined = await this.get(ROOT_CNID);
    for (const part of parts) {
      if (!cur) return undefined;
      cur = await this.lookup(nodeRef(cur), part);
    }
    return cur;
  }

  async pathOf(ref: NodeRef): Promise<string> {
    if (this.caps.addressBy === 'path') return String(ref);
    if (typeof ref === 'string') return ref;
    const names: string[] = [];
    let cur = await this.get(ref);
    while (cur && cur.addr === 'cnid' && cur.id !== ROOT_CNID) {
      if (cur.name) names.unshift(cur.name);
      if (!cur.parentId || cur.parentId === cur.id) break;
      cur = await this.get(cur.parentId);
    }
    return names.join('/');
  }

  async setAttrs(ref: NodeRef, patch: Record<string, boolean>): Promise<void> {
    const n = await this.get(ref);
    if (!n) throw new Error('not found');
    n.attrs = { ...(n.attrs ?? {}), ...patch };
    this.store(n);
  }

  async loadResourceFork(): Promise<ResourceFork | null> {
    return null;
  }

  async loadIconResources(): Promise<ResourceFork | null> {
    return null;
  }

  async withRangeReader<T>(node: VNode, fn: (read: ByteRangeReader) => Promise<T>): Promise<T> {
    return fn(bufferRangeReader(node.data));
  }

  async mkdir(parent: NodeRef, name: string): Promise<VNode> {
    const existing = await this.lookup(parent, name);
    if (existing) throw new Error('exists');
    const n = this.makeChild(parent, name, true);
    this.store(n);
    this.notify(parent);
    return n;
  }

  async ensureDir(parent: NodeRef, name: string): Promise<VNode> {
    const existing = await this.lookup(parent, name);
    if (existing?.isDir) return existing;
    if (existing) throw new Error('exists');
    return this.mkdir(parent, name);
  }

  async createFile(
    parent: NodeRef,
    name: string,
    data: Uint8Array,
    resource = EMPTY,
    finderInfo?: Uint8Array,
  ): Promise<VNode> {
    const existing = await this.lookup(parent, name);
    if (existing) {
      existing.data = data;
      existing.resource = resource;
      if (finderInfo) existing.finderInfo = finderInfo;
      existing.modDate = Date.now();
      this.store(existing);
      return existing;
    }
    const n = this.makeChild(parent, name, false);
    n.data = data;
    n.resource = resource;
    if (finderInfo) n.finderInfo = finderInfo;
    this.store(n);
    this.notify(parent);
    return n;
  }

  async put(node: VNode): Promise<void> {
    this.store(node);
    this.notify(parentRef(node));
  }

  async rename(ref: NodeRef, newName: string): Promise<void> {
    const n = await this.get(ref);
    if (!n) throw new Error('not found');
    n.name = newName;
    n.modDate = Date.now();
    if (n.addr === 'path') {
      const dest = joinStorePath(n.parentPath, newName);
      this.pathNodes.delete(n.path);
      n.path = dest;
      this.pathNodes.set(dest, n);
      this.notify(n.parentPath);
      return;
    }
    this.store(n);
    this.notify(n.parentId);
  }

  async move(ref: NodeRef, newParent: NodeRef): Promise<void> {
    const n = await this.get(ref);
    if (!n) throw new Error('not found');
    const oldParent = parentRef(n);
    if (n.addr === 'path') {
      const destParent = String(newParent);
      const dest = joinStorePath(destParent, n.name);
      this.pathNodes.delete(n.path);
      n.parentPath = destParent;
      n.path = dest;
      this.pathNodes.set(dest, n);
    } else {
      n.parentId = Number(newParent);
      this.store(n);
    }
    this.notify(oldParent, newParent);
  }

  async remove(ref: NodeRef): Promise<void> {
    const n = await this.get(ref);
    if (!n) return;
    for (const k of await this.children(ref)) await this.remove(nodeRef(k));
    if (n.addr === 'path') this.pathNodes.delete(n.path);
    else this.cnidNodes.delete(n.id);
    this.notify(parentRef(n));
  }

  async importDataTransfer(parent: NodeRef, dt: DataTransfer, opts?: ImportProgress): Promise<number> {
    if (typeof parent !== 'number') {
      throw new Error('capability-catalog: host import uses cnid parent');
    }
    return importDataTransferInto(
      this,
      parent,
      dt,
      async (_pp, file) => {
        const buf = new Uint8Array(await file.arrayBuffer());
        return this.createFile(parent, file.name, buf);
      },
      opts,
    );
  }

  private makeChild(parent: NodeRef, name: string, isDir: boolean): VNode {
    const now = Date.now();
    if (this.caps.addressBy === 'path') {
      const parentPath = String(parent);
      const path = joinStorePath(parentPath, name);
      return {
        addr: 'path',
        path,
        parentPath,
        name,
        isDir,
        createDate: now,
        modDate: now,
        ...emptyForks(),
        data: new Uint8Array(),
        resource: new Uint8Array(),
        finderInfo: new Uint8Array(32),
      };
    }
    return {
      addr: 'cnid',
      id: this.nextId++,
      parentId: Number(parent),
      name,
      isDir,
      createDate: now,
      modDate: now,
      ...emptyForks(),
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: new Uint8Array(32),
    };
  }

  private store(n: VNode): void {
    if (n.addr === 'path') this.pathNodes.set(n.path, n);
    else this.cnidNodes.set(n.id, n);
  }

  private notify(...parents: NodeRef[]): void {
    if (this.batchDepth > 0) {
      for (const p of parents) this.batchParents.add(refKey(p));
      return;
    }
    this.emit(parents);
  }

  private emit(parentIds: NodeRef[]): void {
    for (const fn of this.listeners) fn({ parentIds });
  }
}

