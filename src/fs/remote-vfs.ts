/** AFP volume as a Finder Catalog (same API as IndexedDB VirtualFS). */

import { CNIDRoot } from '../protocol/afp/constants';
import type { AfpClient } from '../services/afp-client/client';
import type { DirEntry } from '../services/afp-client/commands';
import { unescapeHostFilename } from '../protocol/host-filename';
import { parseAppleDouble, parseAppleSingle, AS_MAGIC, AD_MAGIC } from './appledouble';
import { be32 } from '../protocol/binary';
import type { Catalog, CnidVNode, VNode, VfsChangeListener, ChildrenBatchListener } from './virtual-fs';
import { requireCnid, nodeRef } from './virtual-fs';
import { afpVolumeCaps, asCnid, fromUnixMs, toUnixMs, type CatalogCapabilities, type NodeRef } from './catalog-caps';
import { finderFlags, kIsInvisible, kNameLocked } from './finder-info';
import { importDataTransferInto, type ImportProgress } from './import-transfer';
import { finderInfoFromName } from './extension-map';
import { bufferRangeReader, type ByteRangeReader } from './byte-range';
import { loadFinderIconFork, ResourceFork, type ResourceForkLoadOpts } from './resource-fork';
import { iconForkLoadOptions } from './icon-cache';
import { isAbortError, throwIfAborted } from '../util/abort';

const EMPTY = new Uint8Array();

export class RemoteVfs implements Catalog {
  readonly reportsChunkedBytes = true;
  readonly client: AfpClient;
  readonly volumeName: string;
  readonly volId: number;
  private nodes = new Map<number, CnidVNode>();
  private forksLoaded = new Set<number>();
  private listeners = new Set<VfsChangeListener>();
  private batchDepth = 0;
  private batchParents = new Set<number>();

  constructor(client: AfpClient, volumeName: string, volId: number) {
    this.client = client;
    this.volumeName = volumeName;
    this.volId = volId;
    this.nodes.set(CNIDRoot, this.makeRoot());
  }

  capabilities(): CatalogCapabilities {
    return afpVolumeCaps;
  }

  rootId(): NodeRef {
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

  async get(ref: NodeRef): Promise<VNode | undefined> {
    if (typeof ref === 'string') return this.resolvePath(ref);
    return this.nodes.get(ref) ?? (ref === CNIDRoot ? this.ensureRoot() : undefined);
  }

  async resolvePath(path: string): Promise<VNode | undefined> {
    const parts = path.split('/').filter(Boolean);
    let cur: VNode | undefined = await this.get(CNIDRoot);
    for (const part of parts) {
      if (!cur) return undefined;
      cur = await this.lookup(nodeRef(cur), part);
    }
    return cur;
  }

  async pathOf(ref: NodeRef): Promise<string> {
    if (typeof ref === 'string') return ref;
    const names: string[] = [];
    let cur = await this.get(ref);
    while (cur && cur.addr === 'cnid' && cur.id !== CNIDRoot) {
      if (cur.name) names.unshift(cur.name);
      if (!cur.parentId || cur.parentId === cur.id) break;
      cur = await this.get(cur.parentId);
    }
    return names.join('/');
  }

  async setAttrs(ref: NodeRef, patch: Record<string, boolean>): Promise<void> {
    const node = await this.get(ref);
    if (!node) throw new Error('not found');
    node.attrs = { ...(node.attrs ?? {}), ...patch };
    if (node.finderInfo.length >= 10) {
      const fi = new Uint8Array(node.finderInfo);
      let flags = finderFlags(fi);
      if (patch.invisible != null) flags = patch.invisible ? flags | kIsInvisible : flags & ~kIsInvisible;
      if (patch.locked != null) flags = patch.locked ? flags | kNameLocked : flags & ~kNameLocked;
      fi[8] = (flags >> 8) & 0xff;
      fi[9] = flags & 0xff;
      node.finderInfo = fi;
    }
    await this.put(node);
  }

  async ensureContent(ref: NodeRef, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<VNode | undefined> {
    const id = asCnid(ref);
    const node = await this.get(id);
    if (!node || node.isDir) return node;
    if (!this.forksLoaded.has(id)) await this.hydrateForks(node, onBytes, signal);
    return node;
  }

  async children(
    parent: NodeRef,
    onBatch?: ChildrenBatchListener,
    signal?: AbortSignal,
  ): Promise<VNode[]> {
    const parentId = asCnid(parent);
    const kids: VNode[] = [];
    const seen = new Set<number>();
    const take = async (batch: DirEntry[]) => {
      let added = false;
      for (const e of batch) {
        if (!e.cnid || seen.has(e.cnid)) continue;
        seen.add(e.cnid);
        kids.push(this.adopt(e, parentId));
        added = true;
      }
      if (added) await onBatch?.(kids);
    };
    const entries = await this.client.list(parentId, '', this.volId, take, signal);
    await take(entries);
    return kids;
  }

  async lookup(parent: NodeRef, name: string, signal?: AbortSignal): Promise<VNode | undefined> {
    throwIfAborted(signal);
    const parentId = asCnid(parent);
    const lower = name.toLowerCase();
    for (const n of this.nodes.values()) {
      if (n.parentId === parentId && n.name.toLowerCase() === lower) return n;
    }
    try {
      const e = await this.client.stat(parentId, name, this.volId, signal);
      if (!e) return undefined;
      if (!e.name) e.name = name;
      return this.adopt(e, parentId);
    } catch (err) {
      if (isAbortError(err)) throw err;
      return undefined;
    }
  }

  async loadResourceFork(node: VNode, opts?: ResourceForkLoadOpts): Promise<ResourceFork | null> {
    throwIfAborted(opts?.signal);
    const resource = opts?.fork !== 'data';
    const loaded = resource ? node.resource.length : node.data.length;
    const hinted = resource ? (node.resourceBytes ?? loaded) : (node.dataBytes ?? loaded);
    if (Math.max(loaded, hinted) < 16) return null;
    try {
      const rangeOpts = { resource, signal: opts?.signal, priority: opts?.finderIcons ? 0 : 1 };
      const rf = await this.withRangeReader(
        node,
        (read) =>
          opts?.finderIcons
            ? loadFinderIconFork(read, iconForkLoadOptions(node))
            : ResourceFork.fromReader(read, opts?.want),
        rangeOpts,
      );
      rf?.bindFill((fn) => this.withRangeReader(node, fn, rangeOpts));
      return rf;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  async loadIconResources(node: VNode, signal?: AbortSignal): Promise<ResourceFork | null> {
    return this.loadResourceFork(node, { finderIcons: true, signal });
  }

  async loadDesktopIcons(
    type: string,
    creator: string,
    signal?: AbortSignal,
  ): Promise<{ iconType: number; data: Uint8Array }[] | null> {
    try {
      return await this.client.loadDesktopIcons(type, creator, this.volId, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  async withRangeReader<T>(
    node: VNode,
    fn: (read: ByteRangeReader) => Promise<T>,
    opts?: { resource?: boolean; signal?: AbortSignal; priority?: number },
  ): Promise<T> {
    throwIfAborted(opts?.signal);
    if (this.forksLoaded.has(requireCnid(node).id)) {
      const bytes = opts?.resource ? node.resource : node.data;
      return fn(bufferRangeReader(bytes));
    }
    return this.client.withForkReader(
      node.name,
      requireCnid(node).parentId,
      opts?.resource === true,
      fn,
      this.volId,
      opts?.signal,
    );
  }

  async mkdir(parent: NodeRef, name: string): Promise<VNode> {
    const parentId = asCnid(parent);
    const existing = await this.lookup(parentId, name);
    if (existing) throw new Error('exists');
    await this.client.mkdir(name, parentId, this.volId);
    const node = (await this.lookup(parentId, name)) ?? this.placeholderDir(parentId, name);
    this.notify(parentId);
    return node;
  }

  async ensureDir(parent: NodeRef, name: string): Promise<VNode> {
    const parentId = asCnid(parent);
    const existing = await this.lookup(parentId, name);
    if (existing?.isDir) return existing;
    if (existing) throw new Error('exists');
    return this.mkdir(parentId, name);
  }

  async createFile(
    parent: NodeRef,
    name: string,
    data: Uint8Array,
    resource = new Uint8Array(),
    finderInfo = finderInfoFromName(name),
    onBytes?: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<VNode> {
    throwIfAborted(signal);
    const parentId = asCnid(parent);
    await this.client.writeFile(name, data, parentId, false, this.volId, onBytes, signal);
    throwIfAborted(signal);
    if (resource.length) await this.client.writeFile(name, resource, parentId, true, this.volId, onBytes, signal);
    throwIfAborted(signal);
    if (finderInfo.some((b) => b !== 0)) {
      await this.client.setFinderInfo(name, finderInfo, parentId, this.volId);
    }
    const node =
      (await this.lookup(parentId, name)) ??
      this.placeholderFile(parentId, name, data, resource, finderInfo);
    if (node) {
      const cnid = requireCnid(node);
      node.data = data;
      node.resource = resource;
      node.finderInfo = finderInfo;
      node.dataBytes = data.length;
      node.resourceBytes = resource.length;
      this.forksLoaded.add(cnid.id);
      this.nodes.set(cnid.id, cnid);
    }
    this.notify(parentId);
    return node;
  }

  async put(node: VNode): Promise<void> {
    const n = requireCnid(node);
    this.nodes.set(n.id, n);
    await this.client.setFinderInfo(n.name, n.finderInfo, n.parentId, this.volId, {
      createDate: n.createDate ? fromUnixMs(n.createDate) : undefined,
      modDate: n.modDate ? fromUnixMs(n.modDate) : undefined,
    });
    this.notify(n.parentId);
  }

  async rename(ref: NodeRef, newName: string): Promise<void> {
    const id = asCnid(ref);
    const n = this.nodes.get(id) ?? requireCnid((await this.get(id))!);
    if (!n) throw new Error('not found');
    if (n.id === this.rootId()) throw new Error('cannot rename volume root');
    await this.client.rename(n.name, newName, n.parentId, this.volId);
    n.name = newName;
    n.modDate = Date.now();
    this.nodes.set(id, n);
    this.notify(n.parentId);
  }

  async move(ref: NodeRef, newParent: NodeRef): Promise<void> {
    const id = asCnid(ref);
    const parentId = asCnid(newParent);
    const n = this.nodes.get(id) ?? requireCnid((await this.get(id))!);
    if (!n) throw new Error('not found');
    if (n.id === this.rootId()) throw new Error('cannot move volume root');
    if (n.parentId === parentId) return;
    await this.client.moveAndRename(n.parentId, n.name, parentId, '', this.volId);
    const oldParent = n.parentId;
    n.parentId = parentId;
    n.modDate = Date.now();
    this.nodes.set(id, n);
    this.notify(oldParent, parentId);
  }

  async remove(ref: NodeRef): Promise<void> {
    const id = asCnid(ref);
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.id === this.rootId()) throw new Error('cannot delete volume root');
    if (n.isDir) {
      const kids = await this.children(id);
      for (const k of kids) await this.remove(nodeRef(k));
    }
    await this.client.remove(n.name, n.parentId, this.volId);
    this.nodes.delete(id);
    this.forksLoaded.delete(id);
    this.notify(n.parentId);
  }

  async importDataTransfer(parent: NodeRef, dt: DataTransfer, opts?: ImportProgress): Promise<number> {
    const parentId = asCnid(parent);
    return importDataTransferInto(this, parentId, dt, (p, file, onBytes, resource, signal) => this.importBlob(p, file, onBytes, resource, signal), opts);
  }

  private async importBlob(
    parent: NodeRef,
    file: File,
    onBytes?: (n: number) => void,
    resource?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<VNode> {
    const parentId = asCnid(parent);
    throwIfAborted(signal);
    const buf = new Uint8Array(await file.arrayBuffer());
    throwIfAborted(signal);
    const name = unescapeHostFilename(file.name);
    if (name.startsWith('._') && name.length > 2) {
      const ad = parseAppleDouble(buf);
      if (ad) {
        const target = name.slice(2);
        const existing = await this.lookup(parentId, target);
        if (existing && !existing.isDir) {
          const cnid = requireCnid(existing);
          const data = this.forksLoaded.has(cnid.id)
            ? existing.data
            : await this.client.readFile(existing.name, parentId, false, this.volId);
          return this.createFile(parentId, target, data, ad.resource, ad.finderInfo, onBytes, signal);
        }
        return this.createFile(parentId, target, new Uint8Array(), ad.resource, ad.finderInfo, onBytes, signal);
      }
    }
    if (buf.length >= 4 && be32(buf, 0) === AS_MAGIC) {
      const as = parseAppleSingle(buf);
      if (as) return this.createFile(parentId, name, as.data, as.resource, as.finderInfo, onBytes, signal);
    }
    if (buf.length >= 4 && be32(buf, 0) === AD_MAGIC) {
      const ad = parseAppleDouble(buf);
      if (ad) return this.createFile(parentId, name, new Uint8Array(), ad.resource, ad.finderInfo, onBytes, signal);
    }
    return this.createFile(parentId, name, buf, resource, undefined, onBytes, signal);
  }

  private async hydrateForks(node: VNode, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const n = requireCnid(node);
    try {
      node.data = await this.client.readFile(n.name, n.parentId, false, this.volId, onBytes, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      node.data = EMPTY;
    }
    try {
      node.resource = await this.client.readFile(n.name, n.parentId, true, this.volId, onBytes, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      node.resource = EMPTY;
    }
    node.dataBytes = node.data.length;
    node.resourceBytes = node.resource.length;
    this.forksLoaded.add(n.id);
    this.nodes.set(n.id, n);
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
      attributes?: number;
    },
    parentId: number,
  ): VNode {
    const prev = this.nodes.get(e.cnid);
    const node: CnidVNode = {
      addr: 'cnid',
      id: e.cnid,
      parentId: e.parentId || parentId,
      name: e.name,
      isDir: e.isDir,
      data: prev && this.forksLoaded.has(e.cnid) ? prev.data : EMPTY,
      resource: prev && this.forksLoaded.has(e.cnid) ? prev.resource : EMPTY,
      finderInfo: e.finderInfo?.length ? e.finderInfo.slice() : new Uint8Array(32),
      createDate: toUnixMs(e.createDate),
      modDate: toUnixMs(e.modDate),
      dataBytes: e.isDir ? 0 : e.dataLen,
      resourceBytes: e.isDir ? 0 : e.rsrcLen,
      ...(e.attributes ? { attributes: e.attributes } : {}),
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

  private makeRoot(): CnidVNode {
    return {
      addr: 'cnid',
      id: CNIDRoot,
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
    let n = this.nodes.get(CNIDRoot);
    if (!n) {
      n = this.makeRoot();
      this.nodes.set(n.id, n);
    }
    return n;
  }

  private placeholderDir(parentId: number, name: string): CnidVNode {
    const node: CnidVNode = {
      addr: 'cnid',
      id: Date.now() & 0x7fffffff,
      parentId,
      name,
      isDir: true,
      data: EMPTY,
      resource: EMPTY,
      finderInfo: new Uint8Array(32),
      createDate: Date.now(),
      modDate: Date.now(),
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
    const node: CnidVNode = {
      addr: 'cnid',
      id: Date.now() & 0x7fffffff,
      parentId,
      name,
      isDir: false,
      data,
      resource,
      finderInfo,
      createDate: Date.now(),
      modDate: Date.now(),
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
