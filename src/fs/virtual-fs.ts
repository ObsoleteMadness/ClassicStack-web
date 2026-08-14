/** IndexedDB-backed virtual AFP volume. */

import { openDB, type IDBPDatabase } from './idb-shim';
import { macTime } from '../protocol/afp/constants';
import { escapeHostFilename, unescapeHostFilename } from '../protocol/host-filename';
import { parseAppleDouble, parseAppleSingle, AS_MAGIC, AD_MAGIC } from './appledouble';
import { be32 } from '../protocol/binary';
import { importDataTransferInto } from './import-transfer';

export type VfsChange = { parentIds: number[] };
export type VfsChangeListener = (change: VfsChange) => void;

export interface VNode {
  id: number;
  parentId: number;
  name: string;
  isDir: boolean;
  data: Uint8Array;
  resource: Uint8Array;
  finderInfo: Uint8Array;
  createDate: number;
  modDate: number;
  /** Enumerated fork sizes when `data`/`resource` are not loaded (remote AFP). */
  dataBytes?: number;
  resourceBytes?: number;
}

/** Finder catalog: local IndexedDB share and remote AFP volumes both implement this. */
export interface Catalog {
  rootId(): number;
  subscribe(fn: VfsChangeListener): () => void;
  beginBatch(): void;
  endBatch(): void;
  get(id: number): Promise<VNode | undefined>;
  /** Load data/resource forks if the catalog stores them separately (remote AFP). */
  ensureContent(id: number): Promise<VNode | undefined>;
  children(parentId: number): Promise<VNode[]>;
  lookup(parentId: number, name: string): Promise<VNode | undefined>;
  mkdir(parentId: number, name: string): Promise<VNode>;
  ensureDir(parentId: number, name: string): Promise<VNode>;
  createFile(
    parentId: number,
    name: string,
    data: Uint8Array,
    resource?: Uint8Array,
    finderInfo?: Uint8Array,
  ): Promise<VNode>;
  put(node: VNode): Promise<void>;
  rename(id: number, newName: string): Promise<void>;
  move(id: number, newParent: number): Promise<void>;
  remove(id: number): Promise<void>;
  importDataTransfer(
    parentId: number,
    dt: DataTransfer,
    opts?: {
      onScan?: (total: number) => void;
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<number>;
}

const ROOT_ID = 2;

export class VirtualFS implements Catalog {
  private db!: IDBPDatabase;
  private nextId = 100;
  private listeners = new Set<VfsChangeListener>();
  private batchDepth = 0;
  private batchParents = new Set<number>();
  /** parentId\\0lowerName → node id; active during beginBatch/endBatch. */
  private nameCache: Map<string, number> | null = null;
  private nameCacheLoadedParents = new Set<number>();

  /** Observe catalog mutations (create/write/delete/rename). Returns unsubscribe. */
  subscribe(fn: VfsChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Coalesce notifications (e.g. during bulk import). Nested calls are supported. */
  beginBatch(): void {
    this.batchDepth++;
    if (this.batchDepth === 1) {
      this.nameCache = new Map();
      this.nameCacheLoadedParents.clear();
    }
  }

  endBatch(): void {
    if (this.batchDepth <= 0) return;
    this.batchDepth--;
    if (this.batchDepth === 0) {
      this.nameCache = null;
      this.nameCacheLoadedParents.clear();
      if (this.batchParents.size > 0) {
        const parentIds = [...this.batchParents];
        this.batchParents.clear();
        this.emitChange(parentIds);
      }
    }
  }

  private notifyChange(...parentIds: number[]): void {
    if (this.batchDepth > 0) {
      for (const id of parentIds) this.batchParents.add(id);
      return;
    }
    this.emitChange(parentIds);
  }

  private emitChange(parentIds: number[]): void {
    if (parentIds.length === 0) return;
    const change: VfsChange = { parentIds: [...new Set(parentIds)] };
    for (const fn of this.listeners) {
      try {
        fn(change);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  async init(): Promise<void> {
    this.db = await openDB('classicstack-share', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('nodes')) {
          const store = db.createObjectStore('nodes', { keyPath: 'id' });
          store.createIndex('parentId', 'parentId');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('desktop')) {
          db.createObjectStore('desktop', { keyPath: 'key' });
        }
      },
    });
    const root = await this.get(ROOT_ID);
    if (!root) {
      await this.put({
        id: ROOT_ID,
        parentId: 1,
        name: '',
        isDir: true,
        data: new Uint8Array(),
        resource: new Uint8Array(),
        finderInfo: new Uint8Array(32),
        createDate: macTime(),
        modDate: macTime(),
      });
    }
    const meta = await this.db.get('meta', 'nextId');
    if (meta) this.nextId = meta.value as number;
  }

  rootId(): number {
    return ROOT_ID;
  }

  async get(id: number): Promise<VNode | undefined> {
    const n = await this.db.get('nodes', id);
    return n ? revive(n) : undefined;
  }

  async put(node: VNode): Promise<void> {
    await this.db.put('nodes', serialize(node));
    this.rememberName(node.parentId, node.name, node.id);
    this.notifyChange(node.parentId);
  }

  async remove(id: number): Promise<void> {
    const node = await this.get(id);
    const parentId = node?.parentId;
    const kids = await this.children(id);
    for (const k of kids) await this.removeQuiet(k.id);
    await this.db.delete('nodes', id);
    if (node && parentId != null) this.forgetName(parentId, node.name);
    if (parentId != null) this.notifyChange(parentId);
  }

  /** Recursive delete without per-node notifications (parent remove notifies once). */
  private async removeQuiet(id: number): Promise<void> {
    const kids = await this.children(id);
    for (const k of kids) await this.removeQuiet(k.id);
    await this.db.delete('nodes', id);
  }

  async children(parentId: number): Promise<VNode[]> {
    const all = await this.db.getAllFromIndex('nodes', 'parentId', parentId);
    return all.map(revive);
  }

  async lookup(parentId: number, name: string): Promise<VNode | undefined> {
    const lower = name.toLowerCase();
    if (this.nameCache) {
      await this.ensureParentNameCache(parentId);
      const id = this.nameCache.get(nameCacheKey(parentId, lower));
      if (id == null) return undefined;
      return this.get(id);
    }
    const all = await this.db.getAllFromIndex('nodes', 'parentId', parentId);
    const raw = all.find((k) => (k.name as string).toLowerCase() === lower);
    return raw ? revive(raw) : undefined;
  }

  private rememberName(parentId: number, name: string, id: number): void {
    this.nameCache?.set(nameCacheKey(parentId, name.toLowerCase()), id);
  }

  private forgetName(parentId: number, name: string): void {
    this.nameCache?.delete(nameCacheKey(parentId, name.toLowerCase()));
  }

  /** Load sibling names once per parent during a batch (avoids O(n²) full revives). */
  private async ensureParentNameCache(parentId: number): Promise<void> {
    if (!this.nameCache || this.nameCacheLoadedParents.has(parentId)) return;
    const all = await this.db.getAllFromIndex('nodes', 'parentId', parentId);
    for (const raw of all) {
      this.nameCache.set(nameCacheKey(parentId, (raw.name as string).toLowerCase()), raw.id as number);
    }
    this.nameCacheLoadedParents.add(parentId);
  }

  async mkdir(parentId: number, name: string): Promise<VNode> {
    const existing = await this.lookup(parentId, name);
    if (existing) throw new Error('exists');
    const node: VNode = {
      id: await this.allocId(),
      parentId,
      name,
      isDir: true,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: new Uint8Array(32),
      createDate: macTime(),
      modDate: macTime(),
    };
    await this.put(node);
    return node;
  }

  /** Get or create a directory under parent (merge into existing dirs). */
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
    finderInfo = defaultFinder(name),
  ): Promise<VNode> {
    const existing = await this.lookup(parentId, name);
    if (existing) {
      existing.data = data;
      existing.resource = resource;
      existing.finderInfo = finderInfo;
      existing.modDate = macTime();
      await this.put(existing);
      return existing;
    }
    const node: VNode = {
      id: await this.allocId(),
      parentId,
      name,
      isDir: false,
      data,
      resource,
      finderInfo,
      createDate: macTime(),
      modDate: macTime(),
    };
    await this.put(node);
    return node;
  }

  async importBlob(parentId: number, file: File): Promise<VNode> {
    const buf = new Uint8Array(await file.arrayBuffer());
    // Host FS may store reserved Mac chars as OmniTalk "0xNN" tokens (Icon\r → Icon0x0D).
    const name = unescapeHostFilename(file.name);

    // macOS AppleDouble sidecar (._Name) → merge into Name (either import order).
    if (name.startsWith('._') && name.length > 2) {
      const target = name.slice(2);
      const ad = parseAppleDouble(buf);
      if (ad) {
        const leftover =
          (await this.lookup(parentId, name)) ?? (await this.lookup(parentId, file.name));
        const node = await this.applyAppleDoubleSidecar(parentId, target, ad);
        if (leftover && leftover.id !== node.id) await this.remove(leftover.id);
        return node;
      }
    }

    if (buf.length >= 4 && be32(buf, 0) === AS_MAGIC) {
      const as = parseAppleSingle(buf);
      if (as) {
        return this.createFile(parentId, name, as.data, as.resource, as.finderInfo);
      }
    }
    if (buf.length >= 4 && be32(buf, 0) === AD_MAGIC) {
      const ad = parseAppleDouble(buf);
      if (ad) {
        return this.createFile(parentId, name, new Uint8Array(), ad.resource, ad.finderInfo);
      }
    }

    // Plain data fork: keep resource/FinderInfo if a sidecar arrived first, and
    // absorb any leftover ._Name sibling from an earlier incomplete import.
    const existing = await this.lookup(parentId, name);
    if (existing && !existing.isDir) {
      existing.data = buf;
      existing.modDate = macTime();
      await this.put(existing);
      await this.consumeNamedSidecar(parentId, name, existing);
      return existing;
    }

    const node = await this.createFile(parentId, name, buf);
    await this.consumeNamedSidecar(parentId, name, node);
    return node;
  }

  /** Apply AppleDouble metadata to target Name (create empty data fork if needed). */
  private async applyAppleDoubleSidecar(
    parentId: number,
    targetName: string,
    ad: { finderInfo: Uint8Array; resource: Uint8Array },
  ): Promise<VNode> {
    const existing = await this.lookup(parentId, targetName);
    if (existing?.isDir) throw new Error('exists');
    if (existing) {
      existing.resource = ad.resource;
      existing.finderInfo = ad.finderInfo;
      existing.modDate = macTime();
      await this.put(existing);
      return existing;
    }
    return this.createFile(parentId, targetName, new Uint8Array(), ad.resource, ad.finderInfo);
  }

  /** If ._Name exists as its own node, merge AppleDouble into `into` and delete it. */
  private async consumeNamedSidecar(parentId: number, dataName: string, into: VNode): Promise<void> {
    const sidecarName = `._${dataName}`;
    const sidecar =
      (await this.lookup(parentId, sidecarName)) ??
      (await this.lookup(parentId, escapeHostFilename(sidecarName)));
    if (!sidecar || sidecar.isDir) return;
    const ad = parseAppleDouble(sidecar.data);
    if (ad) {
      into.resource = ad.resource;
      into.finderInfo = ad.finderInfo;
      into.modDate = macTime();
      await this.put(into);
    }
    await this.remove(sidecar.id);
  }

  async ensureContent(id: number): Promise<VNode | undefined> {
    return this.get(id);
  }

  /**
   * Import files and folders from a drag-and-drop DataTransfer.
   * Uses FileSystemEntry (directory trees) when available; falls back to FileList
   * + webkitRelativePath. Returns the number of top-level items imported.
   * Notifications are batched for the whole import.
   */
  async importDataTransfer(
    parentId: number,
    dt: DataTransfer,
    opts?: {
      onScan?: (total: number) => void;
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<number> {
    return importDataTransferInto(this, parentId, dt, (p, file) => this.importBlob(p, file), opts);
  }

  async rename(id: number, newName: string): Promise<void> {
    const n = await this.get(id);
    if (!n) throw new Error('not found');
    const oldName = n.name;
    n.name = newName;
    n.modDate = macTime();
    if (oldName.toLowerCase() !== newName.toLowerCase()) {
      this.forgetName(n.parentId, oldName);
    }
    await this.put(n);
  }

  async move(id: number, newParent: number): Promise<void> {
    const n = await this.get(id);
    if (!n) throw new Error('not found');
    const oldParent = n.parentId;
    n.parentId = newParent;
    n.modDate = macTime();
    await this.db.put('nodes', serialize(n));
    this.forgetName(oldParent, n.name);
    this.rememberName(newParent, n.name, n.id);
    this.notifyChange(oldParent, newParent);
  }

  private async allocId(): Promise<number> {
    const id = this.nextId++;
    await this.db.put('meta', { key: 'nextId', value: this.nextId });
    return id;
  }

  // Desktop DB helpers
  async desktopGet(key: string): Promise<Uint8Array | undefined> {
    const row = await this.db.get('desktop', key);
    return row ? toUint8(row.data) : undefined;
  }

  async desktopSet(key: string, data: Uint8Array): Promise<void> {
    await this.db.put('desktop', { key, data });
  }
}

function defaultFinder(name: string): Uint8Array {
  const fi = new Uint8Array(32);
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const map: Record<string, [string, string]> = {
    txt: ['TEXT', 'ttxt'],
    text: ['TEXT', 'ttxt'],
    md: ['TEXT', 'ttxt'],
    html: ['TEXT', 'MOSS'],
    htm: ['TEXT', 'MOSS'],
    jpg: ['JPEG', 'ogle'],
    jpeg: ['JPEG', 'ogle'],
    png: ['PNGf', 'ogle'],
    gif: ['GIFf', 'ogle'],
    pdf: ['PDF ', 'CARO'],
    sit: ['SIT!', 'SIT!'],
    bin: ['BINA', 'hDmp'],
    hqx: ['TEXT', 'BinH'],
  };
  const pair = map[ext] ?? ['????', '????'];
  const type = pair[0];
  const creator = pair[1];
  for (let i = 0; i < 4; i++) {
    fi[i] = type.charCodeAt(i) || 0x20;
    fi[4 + i] = creator.charCodeAt(i) || 0x20;
  }
  return fi;
}

function nameCacheKey(parentId: number, lowerName: string): string {
  return `${parentId}\0${lowerName}`;
}

function serialize(n: VNode): Record<string, unknown> {
  // Store forks as binary (Uint8Array). IndexedDB structured-clone handles this
  // without the huge cost of Array.from → number[] → revive.
  return {
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    isDir: n.isDir,
    data: n.data,
    resource: n.resource,
    finderInfo: n.finderInfo,
    createDate: n.createDate,
    modDate: n.modDate,
  };
}

function toUint8(raw: unknown, minLen = 0): Uint8Array {
  if (raw instanceof Uint8Array) {
    return minLen > 0 && raw.length < minLen ? padUint8(raw, minLen) : raw;
  }
  if (raw instanceof ArrayBuffer) {
    const u = new Uint8Array(raw);
    return minLen > 0 && u.length < minLen ? padUint8(u, minLen) : u;
  }
  if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView;
    const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return minLen > 0 && u.length < minLen ? padUint8(u, minLen) : u;
  }
  if (Array.isArray(raw)) {
    // Legacy rows stored forks as number[].
    const u = Uint8Array.from(raw as number[]);
    return minLen > 0 && u.length < minLen ? padUint8(u, minLen) : u;
  }
  return new Uint8Array(minLen);
}

function padUint8(src: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  out.set(src.subarray(0, len));
  return out;
}

function revive(raw: Record<string, unknown>): VNode {
  return {
    id: raw.id as number,
    parentId: raw.parentId as number,
    name: raw.name as string,
    isDir: raw.isDir as boolean,
    data: toUint8(raw.data),
    resource: toUint8(raw.resource),
    finderInfo: toUint8(raw.finderInfo, 32),
    createDate: raw.createDate as number,
    modDate: raw.modDate as number,
  };
}
