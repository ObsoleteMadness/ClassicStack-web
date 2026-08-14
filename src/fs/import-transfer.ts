/** Shared DataTransfer import for local IndexedDB and remote AFP catalogs. */

import { unescapeHostFilename } from '../protocol/host-filename';
import type { Catalog } from './virtual-fs';

export type ImportProgress = {
  onScan?: (total: number) => void;
  onProgress?: (done: number, total: number) => void;
};

/**
 * Import files and folders from a drag-and-drop DataTransfer.
 * Uses FileSystemEntry (directory trees) when available; falls back to FileList
 * + webkitRelativePath. Returns the number of top-level items imported.
 */
export async function importDataTransferInto(
  fs: Pick<Catalog, 'beginBatch' | 'endBatch' | 'ensureDir'>,
  parentId: number,
  dt: DataTransfer,
  importBlob: (parentId: number, file: File) => Promise<unknown>,
  opts?: ImportProgress,
): Promise<number> {
  const entries = collectDataTransferEntries(dt);
  const total = entries.length > 0 ? await countFsEntries(entries) : dt.files.length;
  opts?.onScan?.(total);

  fs.beginBatch();
  let done = 0;
  const tick = (): void => {
    done++;
    opts?.onProgress?.(done, total);
  };
  try {
    if (entries.length > 0) {
      entries.sort(compareImportEntries);
      for (const entry of entries) {
        await importFsEntry(fs, parentId, entry, importBlob, tick);
      }
      return entries.length;
    }

    const files = [...dt.files].sort(compareImportFiles);
    for (const file of files) {
      await importFileWithRelativePath(fs, parentId, file, importBlob);
      tick();
    }
    return files.length;
  } finally {
    fs.endBatch();
  }
}

async function importFsEntry(
  fs: Pick<Catalog, 'ensureDir'>,
  parentId: number,
  entry: FileSystemEntry,
  importBlob: (parentId: number, file: File) => Promise<unknown>,
  onItem?: () => void,
): Promise<void> {
  if (entry.isDirectory) {
    const dir = await fs.ensureDir(parentId, unescapeHostFilename(entry.name));
    onItem?.();
    const kids = (await readDirectoryEntries(entry as FileSystemDirectoryEntry)).sort(compareImportEntries);
    for (const kid of kids) {
      await importFsEntry(fs, dir.id, kid, importBlob, onItem);
    }
    return;
  }
  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntry);
    await importBlob(parentId, file);
    onItem?.();
  }
}

async function importFileWithRelativePath(
  fs: Pick<Catalog, 'ensureDir'>,
  parentId: number,
  file: File,
  importBlob: (parentId: number, file: File) => Promise<unknown>,
): Promise<void> {
  const rel = file.webkitRelativePath;
  if (!rel || !rel.includes('/')) {
    await importBlob(parentId, file);
    return;
  }
  const parts = rel.split('/');
  let dirId = parentId;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!part || part === '.' || part === '..') continue;
    dirId = (await fs.ensureDir(dirId, unescapeHostFilename(part))).id;
  }
  await importBlob(dirId, file);
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
    total++;
    if (!entry.isDirectory) return;
    const kids = await readDirectoryEntries(entry as FileSystemDirectoryEntry);
    for (const kid of kids) await walk(kid);
  };
  for (const entry of entries) await walk(entry);
  return total;
}

function isAppleDoubleSidecarName(name: string): boolean {
  return name.startsWith('._') && name.length > 2;
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
