/** Shared DataTransfer import for local IndexedDB and remote AFP catalogs. */

import { hfsTimeToAfp } from '../protocol/afp/constants';
import { unescapeHostFilename } from '../protocol/host-filename';
import { loadPrefs } from '../util/prefs';
import { log } from '../util/logger';
import { expandIncoming, isExpandableArchive, type ExpandedDir, type ExpandedFile, type ExpandedNode } from './expand-incoming';
import type { Catalog, VNode } from './virtual-fs';
import { throwIfAborted, isAbortError, abortError } from '../util/abort';
import {
  planItemPlacement,
  TransferCancelled,
  type NameConflictChoice,
  type PlacementPlan,
} from './name-conflict';

export type ExpandTrackFile = {
  name: string;
  /** Archive-relative path, unique among siblings of the same parent job. */
  path: string;
  bytesTotal: number;
  finderInfo?: Uint8Array;
};

export type ImportItemTrack = {
  onBytes?: (n: number) => void;
  onDone?: (err?: Error) => void;
  /** Reset the parent job and announce every extracted file (queued) before writes start. */
  onExpandBegin?: (bytesTotal: number, files: ExpandTrackFile[]) => void;
  /** Nested job while a dropped wrapper is decoded (BinHex / MacBinary / later StuffIt). */
  onExpand?: (item: ExpandTrackFile) => ImportItemTrack | undefined;
  signal?: AbortSignal;
  /** Delete a dest file left behind if this write is cancelled mid-flight. */
  removePartial?: (parentId: number, name: string) => Promise<void>;
};

export type ImportProgress = {
  onScan?: (total: number) => void;
  onProgress?: (done: number, total: number) => void;
  /** One callback per top-level drop item (a folder is a single item). */
  onItem?: (item: { name: string; isDir: boolean; bytesTotal: number }) => ImportItemTrack | undefined;
  resolveConflict?: (info: {
    name: string;
    isDir: boolean;
    suggestedName: string;
  }) => Promise<NameConflictChoice>;
};

type ImportBlob = (
  parentId: number,
  file: File,
  onBytes?: (n: number) => void,
  /** Host resource fork from `..namedfork/rsrc` (Chrome on macOS). */
  resource?: Uint8Array,
  signal?: AbortSignal,
) => Promise<unknown>;
type ImportFs = Pick<
  Catalog,
  'beginBatch' | 'endBatch' | 'ensureDir' | 'lookup' | 'remove' | 'createFile' | 'put'
>;

/**
 * Import files and folders from a drag-and-drop DataTransfer.
 * Uses FileSystemEntry (directory trees) when available; falls back to FileList
 * + webkitRelativePath. Returns the number of top-level items imported.
 */
export async function importDataTransferInto(
  fs: ImportFs,
  parentId: number,
  dt: DataTransfer,
  importBlob: ImportBlob,
  opts?: ImportProgress,
): Promise<number> {
  const entries = collectDataTransferEntries(dt);
  const total = entries.length > 0 ? await countFsEntries(entries) : dt.files.length;
  opts?.onScan?.(total);

  let done = 0;
  const tick = (): void => {
    done++;
    opts?.onProgress?.(done, total);
  };

  if (entries.length > 0) {
    const groups = groupTopLevelEntries(entries.sort(compareImportEntries));
    const plans = await planIncoming(fs, parentId, groups, opts?.resolveConflict);
    fs.beginBatch();
    try {
      let imported = 0;
      let cancelled = false;
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!;
        const plan = plans[i]!;
        await applyReplace(fs, plan);
        const bytesTotal = await measureGroupBytes(group.entries);
        const track = opts?.onItem?.({
          name: plan.destName,
          isDir: group.isDir,
          bytesTotal,
        });
        try {
          throwIfAborted(track?.signal);
          for (const entry of group.entries) {
            const asName = mappedIncomingName(unescapeHostFilename(entry.name), group.name, plan.destName);
            await importFsEntry(fs, parentId, entry, importBlob, tick, track, asName);
          }
          track?.onDone?.();
          imported++;
        } catch (err) {
          track?.onDone?.(err instanceof Error ? err : new Error(String(err)));
          if (isAbortError(err)) {
            cancelled = true;
            continue;
          }
          throw err;
        }
      }
      if (imported === 0 && cancelled) throw new TransferCancelled();
      return imported;
    } finally {
      fs.endBatch();
    }
  }

  const groups = groupFilesByTopLevel([...dt.files].sort(compareImportFiles));
  const plans = await planIncoming(fs, parentId, groups, opts?.resolveConflict);
  fs.beginBatch();
  try {
    let imported = 0;
    let cancelled = false;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      const plan = plans[i]!;
      await applyReplace(fs, plan);
      const bytesTotal = group.files.reduce((n, f) => n + f.size, 0);
      const track = opts?.onItem?.({
        name: plan.destName,
        isDir: group.isDir,
        bytesTotal,
      });
      try {
        throwIfAborted(track?.signal);
        for (const file of group.files) {
          const destTop = mappedIncomingName(
            topFileName(file),
            group.name,
            plan.destName,
          );
          await importFileWithRelativePath(fs, parentId, file, importBlob, track, destTop);
          tick();
        }
        track?.onDone?.();
        imported++;
      } catch (err) {
        track?.onDone?.(err instanceof Error ? err : new Error(String(err)));
        if (isAbortError(err)) {
          cancelled = true;
          continue;
        }
        throw err;
      }
    }
    if (imported === 0 && cancelled) throw new TransferCancelled();
    return imported;
  } finally {
    fs.endBatch();
  }
}

async function planIncoming(
  fs: ImportFs,
  parentId: number,
  groups: { name: string; isDir: boolean }[],
  resolveConflict?: ImportProgress['resolveConflict'],
): Promise<PlacementPlan[]> {
  if (!resolveConflict) {
    return groups.map((g) => ({ destName: g.name, replaceId: null }));
  }
  const reserved = new Set<string>();
  const plans: PlacementPlan[] = [];
  for (const g of groups) {
    const plan = await planItemPlacement(fs, parentId, g.name, g.isDir, { reserved, resolveConflict });
    if (!plan) throw new TransferCancelled();
    reserved.add(plan.destName.toLowerCase());
    plans.push(plan);
  }
  return plans;
}

async function applyReplace(fs: ImportFs, plan: PlacementPlan): Promise<void> {
  if (plan.replaceId != null) await fs.remove(plan.replaceId);
}

function mappedIncomingName(rawName: string, original: string, destName: string): string {
  if (destName === original) return rawName;
  if (rawName === original) return destName;
  if (isAppleDoubleSidecarName(rawName) && rawName.slice(2) === original) return `._${destName}`;
  return rawName;
}

function topFileName(file: File): string {
  const rel = file.webkitRelativePath;
  if (rel && rel.includes('/')) return unescapeHostFilename(rel.split('/')[0]!);
  return unescapeHostFilename(file.name);
}

async function importFsEntry(
  fs: ImportFs,
  parentId: number,
  entry: FileSystemEntry,
  importBlob: ImportBlob,
  onItem?: () => void,
  track?: ImportItemTrack,
  destName?: string,
  parentDir?: FileSystemDirectoryEntry,
): Promise<void> {
  if (isNamedForkDirName(entry.name)) return;
  throwIfAborted(track?.signal);
  const name = destName ?? unescapeHostFilename(entry.name);
  if (entry.isDirectory) {
    const dir = await fs.ensureDir(parentId, name);
    onItem?.();
    const folder = entry as FileSystemDirectoryEntry;
    const kids = (await readDirectoryEntries(folder)).sort(compareImportEntries);
    for (const kid of kids) {
      await importFsEntry(fs, dir.id, kid, importBlob, onItem, track, undefined, folder);
    }
    return;
  }
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await readFileEntry(fileEntry);
    const resource = await readNamedResourceForkForEntry(fileEntry, parentDir);
    await importOneFile(fs, parentId, fileWithName(file, name), importBlob, track, resource);
    onItem?.();
  }
}

async function importFileWithRelativePath(
  fs: ImportFs,
  parentId: number,
  file: File,
  importBlob: ImportBlob,
  track?: ImportItemTrack,
  destTop?: string,
): Promise<void> {
  throwIfAborted(track?.signal);
  const rel = file.webkitRelativePath;
  if (!rel || !rel.includes('/')) {
    const name = destTop ?? unescapeHostFilename(file.name);
    await importOneFile(fs, parentId, fileWithName(file, name), importBlob, track);
    return;
  }
  const parts = rel.split('/');
  if (destTop) parts[0] = destTop;
  let dirId = parentId;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!part || part === '.' || part === '..') continue;
    dirId = (await fs.ensureDir(dirId, unescapeHostFilename(part))).id;
  }
  await importOneFile(fs, dirId, file, importBlob, track);
}

async function importOneFile(
  fs: ImportFs,
  parentId: number,
  file: File,
  importBlob: ImportBlob,
  track?: ImportItemTrack,
  resource?: Uint8Array | null,
): Promise<void> {
  const name = unescapeHostFilename(file.name);
  const onBytes = track?.onBytes;
  const hostResource = resource?.length ? resource : undefined;
  throwIfAborted(track?.signal);
  if (hostResource) {
    log.info(`Imported resource fork for “${name}” (${hostResource.length} bytes)`, 'import');
  }
  if (!loadPrefs().autoExpandFiles || !shouldTryExpand(name)) {
    await writeTrackedBlob(parentId, name, () => importBlob(parentId, file, onBytes, hostResource, track?.signal), track);
    return;
  }
  const buf = await readBlobProgress(file, onBytes, track?.signal);
  throwIfAborted(track?.signal);
  let expanded: ExpandedNode[] | null = null;
  try {
    expanded = expandIncoming(name, buf);
  } catch (err) {
    log.warn(`Couldn’t auto-expand “${name}”: ${err instanceof Error ? err.message : err}`, 'expand');
  }
  if (!expanded) {
    await writeTrackedBlob(
      parentId,
      name,
      () =>
        importBlob(
          parentId,
          new File([buf], name, { type: file.type, lastModified: file.lastModified }),
          undefined,
          hostResource,
          track?.signal,
        ),
      track,
    );
    return;
  }
  const first = expanded[0];
  log.info(
    expanded.length === 1 && first?.kind === 'file'
      ? `Expanded “${name}” → “${first.name}”`
      : `Expanded “${name}” into ${expanded.length} item(s)`,
    'expand',
  );
  await importExpandedTree(fs, parentId, expanded, track);
}

async function writeTrackedBlob(
  parentId: number,
  name: string,
  write: () => Promise<unknown>,
  track?: ImportItemTrack,
): Promise<void> {
  throwIfAborted(track?.signal);
  try {
    await write();
    throwIfAborted(track?.signal);
  } catch (err) {
    if (isAbortError(err)) await track?.removePartial?.(parentId, name);
    throw err;
  }
}

function shouldTryExpand(name: string): boolean {
  return isExpandableArchive(name);
}

function expandedFiles(nodes: ExpandedNode[], prefix = ''): ExpandTrackFile[] {
  const out: ExpandTrackFile[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.kind === 'dir') out.push(...expandedFiles(node.children, path));
    else {
      out.push({
        name: node.name,
        path,
        bytesTotal: node.data.length + node.resource.length,
        finderInfo: node.finderInfo,
      });
    }
  }
  return out;
}

function expandedByteTotal(files: ExpandTrackFile[]): number {
  return files.reduce((n, f) => n + f.bytesTotal, 0);
}

/** Write expanded Mac files/folders through Catalog.createFile / put (forks, Finder info, dates). */
export async function importExpandedTree(
  fs: Pick<Catalog, 'ensureDir' | 'createFile' | 'put'>,
  parentId: number,
  nodes: ExpandedNode[],
  track?: ImportItemTrack,
  opts?: { announce?: boolean; prefix?: string },
): Promise<void> {
  const prefix = opts?.prefix ?? '';
  if (opts?.announce !== false) {
    const files = expandedFiles(nodes, prefix);
    track?.onExpandBegin?.(expandedByteTotal(files), files);
  }
  await writeExpandedNodes(fs, parentId, nodes, track, prefix);
}

async function writeExpandedNodes(
  fs: Pick<Catalog, 'ensureDir' | 'createFile' | 'put'>,
  parentId: number,
  nodes: ExpandedNode[],
  track?: ImportItemTrack,
  prefix = '',
): Promise<void> {
  for (const node of nodes) {
    throwIfAborted(track?.signal);
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.kind === 'dir') {
      const dir = await fs.ensureDir(parentId, node.name);
      await stampExpandedMeta(fs, dir, node, true);
      await writeExpandedNodes(fs, dir.id, node.children, track, path);
      continue;
    }
    await importExpandedFile(fs, parentId, node, track, path);
  }
}

async function importExpandedFile(
  fs: Pick<Catalog, 'createFile' | 'put'>,
  parentId: number,
  node: ExpandedFile,
  track?: ImportItemTrack,
  path = node.name,
): Promise<void> {
  const bytesTotal = node.data.length + node.resource.length;
  const child = track?.onExpand?.({
    name: node.name,
    path,
    bytesTotal,
    finderInfo: node.finderInfo,
  });
  if (child?.signal?.aborted) {
    child.onDone?.(abortError(child.signal));
    return;
  }
  const credit = (n: number): void => {
    child?.onBytes?.(n);
    track?.onBytes?.(n);
  };
  let wrote = 0;
  const signal = child?.signal ?? track?.signal;
  const removePartial = child?.removePartial ?? track?.removePartial;
  try {
    throwIfAborted(signal);
    const vnode = await fs.createFile(parentId, node.name, node.data, node.resource, node.finderInfo, (n) => {
      throwIfAborted(signal);
      wrote += n;
      credit(n);
    }, signal);
    throwIfAborted(signal);
    if (wrote === 0 && bytesTotal > 0) credit(bytesTotal);
    await stampExpandedMeta(fs, vnode, node, false);
    child?.onDone?.();
  } catch (err) {
    if (isAbortError(err)) await removePartial?.(parentId, node.name);
    child?.onDone?.(err instanceof Error ? err : new Error(String(err)));
    if (isAbortError(err) && track?.signal && !track.signal.aborted) return;
    throw err;
  }
}

async function stampExpandedMeta(
  fs: Pick<Catalog, 'put'>,
  vnode: VNode,
  meta: ExpandedFile | ExpandedDir,
  applyFinderInfo: boolean,
): Promise<void> {
  let dirty = false;
  if (applyFinderInfo && meta.finderInfo && meta.finderInfo.some((b) => b !== 0)) {
    vnode.finderInfo = meta.finderInfo;
    dirty = true;
  }
  if (meta.createDate) {
    vnode.createDate = hfsTimeToAfp(meta.createDate);
    dirty = true;
  }
  if (meta.modDate) {
    vnode.modDate = hfsTimeToAfp(meta.modDate);
    dirty = true;
  }
  if (dirty) await fs.put(vnode);
}

function fileWithName(file: File, name: string): File {
  if (file.name === name) return file;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

function collectDataTransferEntries(dt: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i]!;
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
  }
  return entries;
}

async function countFsEntries(entries: FileSystemEntry[]): Promise<number> {
  let total = 0;
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (isNamedForkDirName(entry.name)) return;
    total++;
    if (!entry.isDirectory) return;
    const kids = await readDirectoryEntries(entry as FileSystemDirectoryEntry);
    for (const kid of kids) await walk(kid);
  };
  for (const entry of entries) await walk(entry);
  return total;
}

async function measureGroupBytes(entries: FileSystemEntry[]): Promise<number> {
  let n = 0;
  for (const entry of entries) n += await measureEntryBytes(entry);
  return n;
}

async function measureEntryBytes(entry: FileSystemEntry, parentDir?: FileSystemDirectoryEntry): Promise<number> {
  if (isNamedForkDirName(entry.name)) return 0;
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await readFileEntry(fileEntry);
    const resource = await readNamedResourceForkForEntry(fileEntry, parentDir);
    return file.size + (resource?.length ?? 0);
  }
  if (!entry.isDirectory) return 0;
  let n = 0;
  const folder = entry as FileSystemDirectoryEntry;
  const kids = await readDirectoryEntries(folder);
  for (const kid of kids) n += await measureEntryBytes(kid, folder);
  return n;
}

function groupTopLevelEntries(
  entries: FileSystemEntry[],
): { name: string; isDir: boolean; entries: FileSystemEntry[] }[] {
  const map = new Map<string, { name: string; isDir: boolean; entries: FileSystemEntry[] }>();
  const order: string[] = [];
  for (const entry of entries) {
    const raw = unescapeHostFilename(entry.name);
    const logical = isAppleDoubleSidecarName(raw) ? raw.slice(2) : raw;
    const key = logical.toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { name: logical, isDir: false, entries: [] };
      map.set(key, g);
      order.push(key);
    }
    g.entries.push(entry);
    if (entry.isDirectory && !isAppleDoubleSidecarName(raw)) g.isDir = true;
  }
  return order.map((k) => {
    const g = map.get(k)!;
    g.entries.sort(compareImportEntries);
    return g;
  });
}

function groupFilesByTopLevel(files: File[]): { name: string; isDir: boolean; files: File[] }[] {
  const map = new Map<string, { name: string; isDir: boolean; files: File[] }>();
  const order: string[] = [];
  const bump = (logical: string, isDir: boolean, file: File) => {
    const key = logical.toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { name: logical, isDir, files: [] };
      map.set(key, g);
      order.push(key);
    }
    g.files.push(file);
    if (isDir) g.isDir = true;
  };
  for (const file of files) {
    const rel = file.webkitRelativePath;
    if (rel && rel.includes('/')) {
      bump(unescapeHostFilename(rel.split('/')[0]!), true, file);
    } else {
      const raw = unescapeHostFilename(file.name);
      bump(isAppleDoubleSidecarName(raw) ? raw.slice(2) : raw, false, file);
    }
  }
  return order.map((k) => {
    const g = map.get(k)!;
    g.files.sort(compareImportFiles);
    return g;
  });
}

function isAppleDoubleSidecarName(name: string): boolean {
  return name.startsWith('._') && name.length > 2;
}

/** Chrome on macOS can expose a file's resource fork as this parallel path. */
export const NAMED_RESOURCE_FORK_SUFFIX = '..namedfork/rsrc';

export function namedResourceForkPath(fileName: string): string {
  return `${fileName}/${NAMED_RESOURCE_FORK_SUFFIX}`;
}

function isNamedForkDirName(name: string): boolean {
  return name === '..namedfork';
}

/** AppleDouble sidecars already carry the resource fork; don't probe them. */
export function shouldProbeNamedResourceFork(name: string): boolean {
  if (!name || name === '.' || name === '..' || isNamedForkDirName(name)) return false;
  return !isAppleDoubleSidecarName(name);
}

/**
 * Read `file/..namedfork/rsrc` via the drag-and-drop File System API.
 * Works in Chrome on macOS; Safari often returns a File that fails to read,
 * Firefox typically errors. Empty forks and failures are ignored.
 */
export async function readNamedResourceFork(
  dir: FileSystemDirectoryEntry,
  fileName: string,
): Promise<Uint8Array | null> {
  if (!shouldProbeNamedResourceFork(fileName)) return null;
  const file = await getFileFromDirectory(dir, namedResourceForkPath(fileName));
  return readResourceForkFile(file);
}

async function readNamedResourceForkForEntry(
  fileEntry: FileSystemFileEntry,
  parentDir?: FileSystemDirectoryEntry | null,
): Promise<Uint8Array | null> {
  if (!shouldProbeNamedResourceFork(fileEntry.name)) return null;
  const dir = parentDir ?? (await getParentDirectory(fileEntry));
  if (dir) {
    const fromParent = await readNamedResourceFork(dir, fileEntry.name);
    if (fromParent) return fromParent;
  }
  const root = fileEntry.filesystem?.root;
  const fullPath = fileEntry.fullPath?.replace(/^\//, '');
  if (!root || !fullPath) return null;
  const file = await getFileFromDirectory(root, namedResourceForkPath(fullPath));
  return readResourceForkFile(file);
}

async function readResourceForkFile(file: File | null): Promise<Uint8Array | null> {
  if (!file?.size) return null;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    return buf.length ? buf : null;
  } catch {
    // Safari: getFile succeeds but reading the named fork throws.
    return null;
  }
}

function getFileFromDirectory(dir: FileSystemDirectoryEntry, relativePath: string): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof dir.getFile !== 'function') {
      resolve(null);
      return;
    }
    try {
      dir.getFile(
        relativePath,
        { create: false },
        (entry) => {
          (entry as FileSystemFileEntry).file(
            (file) => resolve(file),
            () => resolve(null),
          );
        },
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

function getParentDirectory(entry: FileSystemEntry): Promise<FileSystemDirectoryEntry | null> {
  return new Promise((resolve) => {
    if (typeof entry.getParent !== 'function') {
      resolve(null);
      return;
    }
    try {
      entry.getParent(
        (parent) => resolve(parent as FileSystemDirectoryEntry),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

function compareImportEntries(a: FileSystemEntry, b: FileSystemEntry): number {
  const as = isAppleDoubleSidecarName(a.name) ? 1 : 0;
  const bs = isAppleDoubleSidecarName(b.name) ? 1 : 0;
  return as - bs || a.name.localeCompare(b.name);
}

function compareImportFiles(a: File, b: File): number {
  const an = a.webkitRelativePath || a.name;
  const bn = b.webkitRelativePath || b.name;
  const as = isAppleDoubleSidecarName(a.name) ? 1 : 0;
  const bs = isAppleDoubleSidecarName(b.name) ? 1 : 0;
  return as - bs || an.localeCompare(bn);
}

function readDirectoryEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          readBatch();
        },
        (err) => reject(err),
      );
    };
    readBatch();
  });
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/** Read a File, optionally reporting each stream chunk (not the full size up front). */
export async function readBlobProgress(file: File, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!onBytes || typeof file.stream !== 'function') {
    const buf = new Uint8Array(await file.arrayBuffer());
    throwIfAborted(signal);
    return buf;
  }
  const reader = file.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(value);
      total += value.byteLength;
      onBytes(value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
