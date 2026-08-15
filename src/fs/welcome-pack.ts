/** Bundled default files copied into Browser Share from /welcome. */

import { unescapeHostFilename } from '../protocol/host-filename';
import { encodeMacRoman } from '../protocol/macroman';
import { be32 } from '../protocol/binary';
import { AS_MAGIC, AD_MAGIC, buildAppleSingle } from './appledouble';
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

export type WelcomePackFs = {
  rootId(): number;
  lookup(parentId: number, name: string): Promise<{ id: number; isDir: boolean } | undefined>;
  ensureDir(parentId: number, name: string): Promise<{ id: number }>;
  beginBatch(): void;
  endBatch(): void;
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

export function welcomePackStamp(paths: string[]): string {
  return [...paths].sort().join('\n');
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
  const res = await fetch(welcomePackFileUrl('manifest.json', base));
  if (!res.ok) throw new Error(`welcome pack manifest ${res.status}`);
  const paths = parseWelcomeManifest(await res.json());
  const files: WelcomePackFile[] = [];
  for (const path of paths) {
    const fileRes = await fetch(welcomePackFileUrl(path, base));
    if (!fileRes.ok) throw new Error(`welcome pack file ${path}: ${fileRes.status}`);
    files.push({ path, data: new Uint8Array(await fileRes.arrayBuffer()) });
  }
  return files;
}

function compareWelcomeFiles(a: WelcomePackFile, b: WelcomePackFile): number {
  const an = a.path.split('/').pop() ?? a.path;
  const bn = b.path.split('/').pop() ?? b.path;
  const as = isAppleDoubleSidecarName(an) ? 1 : 0;
  const bs = isAppleDoubleSidecarName(bn) ? 1 : 0;
  return as - bs || a.path.localeCompare(b.path);
}

/** Copy bundled files into the catalog, skipping names that already exist. */
export async function importWelcomePack(
  fs: WelcomePackFs,
  files: WelcomePackFile[],
): Promise<WelcomePackResult> {
  const result: WelcomePackResult = { imported: 0, skipped: 0 };
  const ordered = [...files].sort(compareWelcomeFiles);
  fs.beginBatch();
  try {
    for (const file of ordered) {
      const item = materializeWelcomeFile(file.path, file.data);
      let parentId = fs.rootId();
      let skippedDir = false;
      for (const dir of item.dirs) {
        try {
          parentId = (await fs.ensureDir(parentId, dir)).id;
        } catch {
          skippedDir = true;
          break;
        }
      }
      if (skippedDir) {
        result.skipped++;
        continue;
      }
      const existing = await fs.lookup(parentId, logicalName(item.name));
      if (existing) {
        result.skipped++;
        continue;
      }
      await fs.importBlob(parentId, new File([item.data], item.name));
      result.imported++;
    }
  } finally {
    fs.endBatch();
  }
  return result;
}

/** Import any new welcome-pack files once per bundled file list. */
export async function seedWelcomePackIfNeeded(store: WelcomePackStore): Promise<WelcomePackResult | null> {
  try {
    const files = await fetchWelcomePack();
    const stamp = welcomePackStamp(files.map((f) => f.path));
    if ((await store.getMeta(WELCOME_PACK_META_KEY)) === stamp) return null;
    const result = await importWelcomePack(store, files);
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

export async function addWelcomePack(store: WelcomePackStore): Promise<WelcomePackResult> {
  const files = await fetchWelcomePack();
  const result = await importWelcomePack(store, files);
  await store.setMeta(WELCOME_PACK_META_KEY, welcomePackStamp(files.map((f) => f.path)));
  return result;
}
