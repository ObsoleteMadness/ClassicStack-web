/**
 * Application / file-type icon cache (port of LibHfs.Gui.IconCache).
 * Decoded icons are keyed by creator|type and persisted in IndexedDB.
 * System fallbacks load from /icons/{TYPE}{16|32}.png (served from ./icons).
 */

import { openDB, type IDBPDatabase } from './idb-shim';
import { ResourceFork } from './resource-fork';
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
/** Host-escaped form of Icon\\r (OmniTalk/ClassicStack reserved-char token). */
export const CUSTOM_FOLDER_ICON_HOST_NAME = escapeHostFilename(CUSTOM_FOLDER_ICON_NAME);

export function isCustomFolderIconName(name: string): boolean {
  return name === CUSTOM_FOLDER_ICON_NAME || name === CUSTOM_FOLDER_ICON_HOST_NAME;
}

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
    this.db = await openDB('classicstack-icon-cache', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('typeIcons')) {
          db.createObjectStore('typeIcons', { keyPath: 'key' });
        }
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
      const req = indexedDB.open('classicstack-icon-cache', 1);
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

  /** Resolve icons for a VirtualFS node (local share). */
  async getForNode(
    node: VNode,
    findChild?: (parentId: number, name: string) => Promise<VNode | undefined>,
  ): Promise<IconUrls> {
    await this.ensureDefaults();
    if (node.isDir) {
      return this.getForDirectory(String(node.id), node, findChild);
    }
    const { type, creator } = readTypeCreator(node.finderInfo);
    return this.getForFile({
      type,
      creator,
      resource: node.resource,
      finderInfo: node.finderInfo,
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
    await this.persist(key, urls);
    return urls;
  }

  private async getForDirectory(
    pathKey: string,
    node: VNode,
    findChild?: (parentId: number, name: string) => Promise<VNode | undefined>,
  ): Promise<IconUrls> {
    const hit = this.dirMemory.get(pathKey);
    if (hit) return hit;

    // Classic Finder custom folder icon lives in a root file named "Icon\r"
    // (Icon + CR / 0x0D), resource id -16455.
    const fromIconFile = await this.tryCustomFolderIconFile(node, findChild);
    if (fromIconFile) {
      this.dirMemory.set(pathKey, fromIconFile);
      return fromIconFile;
    }

    // Rare: icon data stored on the directory's own resource fork
    const flags = finderFlags(node.finderInfo);
    if ((flags & HAS_CUSTOM_ICON) !== 0 && node.resource.length > 16) {
      try {
        const rf = ResourceFork.fromBytes(node.resource);
        const set = IconSet.fromResourceFork(CUSTOM_ICON_ID, rf);
        if (set) {
          const urls = await iconSetToUrls(set);
          if (urls) {
            this.dirMemory.set(pathKey, urls);
            return urls;
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
  ): Promise<IconUrls | null> {
    if (!findChild) return null;
    try {
      const iconFile =
        (await findChild(dir.id, CUSTOM_FOLDER_ICON_NAME)) ??
        (await findChild(dir.id, CUSTOM_FOLDER_ICON_HOST_NAME));
      if (!iconFile || iconFile.isDir || iconFile.resource.length < 16) return null;
      const rf = ResourceFork.fromBytes(iconFile.resource);
      const set =
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
    finderInfo: Uint8Array;
  }): Promise<IconUrls> {
    const key = cacheKey(args.creator, args.type);
    const cached = this.memory.get(key) ?? (await this.loadPersisted(key));
    if (cached) {
      this.memory.set(key, cached);
      return cached;
    }

    if (args.resource.length < 16) {
      const urls: IconUrls = {
        small: await resolveSystemIcon(args.type, 16),
        large: await resolveSystemIcon(args.type, 32),
      };
      this.memory.set(key, urls);
      await this.persist(key, urls);
      return urls;
    }

    try {
      const rf = ResourceFork.fromBytes(args.resource);

      // Bundle cache by creator
      const bundleHit = this.bundleCache.get(args.creator);
      if (bundleHit) {
        const localId = bundleHit.fref.get(args.type);
        if (localId != null) {
          const set = bundleHit.icons.get(localId);
          if (set) {
            const urls = await iconSetToUrls(set);
            if (urls) {
              this.memory.set(key, urls);
              await this.persist(key, urls);
              return urls;
            }
          }
        }
      }

      const fromBundle = await this.tryBundle(rf, args.type, args.creator, key);
      if (fromBundle) return fromBundle;

      const candidates: number[] = [];
      if ((finderFlags(args.finderInfo) & HAS_CUSTOM_ICON) !== 0) candidates.push(CUSTOM_ICON_ID);
      const fid = finderIconId(args.finderInfo);
      if (fid) candidates.push(fid);
      if (args.type === 'cdev') candidates.push(CDEV_ICON_ID);
      candidates.push(DEFAULT_ICON_ID);

      for (const id of candidates) {
        const set = IconSet.fromResourceFork(id, rf);
        if (set) {
          const urls = await iconSetToUrls(set);
          if (urls) {
            this.memory.set(key, urls);
            await this.persist(key, urls);
            return urls;
          }
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
    await this.persist(key, urls);
    return urls;
  }

  private async tryBundle(
    rf: ResourceFork,
    type: string,
    creator: string,
    key: string,
  ): Promise<IconUrls | null> {
    const prefIds = type === 'cdev' ? [CDEV_ICON_ID, DEFAULT_ICON_ID] : [DEFAULT_ICON_ID];
    let ent: ReturnType<ResourceFork['findById']>;
    for (const bid of prefIds) {
      const found = rf.findById('BNDL', bid);
      if (found) {
        ent = found;
        break;
      }
    }
    ent ??= rf.findByType('BNDL')[0];
    if (!ent) return null;

    const bndl = parseBndl(rf, ent.id);
    if (!bndl) return null;

    const fref = bndl.extractTypeToLocalMap(rf);
    const icons = bndl.extractIcons(rf);
    const ownerKey = bndl.owner?.trim() ? bndl.owner : creator;
    this.bundleCache.set(ownerKey, { fref, icons });

    for (const [ftype, localId] of fref) {
      const set = icons.get(localId);
      if (!set) continue;
      const urls = await iconSetToUrls(set);
      if (!urls) continue;
      const k = cacheKey(ownerKey, ftype);
      this.memory.set(k, urls);
      await this.persist(k, urls);
    }

    const after = this.memory.get(key);
    if (after) return after;

    if (icons.size > 0) {
      let chosen: IconSet | undefined;
      for (const bid of prefIds) {
        chosen = icons.get(bid);
        if (chosen) break;
      }
      chosen ??= icons.values().next().value;
      if (chosen) {
        const urls = await iconSetToUrls(chosen);
        if (urls) {
          this.memory.set(key, urls);
          await this.persist(key, urls);
          return urls;
        }
      }
    }
    return null;
  }
}

/** Shared singleton used by Finder + Advanced menu. */
export const iconCache = new IconCache();
