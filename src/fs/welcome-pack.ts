/** Bundled default files copied into Browser Share from /welcome. */

import { unescapeHostFilename } from '../protocol/host-filename';
import { encodeMacRoman } from '../protocol/macroman';
import { be32 } from '../protocol/binary';
import { AS_MAGIC, AD_MAGIC, buildAppleSingle } from './appledouble';
import { expandIncoming, isExpandableArchive, type ExpandedNode } from './expand-incoming';
import { importExpandedTree, type ImportItemTrack } from './import-transfer';
import type { Catalog } from './virtual-fs';
import { log } from '../util/logger';

export const WELCOME_PACK_BASE = '/welcome';
export const WELCOME_PACK_MANIFEST_URL = `${WELCOME_PACK_BASE}/manifest.json`;
export const WELCOME_PACK_META_KEY = 'welcomePack';

export type WelcomeManifest = {
  files: { path: string; bytes?: number }[];
};

export type WelcomePackFile = {
  path: string;
  data: Uint8Array;
};

export type WelcomePackResult = {
  imported: number;
  skipped: number;
};

export type WelcomePackProgress = {
  onBegin?: (fileCount: number) => void;
  onItem?: (item: {
    name: string;
    isDir: boolean;
    bytesTotal: number;
  }) => ImportItemTrack | undefined;
};

export type WelcomePackFs = Pick<
  Catalog,
  'rootId' | 'ensureDir' | 'beginBatch' | 'endBatch' | 'createFile' | 'put' | 'remove'
> & {
  lookup(parentId: number, name: string): Promise<{ id: number; isDir: boolean } | undefined>;
  importBlob(parentId: number, file: File): Promise<unknown>;
};

export type WelcomePackStore = WelcomePackFs & {
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
};

const SKIP_NAMES = new Set(['readme.md', 'manifest.json', '.ds_store', '.gitkeep']);

/** True when a relative path under public/welcome should be copied into the share. */
export function isWelcomePackSourceFile(relativePath: string): boolean {
  const base = relativePath.split('/').pop() ?? '';
  if (!base) return false;
  const lower = base.toLowerCase();
  if (SKIP_NAMES.has(lower) || lower.startsWith('license')) return false;
  if (base.startsWith('.') && !base.startsWith('._')) return false;
  return true;
}

export function welcomePackFileUrl(relativePath: string, base = WELCOME_PACK_BASE): string {
  const root = base.replace(/\/$/, '');
  return `${root}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Stamp includes a generation so older installs re-import and expand leftover wrappers. */
export function welcomePackStamp(paths: string[]): string {
  return `expand-1\n${[...paths].sort().join('\n')}`;
}

export function parseWelcomeManifest(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const files = (json as WelcomeManifest).files;
  if (!Array.isArray(files)) return [];
  const paths: string[] = [];
  for (const row of files) {
    if (!row || typeof row.path !== 'string') continue;
    const path = row.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = path.split('/');
    if (!path || parts.some((p) => !p || p === '.' || p === '..') || !isWelcomePackSourceFile(path)) {
      continue;
    }
    paths.push(path);
  }
  return paths;
}

function isAppleContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = be32(bytes, 0);
  return magic === AS_MAGIC || magic === AD_MAGIC;
}

function isAppleDoubleSidecarName(name: string): boolean {
  return name.startsWith('._') && name.length > 2;
}

function logicalName(name: string): string {
  return isAppleDoubleSidecarName(name) ? name.slice(2) : name;
}

function textFinder(): Uint8Array {
  const fi = new Uint8Array(32);
  const type = 'TEXT';
  const creator = 'ttxt';
  for (let i = 0; i < 4; i++) {
    fi[i] = type.charCodeAt(i);
    fi[4 + i] = creator.charCodeAt(i);
  }
  return fi;
}

function macTextFork(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes).replace(/\r\n/g, '\n').replace(/\n/g, '\r');
  return encodeMacRoman(text);
}

/**
 * Map a bundled file onto a Mac catalog name.
 * Plain `.txt` files become AppleSingle TEXT/ttxt documents without the suffix.
 */
export function materializeWelcomeFile(
  relativePath: string,
  bytes: Uint8Array,
): { dirs: string[]; name: string; data: Uint8Array } {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  let name = unescapeHostFilename(parts.pop() ?? 'Untitled');
  let data = bytes;
  if (name.toLowerCase().endsWith('.txt') && !isAppleContainer(bytes)) {
    name = unescapeHostFilename(name.slice(0, -4)) || name;
    data = buildAppleSingle(macTextFork(bytes), new Uint8Array(), textFinder());
  }
  return {
    dirs: parts.map((p) => unescapeHostFilename(p)),
    name,
    data,
  };
}

export async function fetchWelcomePack(base = WELCOME_PACK_BASE): Promise<WelcomePackFile[]> {
  const paths = await fetchWelcomePaths(base);
  const files: WelcomePackFile[] = [];
  for (const path of paths) files.push({ path, data: await fetchWelcomeFile(path, base) });
  return files;
}

async function fetchWelcomePaths(base = WELCOME_PACK_BASE): Promise<string[]> {
  const res = await fetch(welcomePackFileUrl('manifest.json', base));
  if (!res.ok) throw new Error(`welcome pack manifest ${res.status}`);
  return parseWelcomeManifest(await res.json());
}

async function fetchWelcomeFile(relativePath: string, base = WELCOME_PACK_BASE): Promise<Uint8Array> {
  const fileRes = await fetch(welcomePackFileUrl(relativePath, base));
  if (!fileRes.ok) throw new Error(`welcome pack file ${relativePath}: ${fileRes.status}`);
  return new Uint8Array(await fileRes.arrayBuffer());
}

function compareWelcomePaths(a: string, b: string): number {
  const an = a.split('/').pop() ?? a;
  const bn = b.split('/').pop() ?? b;
  const as = isAppleDoubleSidecarName(an) ? 1 : 0;
  const bs = isAppleDoubleSidecarName(bn) ? 1 : 0;
  return as - bs || a.localeCompare(b);
}

function compareWelcomeFiles(a: WelcomePackFile, b: WelcomePackFile): number {
  return compareWelcomePaths(a.path, b.path);
}

function namesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function tryExpandWelcome(name: string, data: Uint8Array): ExpandedNode[] | null {
  if (!isExpandableArchive(name)) return null;
  try {
    return expandIncoming(name, data);
  } catch (err) {
    log.warn(
      `Couldn’t auto-expand welcome item “${name}”: ${err instanceof Error ? err.message : err}`,
      'expand',
    );
    return null;
  }
}

/** Drop the wrapper once inner items are in the catalog (unless expand kept that name). */
async function discardWelcomeArchive(
  fs: WelcomePackFs,
  parentId: number,
  archiveName: string,
  expanded: ExpandedNode[],
): Promise<void> {
  if (expanded.some((n) => namesMatch(n.name, archiveName))) return;
  const leftover = await fs.lookup(parentId, archiveName);
  if (leftover && !leftover.isDir) await fs.remove(leftover.id);
}

function yieldForUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function importOneWelcomeFile(
  fs: WelcomePackFs,
  file: WelcomePackFile,
  opts?: WelcomePackProgress,
): Promise<WelcomePackResult> {
  const result: WelcomePackResult = { imported: 0, skipped: 0 };
  await yieldForUi();
  const item = materializeWelcomeFile(file.path, file.data);
  fs.beginBatch();
  let track: ImportItemTrack | undefined;
  try {
    let parentId = fs.rootId();
    for (const dir of item.dirs) {
      try {
        parentId = (await fs.ensureDir(parentId, dir)).id;
      } catch {
        result.skipped++;
        return result;
      }
    }
    const expanded = tryExpandWelcome(item.name, item.data);
    if (expanded?.length) {
      const first = expanded[0];
      log.info(
        expanded.length === 1 && first?.kind === 'file'
          ? `Welcome pack: expanded “${item.name}” → “${first.name}”`
          : `Welcome pack: expanded “${item.name}” into ${expanded.length} item(s)`,
        'expand',
      );
      track = opts?.onItem?.({
        name: item.name,
        isDir: expanded.length === 1 && first?.kind === 'dir',
        bytesTotal: file.data.length,
      });
      const toImport: ExpandedNode[] = [];
      for (const node of expanded) {
        if (await fs.lookup(parentId, node.name)) {
          result.skipped++;
          continue;
        }
        toImport.push(node);
      }
      if (toImport.length) {
        await importExpandedTree(fs, parentId, toImport, track);
        result.imported += toImport.length;
      }
      await discardWelcomeArchive(fs, parentId, item.name, expanded);
      track?.onDone?.();
      return result;
    }
    const existing = await fs.lookup(parentId, logicalName(item.name));
    if (existing) {
      result.skipped++;
      return result;
    }
    track = opts?.onItem?.({
      name: item.name,
      isDir: false,
      bytesTotal: item.data.length,
    });
    await fs.importBlob(parentId, new File([item.data], item.name));
    track?.onBytes?.(item.data.length);
    track?.onDone?.();
    result.imported++;
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn(`Welcome pack: skipped “${item.name}”: ${error.message}`, 'fs');
    track?.onDone?.(error);
    result.skipped++;
    return result;
  } finally {
    fs.endBatch();
  }
}

/** Copy bundled files into the catalog, skipping names that already exist. */
export async function importWelcomePack(
  fs: WelcomePackFs,
  files: WelcomePackFile[],
  opts?: WelcomePackProgress,
): Promise<WelcomePackResult> {
  const result: WelcomePackResult = { imported: 0, skipped: 0 };
  const ordered = [...files].sort(compareWelcomeFiles);
  opts?.onBegin?.(ordered.length);
  for (const file of ordered) {
    const one = await importOneWelcomeFile(fs, file, opts);
    result.imported += one.imported;
    result.skipped += one.skipped;
  }
  return result;
}

async function importWelcomePaths(
  store: WelcomePackStore,
  paths: string[],
  opts?: WelcomePackProgress,
): Promise<WelcomePackResult> {
  const result: WelcomePackResult = { imported: 0, skipped: 0 };
  const ordered = [...paths].sort(compareWelcomePaths);
  opts?.onBegin?.(ordered.length);
  for (const path of ordered) {
    const one = await importOneWelcomeFile(store, { path, data: await fetchWelcomeFile(path) }, opts);
    result.imported += one.imported;
    result.skipped += one.skipped;
  }
  return result;
}

/** Record the current welcome-pack stamp so a later seed will not re-import. */
export async function skipWelcomePackSeed(store: WelcomePackStore): Promise<void> {
  const paths = await fetchWelcomePaths();
  await store.setMeta(WELCOME_PACK_META_KEY, welcomePackStamp(paths));
}

/** Import any new welcome-pack files once per bundled file list. */
export async function seedWelcomePackIfNeeded(
  store: WelcomePackStore,
  opts?: WelcomePackProgress,
): Promise<WelcomePackResult | null> {
  try {
    const paths = await fetchWelcomePaths();
    const stamp = welcomePackStamp(paths);
    if ((await store.getMeta(WELCOME_PACK_META_KEY)) === stamp) return null;
    const result = await importWelcomePaths(store, paths, opts);
    await store.setMeta(WELCOME_PACK_META_KEY, stamp);
    if (result.imported > 0) {
      log.info(`Welcome pack: added ${result.imported} item(s)`, 'fs');
    }
    return result;
  } catch (err) {
    log.warn(`Welcome pack seed skipped: ${err instanceof Error ? err.message : String(err)}`, 'fs');
    return null;
  }
}

export async function addWelcomePack(
  store: WelcomePackStore,
  opts?: WelcomePackProgress,
): Promise<WelcomePackResult> {
  const paths = await fetchWelcomePaths();
  const result = await importWelcomePaths(store, paths, opts);
  await store.setMeta(WELCOME_PACK_META_KEY, welcomePackStamp(paths));
  return result;
}
