import { CNIDRoot } from '../protocol/afp/constants';
import type { VNode, VfsChangeListener, ChildrenBatchListener } from '../fs/virtual-fs';
import { nodeRef, parentRef } from '../fs/virtual-fs';
import { asCnid, catalogCapsForSession, refKey, toUnixMs, type CatalogCapabilities, type NodeRef } from '../fs/catalog-caps';
import { importDataTransferInto, type ImportProgress } from '../fs/import-transfer';
import { finderInfoFromName } from '../fs/extension-map';
import { bufferRangeReader, type ByteRangeReader } from '../fs/byte-range';
import { loadFinderIconFork, ResourceFork, type ResourceForkLoadOpts } from '../fs/resource-fork';
import { iconForkLoadOptions } from '../fs/icon-cache';
import { throwIfAborted, isAbortError } from '../util/abort';
import { parseAppleDouble, parseAppleSingle, AS_MAGIC, AD_MAGIC } from '../fs/appledouble';
import { be32 } from '../protocol/binary';
import { unescapeHostFilename } from '../protocol/host-filename';
import type { CatalogWithBackend, FinderAPI } from './api';
import type { FinderNodeDto, FinderSessionDto, TransferOptions } from './types';
import { consumeProgress } from './progress';

const EMPTY = new Uint8Array();

function b64ToBytes(s = ''): Uint8Array {
  if (!s) return new Uint8Array();
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class ApiCatalog implements CatalogWithBackend {
  readonly reportsChunkedBytes = true;
  readonly sessionId: string;
  readonly api: FinderAPI;
  private caps: CatalogCapabilities;
  private root: NodeRef;
  private nodes = new Map<string, VNode>();
  private forksLoaded = new Set<string>();
  private listeners = new Set<VfsChangeListener>();
  private batchDepth = 0;
  private batchParents = new Set<string>();

  constructor(api: FinderAPI, session: FinderSessionDto) {
    this.api = api;
    this.sessionId = session.sessionId;
    this.caps = catalogCapsForSession(session);
    this.root = this.caps.addressBy === 'path' ? (session.rootPath ?? '') : (session.rootId || CNIDRoot);
  }

  capabilities(): CatalogCapabilities { return this.caps; }
  rootId(): NodeRef { return this.root; }
  subscribe(fn: VfsChangeListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  beginBatch(): void { this.batchDepth++; }
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
    const cached = this.nodes.get(refKey(ref));
    if (cached) return cached;
    try {
      return this.adopt(await this.api.getNode(this.sessionId, ref));
    } catch {
      return ref === this.root || ref === '' || ref === this.rootId() ? this.ensureRoot() : undefined;
    }
  }

  async ensureContent(ref: NodeRef, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<VNode | undefined> {
    const node = await this.get(ref);
    if (!node || node.isDir) return node;
    const key = refKey(nodeRef(node));
    if (!this.forksLoaded.has(key)) await this.hydrateForks(node, onBytes, signal);
    return node;
  }

  async children(parent: NodeRef, onBatch?: ChildrenBatchListener, signal?: AbortSignal): Promise<VNode[]> {
    throwIfAborted(signal);
    const raw = await this.api.children(this.sessionId, parent);
    const kids = raw.map((n) => this.adopt(n));
    await onBatch?.(kids);
    return kids;
  }

  async lookup(parent: NodeRef, name: string, signal?: AbortSignal): Promise<VNode | undefined> {
    throwIfAborted(signal);
    const lower = name.toLowerCase();
    for (const n of this.nodes.values()) {
      if (parentRef(n) === parent && n.name.toLowerCase() === lower) return n;
    }
    const raw = await this.api.lookup(this.sessionId, parent, name);
    return raw ? this.adopt(raw) : undefined;
  }

  async resolvePath(path: string): Promise<VNode | undefined> {
    if (this.caps.addressBy === 'path') return this.get(path);
    try {
      const raw = await this.api.resolvePath(this.sessionId, path);
      return raw ? this.adopt(raw) : undefined;
    } catch {
      const parts = path.split('/').filter(Boolean);
      let cur: VNode | undefined = await this.get(this.root);
      for (const part of parts) {
        if (!cur) return undefined;
        cur = await this.lookup(nodeRef(cur), part);
      }
      return cur;
    }
  }

  async pathOf(ref: NodeRef): Promise<string> {
    if (this.caps.addressBy === 'path') return String(ref);
    try {
      return await this.api.pathOf(this.sessionId, ref);
    } catch {
      return '';
    }
  }

  async setAttrs(ref: NodeRef, patch: Record<string, boolean>): Promise<void> {
    if (this.api.writeAttrs) await this.api.writeAttrs(this.sessionId, ref, patch);
    const n = await this.get(ref);
    if (n) {
      n.attrs = { ...(n.attrs ?? {}), ...patch };
      this.nodes.set(refKey(nodeRef(n)), n);
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

  async withRangeReader<T>(
    node: VNode,
    fn: (read: ByteRangeReader) => Promise<T>,
    opts?: { resource?: boolean; signal?: AbortSignal; priority?: number },
  ): Promise<T> {
    throwIfAborted(opts?.signal);
    if (this.forksLoaded.has(refKey(nodeRef(node)))) {
      const bytes = opts?.resource ? node.resource : node.data;
      return fn(bufferRangeReader(bytes));
    }
    const read: ByteRangeReader = (offset, count) =>
      this.api.readFork(this.sessionId, nodeRef(node), !!opts?.resource, offset, count);
    return fn(read);
  }

  async mkdir(parent: NodeRef, name: string): Promise<VNode> {
    const existing = await this.lookup(parent, name);
    if (existing) throw new Error('exists');
    const node = this.adopt(await this.api.mkdir(this.sessionId, parent, name));
    this.notify(parent);
    return node;
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
    resource = new Uint8Array(),
    finderInfo = finderInfoFromName(name),
    onBytes?: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<VNode> {
    throwIfAborted(signal);
    const raw = await this.api.create(this.sessionId, parent, name, { finderInfo });
    const node = this.adopt(raw);
    const id = nodeRef(node);
    if (data.length) await this.writeFork(id, false, data, onBytes, signal);
    throwIfAborted(signal);
    if (resource.length) await this.writeFork(id, true, resource, onBytes, signal);
    node.data = data;
    node.resource = resource;
    node.finderInfo = finderInfo;
    node.dataBytes = data.length;
    node.resourceBytes = resource.length;
    this.forksLoaded.add(refKey(id));
    this.nodes.set(refKey(id), node);
    this.notify(parent);
    return node;
  }

  async put(node: VNode): Promise<void> {
    const id = nodeRef(node);
    this.nodes.set(refKey(id), node);
    await this.api.writeFinderInfo(this.sessionId, id, node.finderInfo);
    this.notify(parentRef(node));
  }

  async rename(ref: NodeRef, newName: string): Promise<void> {
    const n = this.nodes.get(refKey(ref)) ?? (await this.get(ref));
    if (!n) throw new Error('not found');
    if (nodeRef(n) === this.rootId()) throw new Error('cannot rename volume root');
    await this.api.rename(this.sessionId, ref, newName);
    n.name = newName;
    this.nodes.set(refKey(nodeRef(n)), n);
    this.notify(parentRef(n));
  }

  async move(ref: NodeRef, newParent: NodeRef): Promise<void> {
    const n = this.nodes.get(refKey(ref)) ?? (await this.get(ref));
    if (!n) throw new Error('not found');
    if (nodeRef(n) === this.rootId()) throw new Error('cannot move volume root');
    if (parentRef(n) === newParent) return;
    await this.api.move(this.sessionId, ref, newParent);
    const oldParent = parentRef(n);
    if (n.addr === 'path') n.parentPath = String(newParent);
    else n.parentId = Number(newParent);
    this.nodes.set(refKey(nodeRef(n)), n);
    this.notify(oldParent, newParent);
  }

  async remove(ref: NodeRef): Promise<void> {
    const n = this.nodes.get(refKey(ref)) ?? (await this.get(ref));
    if (!n) return;
    if (nodeRef(n) === this.rootId()) throw new Error('cannot delete volume root');
    if (n.isDir) {
      const kids = await this.children(ref);
      for (const k of kids) await this.remove(nodeRef(k));
    }
    await this.api.remove(this.sessionId, ref);
    this.nodes.delete(refKey(ref));
    this.forksLoaded.delete(refKey(ref));
    this.notify(parentRef(n));
  }

  async importDataTransfer(parent: NodeRef, dt: DataTransfer, opts?: ImportProgress): Promise<number> {
    if (typeof parent !== 'number') throw new Error('host import requires a CNID parent');
    return importDataTransferInto(
      this,
      parent,
      dt,
      (p, file, onBytes, resource, signal) => this.importBlob(p, file, onBytes, resource, signal),
      opts,
    );
  }

  async copyFrom(src: CatalogWithBackend, srcId: NodeRef, destParent: NodeRef, opts: TransferOptions): Promise<void> {
    await consumeProgress(
      this.api.copy(
        {
          srcSession: src.sessionId,
          destSession: this.sessionId,
          srcId,
          destParentId: destParent,
          destName: opts.destName,
          replace: !!opts.replace,
        },
        opts.signal,
      ),
      opts.onProgress,
      opts.signal,
    );
    this.notify(destParent);
  }

  async moveFrom(src: CatalogWithBackend, srcId: NodeRef, destParent: NodeRef, opts: TransferOptions): Promise<void> {
    if (src.api.backendId === this.api.backendId && src.sessionId === this.sessionId) {
      if (opts.replaceId != null) await this.remove(opts.replaceId);
      if (opts.destName) await src.rename(srcId, opts.destName);
      await src.move(srcId, destParent);
      this.notify(destParent);
      return;
    }
    await consumeProgress(
      this.api.moveAcross(
        {
          srcSession: src.sessionId,
          destSession: this.sessionId,
          srcId,
          destParentId: destParent,
          destName: opts.destName,
          replace: !!opts.replace,
        },
        opts.signal,
      ),
      opts.onProgress,
      opts.signal,
    );
    this.notify(destParent);
  }

  async expandNode(ref: NodeRef, opts?: Pick<TransferOptions, 'signal' | 'onProgress'>): Promise<void> {
    await consumeProgress(this.api.expand(this.sessionId, ref, opts?.signal), opts?.onProgress, opts?.signal);
    const node = await this.get(ref);
    if (node) this.notify(parentRef(node));
  }

  private async importBlob(
    parent: NodeRef,
    file: File,
    onBytes?: (n: number) => void,
    resource?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const parentId = asCnid(parent);
    throwIfAborted(signal);
    const buf = new Uint8Array(await file.arrayBuffer());
    const name = unescapeHostFilename(file.name);
    if (name.startsWith('._') && name.length > 2) {
      const ad = parseAppleDouble(buf);
      if (ad) {
        const target = name.slice(2);
        const existing = await this.lookup(parentId, target);
        if (existing && !existing.isDir) {
          const data = this.forksLoaded.has(refKey(nodeRef(existing)))
            ? existing.data
            : await this.readWholeFork(nodeRef(existing), false, onBytes, signal);
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
    return this.createFile(parentId, name, buf, resource ?? EMPTY, undefined, onBytes, signal);
  }

  private async hydrateForks(node: VNode, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      node.data = await this.readWholeFork(nodeRef(node), false, onBytes, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      node.data = EMPTY;
    }
    try {
      node.resource = await this.readWholeFork(nodeRef(node), true, onBytes, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      node.resource = EMPTY;
    }
    node.dataBytes = node.data.length;
    node.resourceBytes = node.resource.length;
    this.forksLoaded.add(refKey(nodeRef(node)));
    this.nodes.set(refKey(nodeRef(node)), node);
  }

  private async writeFork(
    id: NodeRef,
    resource: boolean,
    data: Uint8Array,
    onBytes?: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const chunk = 256 * 1024;
    for (let off = 0; off < data.length; off += chunk) {
      throwIfAborted(signal);
      const slice = data.subarray(off, Math.min(data.length, off + chunk));
      await this.api.writeFork(this.sessionId, id, resource, off, slice);
      onBytes?.(slice.length);
    }
  }

  private async readWholeFork(
    id: NodeRef,
    resource: boolean,
    onBytes?: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const buf = await this.api.readFork(this.sessionId, id, resource);
    const chunk = 256 * 1024;
    if (onBytes) for (let i = 0; i < buf.length; i += chunk) onBytes(Math.min(chunk, buf.length - i));
    throwIfAborted(signal);
    return buf;
  }

  private adopt(raw: FinderNodeDto): VNode {
    const key = raw.addr === 'path' ? refKey(raw.path) : refKey(raw.id);
    const prev = this.nodes.get(key);
    const loaded = this.forksLoaded.has(key);
    const finderInfo = b64ToBytes(raw.finderInfo);
    const common = {
      name: raw.name,
      isDir: raw.isDir,
      data: loaded && prev ? prev.data : EMPTY,
      resource: loaded && prev ? prev.resource : EMPTY,
      finderInfo: finderInfo.length ? finderInfo : new Uint8Array(32),
      createDate: toUnixMs(raw.createDate ?? 0),
      modDate: toUnixMs(raw.modDate ?? 0),
      accessDate: raw.accessDate != null ? toUnixMs(raw.accessDate) : undefined,
      dataBytes: raw.isDir ? 0 : (raw.dataBytes ?? 0),
      resourceBytes: raw.isDir ? 0 : (raw.resourceBytes ?? 0),
      shortName: raw.shortName,
      mediumName: raw.mediumName,
      attrs: raw.attrs,
    };
    const node: VNode = raw.addr === 'path'
      ? { addr: 'path', path: raw.path, parentPath: raw.parentPath, ...common }
      : { addr: 'cnid', id: raw.id, parentId: raw.parentId, ...common };
    if (!raw.isDir && loaded && prev) {
      node.dataBytes = prev.data.length;
      node.resourceBytes = prev.resource.length;
    }
    this.nodes.set(refKey(nodeRef(node)), node);
    return node;
  }

  private ensureRoot(): VNode {
    const existing = this.nodes.get(refKey(this.root));
    if (existing) return existing;
    const root: VNode = this.caps.addressBy === 'path'
      ? {
          addr: 'path',
          path: '',
          parentPath: '',
          name: '',
          isDir: true,
          data: EMPTY,
          resource: EMPTY,
          finderInfo: new Uint8Array(32),
          createDate: 0,
          modDate: 0,
        }
      : {
          addr: 'cnid',
          id: typeof this.root === 'number' ? this.root : CNIDRoot,
          parentId: 1,
          name: '',
          isDir: true,
          data: EMPTY,
          resource: EMPTY,
          finderInfo: new Uint8Array(32),
          createDate: 0,
          modDate: 0,
        };
    this.nodes.set(refKey(nodeRef(root)), root);
    return root;
  }

  private notify(...parentIds: NodeRef[]): void {
    if (this.batchDepth > 0) {
      for (const id of parentIds) this.batchParents.add(refKey(id));
      return;
    }
    this.emit(parentIds);
  }

  private emit(parentIds: NodeRef[]): void {
    const change = { parentIds };
    for (const fn of this.listeners) fn(change);
  }
}
