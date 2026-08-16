/**
 * Application / file-type icon cache (port of LibHfs.Gui.IconCache).
 * Decoded icons are keyed by creator|type and persisted in IndexedDB.
 * System fallbacks load from /icons/{TYPE}{16|32}.png (served from ./icons).
 */

import { openDB, type IDBPDatabase } from './idb-shim';
import { ResourceFork, type FinderIconForkOpts } from './resource-fork';
import { forkBytesFromNode } from './resource-inspect';
import { parseBndl } from './resource-types/bndl';
import { decodedIconToDataUrl } from './resource-types/icon-decoder';
import {
  CDEV_ICON_ID,
  CUSTOM_ICON_ID,
  DEFAULT_ICON_ID,
  IconSet,
  IconSize,
} from './resource-types/icon-set';
import type { VNode } from './virtual-fs';
import { escapeHostFilename } from '../protocol/host-filename';

export const CUSTOM_FOLDER_ICON_NAME = 'Icon\r';
/** Host-escaped form of Icon\\r (ClassicStack reserved-char token). */
export const CUSTOM_FOLDER_ICON_HOST_NAME = escapeHostFilename(CUSTOM_FOLDER_ICON_NAME);

export function isCustomFolderIconName(name: string): boolean {
  return name === CUSTOM_FOLDER_ICON_NAME || name === CUSTOM_FOLDER_ICON_HOST_NAME;
}

const ICON_CACHE_DB = 'classicstack-icon-cache';
/** Bump when decoded-icon preference or extract rules change so stale BW PNGs are dropped. */
const ICON_CACHE_DB_VERSION = 3;
const HAS_CUSTOM_ICON = 0x0400;
/** Finder FileInfo/DInfo flag: item is invisible (AppleDouble FinderInfo). */
export const FINDER_IS_INVISIBLE = 0x4000;

export interface IconUrls {
  small: string;
  large: string;
}

interface BundleCacheEntry {
  fref: Map<string, number>;
  icons: Map<number, IconSet>;
}

function padOsType(s: string): string {
  return (s || '????').padEnd(4, ' ').slice(0, 4);
}

export function readTypeCreator(finderInfo: Uint8Array): { type: string; creator: string } {
  let type = '';
  let creator = '';
  for (let i = 0; i < 4; i++) {
    type += String.fromCharCode(finderInfo[i] ?? 0x3f);
    creator += String.fromCharCode(finderInfo[4 + i] ?? 0x3f);
  }
  return { type: padOsType(type), creator: padOsType(creator) };
}

export function finderFlags(finderInfo: Uint8Array): number {
  return ((finderInfo[8] ?? 0) << 8) | (finderInfo[9] ?? 0);
}

/** True when FinderInfo has kIsInvisible. */
export function isFinderInvisible(finderInfo: Uint8Array): boolean {
  return (finderFlags(finderInfo) & FINDER_IS_INVISIBLE) !== 0;
}

function finderIconId(finderInfo: Uint8Array): number {
  const hi = finderInfo[16] ?? 0;
  const lo = finderInfo[17] ?? 0;
  return (((hi << 8) | lo) << 16) >> 16;
}

function cacheKey(creator: string, type: string): string {
  return `${padOsType(creator)}|${padOsType(type)}`;
}

/** Control panels, extensions, and chooser devices store their icon at -4064. */
const CDEV_STYLE_TYPES = new Set(['cdev', 'INIT', 'rdev', 'adev', 'ddev', 'sdev']);

export function isCdevStyleType(type: string): boolean {
  return CDEV_STYLE_TYPES.has(padOsType(type));
}

function isSystemIconUrls(urls: IconUrls): boolean {
  return urls.small.startsWith('/icons/') || urls.large.startsWith('/icons/');
}

function forkFromNode(
  resource: Uint8Array,
  data: Uint8Array | undefined,
  loaded: ResourceFork | null,
): ResourceFork | null {
  if (loaded && loaded.allEntries.length > 0) return loaded;
  const picked = forkBytesFromNode({ resource, data: data ?? new Uint8Array() });
  if (picked.source === 'empty' || picked.bytes.length < 16) return null;
  const rf = ResourceFork.fromBytes(picked.bytes);
  return rf.allEntries.length > 0 ? rf : null;
}

/**
 * Pick an icon family from a resource fork: BNDL/FREF, cdev id -4064, id 128,
 * then any ICN# / icl8 / etc. in the fork.
 */
export function iconSetForFile(rf: ResourceFork, type: string, finderInfo: Uint8Array): IconSet | null {
  const t = padOsType(type);
  const bndl = parseBndl(rf, isCdevStyleType(t) ? CDEV_ICON_ID : DEFAULT_ICON_ID);
  if (bndl) {
    const fref = bndl.extractTypeToLocalMap(rf);
    const icons = bndl.extractIcons(rf);
    const localId = fref.get(t);
    if (localId != null) {
      const set = icons.get(localId);
      if (set) return set;
    }
    if (isCdevStyleType(t)) {
      const set = icons.get(0) ?? IconSet.fromResourceFork(CDEV_ICON_ID, rf);
      if (set) return set;
    }
  }

  const ids: number[] = [];
  if ((finderFlags(finderInfo) & HAS_CUSTOM_ICON) !== 0) ids.push(CUSTOM_ICON_ID);
  const fid = finderIconId(finderInfo);
  if (fid) ids.push(fid);
  if (isCdevStyleType(t)) ids.push(CDEV_ICON_ID);
  ids.push(DEFAULT_ICON_ID);
  for (const id of ids) {
    const set = IconSet.fromResourceFork(id, rf);
    if (set) return set;
  }
  return IconSet.fromFork(rf);
}

const KNOWN_SYSTEM_ICONS = new Set([
  'APPL16.png',
  'APPL32.png',
  'AppleItems.png',
  'CONTROL32.png',
  'DIR16.png',
  'DIR32.png',
  'FILE16.png',
  'FILE32.png',
  'FNDR16.png',
  'FNDR32.png',
  'MOOV32.png',
  'SYSTEMDIR32.png',
  'TEXT32.png',
  'TrashEmpty.png',
  'TrashFull.png',
  'zsys16.png',
  'zsys32.png',
  'news32.png',
]);

function systemIconUrl(name: string): string {
  return `/icons/${name}`;
}

/** True when the cache fell back to the classic DIR16/DIR32 PNGs. */
export function isDefaultFolderIcon(urls: IconUrls): boolean {
  return isDefaultFolderIconUrl(urls.small) || isDefaultFolderIconUrl(urls.large);
}

function isDefaultFolderIconUrl(src: string): boolean {
  return /(?:^|\/)DIR(?:16|32)\.png(?:\?|$)/i.test(src);
}

function pickSystemIcon(candidates: string[]): string {
  for (const name of candidates) {
    if (KNOWN_SYSTEM_ICONS.has(name)) return systemIconUrl(name);
  }
  return systemIconUrl(candidates[candidates.length - 1] ?? 'FILE32.png');
}

async function resolveSystemIcon(type: string, size: 16 | 32): Promise<string> {
  const t = padOsType(type).replace(/\s+$/g, '') || 'FILE';
  if (size === 16) {
    return pickSystemIcon([`${t}16.png`, `${t}32.png`, 'FILE16.png', 'FILE32.png']);
  }
  return pickSystemIcon([`${t}32.png`, `${t}16.png`, 'FILE32.png', 'FILE16.png']);
}

async function resolveFolderIcon(size: 16 | 32): Promise<string> {
  return pickSystemIcon(size === 16 ? ['DIR16.png', 'DIR32.png'] : ['DIR32.png', 'DIR16.png']);
}

async function iconSetToUrls(set: IconSet): Promise<IconUrls | null> {
  const smallIcon = set.getIconBySize(IconSize.Small) ?? set.getIconBySize(IconSize.Large);
  const largeIcon = set.getIconBySize(IconSize.Large) ?? set.getIconBySize(IconSize.Small);
  if (!smallIcon && !largeIcon) return null;
  const small = smallIcon ? await decodedIconToDataUrl(smallIcon) : null;
  const large = largeIcon ? await decodedIconToDataUrl(largeIcon) : null;
  if (!small && !large) return null;
  return {
    small: small ?? large!,
    large: large ?? small!,
  };
}

export class IconCache {
  private memory = new Map<string, IconUrls>();
  private bundleCache = new Map<string, BundleCacheEntry>();
  private dirMemory = new Map<string, IconUrls>();
  private db: IDBPDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private systemReady: Promise<void> | null = null;
  private defaultFolder: IconUrls | null = null;

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.openDb();
    }
    return this.initPromise;
  }

  private async openDb(): Promise<void> {
    this.db = await openDB(ICON_CACHE_DB, ICON_CACHE_DB_VERSION, {
      upgrade(db) {
        if (db.objectStoreNames.contains('typeIcons')) db.deleteObjectStore('typeIcons');
        db.createObjectStore('typeIcons', { keyPath: 'key' });
      },
    });
  }

  private async ensureDefaults(): Promise<void> {
    if (!this.systemReady) {
      this.systemReady = (async () => {
        this.defaultFolder = {
          small: await resolveFolderIcon(16),
          large: await resolveFolderIcon(32),
        };
      })();
    }
    await this.systemReady;
  }

  async clear(): Promise<void> {
    this.memory.clear();
    this.bundleCache.clear();
    this.dirMemory.clear();
    await this.init();
    if (!this.db) return;
    await this.clearStore('typeIcons');
  }

  /** Drop cached folder icons (e.g. after VirtualFS mutations / Icon\\r changes). */
  clearDirectoryCache(): void {
    this.dirMemory.clear();
  }

  private async clearStore(store: string): Promise<void> {
    if (!this.db) return;
    // idb-shim lacks getAllKeys; use raw indexedDB
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(ICON_CACHE_DB, ICON_CACHE_DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  private async persist(key: string, urls: IconUrls): Promise<void> {
    await this.init();
    await this.db?.put('typeIcons', { key, small: urls.small, large: urls.large });
  }

  private async loadPersisted(key: string): Promise<IconUrls | null> {
    await this.init();
    const row = await this.db?.get('typeIcons', key);
    if (!row) return null;
    return { small: row.small as string, large: row.large as string };
  }

  /** Resolve icons for a VirtualFS node (local share or remote AFP). */
  async getForNode(
    node: VNode,
    findChild?: (parentId: number, name: string) => Promise<VNode | undefined>,
    loadIconFork?: (node: VNode) => Promise<ResourceFork | null>,
  ): Promise<IconUrls> {
    await this.ensureDefaults();
    if (node.isDir) {
      return this.getForDirectory(String(node.id), node, findChild, loadIconFork);
    }
    const { type, creator } = readTypeCreator(node.finderInfo);
    let fork: ResourceFork | null = null;
    if (node.resource.length < 16 && loadIconFork) {
      try {
        fork = await loadIconFork(node);
      } catch {
        fork = null;
      }
    }
    return this.getForFile({
      type,
      creator,
      resource: node.resource,
      data: node.data,
      finderInfo: node.finderInfo,
      fork,
    });
  }

  /** Resolve icons when only Finder info is known (remote listings). */
  async getForTypeCreator(type: string, creator: string): Promise<IconUrls> {
    await this.ensureDefaults();
    const key = cacheKey(creator, type);
    const cached = this.memory.get(key) ?? (await this.loadPersisted(key));
    if (cached) {
      this.memory.set(key, cached);
      return cached;
    }
    const urls: IconUrls = {
      small: await resolveSystemIcon(type, 16),
      large: await resolveSystemIcon(type, 32),
    };
    this.memory.set(key, urls);
    return urls;
  }

  private async getForDirectory(
    pathKey: string,
    node: VNode,
    findChild?: (parentId: number, name: string) => Promise<VNode | undefined>,
    loadIconFork?: (node: VNode) => Promise<ResourceFork | null>,
  ): Promise<IconUrls> {
    const hit = this.dirMemory.get(pathKey);
    if (hit) return hit;

    // Classic Finder custom folder icon lives in a root file named "Icon\r"
    // (Icon + CR / 0x0D), resource id -16455.
    const fromIconFile = await this.tryCustomFolderIconFile(node, findChild, loadIconFork);
    if (fromIconFile) {
      this.dirMemory.set(pathKey, fromIconFile);
      return fromIconFile;
    }

    // Rare: icon data stored on the directory's own resource fork
    const flags = finderFlags(node.finderInfo);
    if ((flags & HAS_CUSTOM_ICON) !== 0) {
      try {
        const rf =
          node.resource.length > 16
            ? ResourceFork.fromBytes(node.resource)
            : loadIconFork
              ? await loadIconFork(node)
              : null;
        if (rf) {
          const set = IconSet.fromResourceFork(CUSTOM_ICON_ID, rf);
          if (set) {
            const urls = await iconSetToUrls(set);
            if (urls) {
              this.dirMemory.set(pathKey, urls);
              return urls;
            }
          }
        }
      } catch {
        /* fall through */
      }
    }

    const urls = this.defaultFolder ?? {
      small: systemIconUrl('DIR16.png'),
      large: systemIconUrl('DIR32.png'),
    };
    // Do not cache defaults — allows Icon\r added later to be picked up.
    return urls;
  }

  private async tryCustomFolderIconFile(
    dir: VNode,
    findChild?: (parentId: number, name: string) => Promise<VNode | undefined>,
    loadIconFork?: (node: VNode) => Promise<ResourceFork | null>,
  ): Promise<IconUrls | null> {
    if (!findChild) return null;
    try {
      const iconFile =
        (await findChild(dir.id, CUSTOM_FOLDER_ICON_NAME)) ??
        (await findChild(dir.id, CUSTOM_FOLDER_ICON_HOST_NAME));
      if (!iconFile || iconFile.isDir) return null;
      const rsrcLen = iconFile.resourceBytes ?? iconFile.resource.length;
      if (iconFile.resource.length < 16 && rsrcLen < 16) return null;
      const rf =
        iconFile.resource.length >= 16
          ? ResourceFork.fromBytes(iconFile.resource)
          : loadIconFork
            ? await loadIconFork(iconFile)
            : null;
      if (!rf) return null;
      const set =
        IconSet.fromFork(rf) ??
        IconSet.fromResourceFork(CUSTOM_ICON_ID, rf) ??
        IconSet.fromResourceFork(DEFAULT_ICON_ID, rf);
      if (!set) return null;
      return await iconSetToUrls(set);
    } catch {
      return null;
    }
  }

  private async getForFile(args: {
    type: string;
    creator: string;
    resource: Uint8Array;
    data?: Uint8Array;
    finderInfo: Uint8Array;
    fork?: ResourceFork | null;
  }): Promise<IconUrls> {
    const key = cacheKey(args.creator, args.type);
    const rf = forkFromNode(args.resource, args.data, args.fork ?? null);
    const cached = this.memory.get(key) ?? (await this.loadPersisted(key));
    if (cached && !(rf && isSystemIconUrls(cached))) {
      this.memory.set(key, cached);
      return cached;
    }

    if (!rf) {
      const urls: IconUrls = {
        small: await resolveSystemIcon(args.type, 16),
        large: await resolveSystemIcon(args.type, 32),
      };
      this.memory.set(key, urls);
      return urls;
    }

    try {
      await this.tryBundle(rf, args.type, args.creator, key);
      const hit = this.memory.get(key);
      if (hit && !isSystemIconUrls(hit)) return hit;

      const set = iconSetForFile(rf, args.type, args.finderInfo);
      if (set) {
        const urls = await iconSetToUrls(set);
        if (urls) {
          this.memory.set(key, urls);
          await this.persist(key, urls);
          return urls;
        }
      }
    } catch {
      /* fall through to system icons */
    }

    const urls: IconUrls = {
      small: await resolveSystemIcon(args.type, 16),
      large: await resolveSystemIcon(args.type, 32),
    };
    this.memory.set(key, urls);
    return urls;
  }

  private async tryBundle(
    rf: ResourceFork,
    type: string,
    creator: string,
    key: string,
  ): Promise<void> {
    const prefIds = isCdevStyleType(type) ? [CDEV_ICON_ID, DEFAULT_ICON_ID] : [DEFAULT_ICON_ID];
    let ent: ReturnType<ResourceFork['findById']>;
    for (const bid of prefIds) {
      const found = rf.findById('BNDL', bid);
      if (found) {
        ent = found;
        break;
      }
    }
    ent ??= rf.findByType('BNDL')[0];
    if (!ent) return;

    const bndl = parseBndl(rf, ent.id);
    if (!bndl) return;

    const fref = bndl.extractTypeToLocalMap(rf);
    const icons = bndl.extractIcons(rf);
    const ownerKey = bndl.owner?.trim() ? bndl.owner : creator;
    this.bundleCache.set(ownerKey, { fref, icons });
    if (ownerKey !== creator) this.bundleCache.set(creator, { fref, icons });

    const persistSet = async (k: string, set: IconSet): Promise<void> => {
      const urls = await iconSetToUrls(set);
      if (!urls) return;
      this.memory.set(k, urls);
      await this.persist(k, urls);
    };

    for (const [ftype, localId] of fref) {
      const set = icons.get(localId);
      if (!set) continue;
      await persistSet(cacheKey(ownerKey, ftype), set);
      if (ownerKey !== creator) await persistSet(cacheKey(creator, ftype), set);
    }

    if (this.memory.get(key)) return;
    const set = iconSetForFile(rf, type, new Uint8Array(32));
    if (set) await persistSet(key, set);
  }
}

/** Shared singleton used by Finder + Advanced menu. */
export const iconCache = new IconCache();
