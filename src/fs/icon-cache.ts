/**
 * Application / file-type icon cache (port of LibHfs.Gui.IconCache).
 * Decoded icons are keyed by creator|type and persisted in IndexedDB.
 * System fallbacks load from /icons/{TYPE}{16|32}.png (served from ./icons).
 */

import { openDB, type IDBPDatabase } from './idb-shim';
import { loadFinderIconFork, ResourceFork, type FinderIconForkOpts } from './resource-fork';
import { forkBytesFromNode } from './resource-inspect';
import { parseBndl } from './resource-types/bndl';
import { decodedIconToDataUrl, decodeDesktopIcon } from './resource-types/icon-decoder';
import {
  CDEV_ICON_ID,
  CUSTOM_ICON_ID,
  DEFAULT_ICON_ID,
  IconSet,
  IconSize,
} from './resource-types/icon-set';
import type { VNode } from './virtual-fs';
import { nodeRef } from './virtual-fs';
import type { NodeRef } from './catalog-caps';
import { refKey } from './catalog-caps';
import { escapeHostFilename } from '../protocol/host-filename';
import { isAbortError, throwIfAborted } from '../util/abort';
import {
  HAS_BUNDLE,
  HAS_CUSTOM_ICON,
  FINDER_IS_INVISIBLE,
  finderFlags,
  finderIconId,
  isFinderInvisible,
} from './finder-info';
import type { ByteRangeReader } from './byte-range';
import { bufferRangeReader } from './byte-range';
import { extractWinIcons, isWinIconName, pickIconNear } from './winicon';

export { HAS_BUNDLE, HAS_CUSTOM_ICON, FINDER_IS_INVISIBLE, finderFlags, isFinderInvisible, finderIconId };
export { isWinIconName } from './winicon';

export const CUSTOM_FOLDER_ICON_NAME = 'Icon\r';
/** Host-escaped form of Icon\\r (ClassicStack reserved-char token). */
export const CUSTOM_FOLDER_ICON_HOST_NAME = escapeHostFilename(CUSTOM_FOLDER_ICON_NAME);

export function isCustomFolderIconName(name: string): boolean {
  return name === CUSTOM_FOLDER_ICON_NAME || name === CUSTOM_FOLDER_ICON_HOST_NAME;
}

const ICON_CACHE_DB = 'classicstack-icon-cache';
/** Bump when decoded-icon preference or extract rules change so stale BW PNGs are dropped. */
const ICON_CACHE_DB_VERSION = 5;

export interface IconUrls {
  small: string;
  large: string;
}

export type DesktopIconBlob = { iconType: number; data: Uint8Array };

export interface IconLookupExtras {
  loadDesktopIcons?: (
    type: string,
    creator: string,
    signal?: AbortSignal,
  ) => Promise<DesktopIconBlob[] | null>;
  /** Ranged data-fork reader (PE/NE/.ico). */
  loadDataRange?: <T>(node: VNode, fn: (read: ByteRangeReader) => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
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

function cacheKey(creator: string, type: string): string {
  return `${padOsType(creator)}|${padOsType(type)}`;
}

function winCacheKey(node: VNode): string {
  return `win:${refKey(nodeRef(node))}:${node.modDate}:${node.dataBytes ?? node.data.length}`;
}

/** Classic Finder volume Desktop file (FNDR/ERIK); later a volume icon cache, not a glyph source. */
export function isVolumeDesktopFile(name: string, type: string, creator: string): boolean {
  return name === 'Desktop' && padOsType(type) === 'FNDR' && padOsType(creator) === 'ERIK';
}

/** Control panels, extensions, and chooser devices store their icon at -4064. */
const CDEV_STYLE_TYPES = new Set(['cdev', 'INIT', 'rdev', 'adev', 'ddev', 'sdev']);

export function isCdevStyleType(type: string): boolean {
  return CDEV_STYLE_TYPES.has(padOsType(type));
}

/** True when this file's own resource fork (not a type/creator cache) may hold a Finder icon. */
export function shouldReadIconFork(
  finderInfo: Uint8Array,
  type: string,
  cached?: IconUrls | null,
): boolean {
  const flags = finderFlags(finderInfo);
  if ((flags & HAS_CUSTOM_ICON) !== 0) return true;
  if (cached && !isSystemIconUrls(cached)) return false;
  const t = padOsType(type);
  return (flags & HAS_BUNDLE) !== 0 || t === 'APPL' || isCdevStyleType(t);
}

/** Ids / extract rules for a ranged resource-fork read. */
export function iconForkLoadOptions(node: { name: string; finderInfo: Uint8Array }): FinderIconForkOpts {
  const { type } = readTypeCreator(node.finderInfo);
  const flags = finderFlags(node.finderInfo);
  const extraIds: number[] = [];
  if (isCdevStyleType(type)) extraIds.push(CDEV_ICON_ID);
  if ((flags & HAS_CUSTOM_ICON) !== 0 || isCustomFolderIconName(node.name)) extraIds.push(CUSTOM_ICON_ID);
  const fid = finderIconId(node.finderInfo);
  if (fid) extraIds.push(fid);
  return {
    extraIds,
    includeAllIcons: isCustomFolderIconName(node.name),
  };
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

/** Classic System 7 folder glyphs served from ./icons. */
export const DEFAULT_FOLDER_ICONS: IconUrls = {
  small: systemIconUrl('DIR16.png'),
  large: systemIconUrl('DIR32.png'),
};

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

/** Filename suffix without a leading dot, lowercased. Empty when there is none. */
export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Icons8 glyphs used when a file has no Mac type icon (generic FILE16/FILE32). */
const DEFAULT_EXTENSION_ICONS: Record<string, string> = {
  exe: 'icons8-application-window-96.png',
  zip: 'icons8-archive-folder-96.png',
  cab: 'icons8-archive-folder-96.png',
  rar: 'icons8-archive-folder-96.png',
  '7z': 'icons8-archive-folder-96.png',
  arj: 'icons8-archive-folder-96.png',
  dll: 'icons8-dll-96.png',
  bmp: 'icons8-image-file-96.png',
  jpg: 'icons8-image-file-96.png',
  jpeg: 'icons8-image-file-96.png',
  gif: 'icons8-image-file-96.png',
  png: 'icons8-image-file-96.png',
  ico: 'icons8-image-file-96.png',
  cur: 'icons8-image-file-96.png',
  com: 'icons8-command-line-96.png',
  bat: 'icons8-command-line-96.png',
  cmd: 'icons8-command-line-96.png',
  sys: 'icons8-binary-file-96.png',
  vxd: 'icons8-binary-file-96.png',
  ocx: 'icons8-binary-file-96.png',
  pdf: 'icons8-pdf-1-96.png',
};

function extensionIconUrl(file: string): string {
  return `/icons/ui/${file}`;
}

/** Default Icons8 URLs for a filename suffix, or null when the suffix is unmapped. */
export function defaultIconsForExtension(name: string): IconUrls | null {
  const file = DEFAULT_EXTENSION_ICONS[fileExtension(name)];
  if (!file) return null;
  const url = extensionIconUrl(file);
  return { small: url, large: url };
}

function isGenericFileIconUrl(src: string): boolean {
  return /(?:^|\/)FILE(?:16|32)\.png(?:\?|$)/i.test(src);
}

/** True when the cache fell back to the classic FILE16/FILE32 PNGs. */
export function isGenericFileIcon(urls: IconUrls): boolean {
  return isGenericFileIconUrl(urls.small) || isGenericFileIconUrl(urls.large);
}

function withExtensionDefault(name: string | undefined, urls: IconUrls): IconUrls {
  if (!name || !isGenericFileIcon(urls)) return urls;
  return defaultIconsForExtension(name) ?? urls;
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
  const largeIcon =
    set.getIconBySize(IconSize.Large, true) ??
    set.getIconBySize(IconSize.Large, false) ??
    set.getIconBySize(IconSize.Small, true) ??
    set.getIconBySize(IconSize.Small, false);
  const smallIcon =
    set.getIconBySize(IconSize.Small, true) ??
    set.getIconBySize(IconSize.Small, false) ??
    largeIcon;
  if (!smallIcon && !largeIcon) return null;
  const small = smallIcon ? await decodedIconToDataUrl(smallIcon) : null;
  const large = largeIcon ? await decodedIconToDataUrl(largeIcon) : null;
  if (!small && !large) return null;
  return {
    small: small ?? large!,
    large: large ?? small!,
  };
}

function iconSetHasPreferredColor(set: IconSet): boolean {
  return set.icons.some((icon) => {
    const t = icon.typeCode.trim();
    return t === 'icl8' || t === 'ics8' || t === 'cicn';
  });
}

export class IconCache {
  private memory = new Map<string, IconUrls>();
  private bundleCache = new Map<string, BundleCacheEntry>();
  private dirMemory = new Map<string, IconUrls>();
  private desktopMemory = new Map<string, IconUrls>();
  private typeInflight = new Map<string, Promise<IconUrls>>();
  private dirInflight = new Map<string, Promise<IconUrls>>();
  private desktopInflight = new Map<string, Promise<IconUrls | null>>();
  private winMemory = new Map<string, IconUrls>();
  private winInflight = new Map<string, Promise<IconUrls | null>>();
  /** Type/creator keys whose cached glyph came from an 8-bit/cicn family (not ICN# / AFP B&W). */
  private colorKeys = new Set<string>();
  /** Type/creator keys whose resource fork was already opened for icons. */
  private iconForkTried = new Set<string>();
  /** Type/creator keys that resolved to a /icons fallback; do not probe again. */
  private defaultKeys = new Set<string>();
  /** Desktop DB GetIcon already returned nothing for this type/creator. */
  private desktopMiss = new Set<string>();
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
    this.desktopMemory.clear();
    this.winMemory.clear();
    this.colorKeys.clear();
    this.iconForkTried.clear();
    this.defaultKeys.clear();
    this.desktopMiss.clear();
    this.typeInflight.clear();
    this.dirInflight.clear();
    this.desktopInflight.clear();
    this.winInflight.clear();
    await this.init();
    if (!this.db) return;
    await this.clearStore('typeIcons');
  }

  /** Drop cached folder icons (e.g. after VirtualFS mutations / Icon\\r changes). */
  clearDirectoryCache(): void {
    this.dirMemory.clear();
    this.dirInflight.clear();
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
    try {
      await this.init();
      await this.db?.put('typeIcons', { key, small: urls.small, large: urls.large });
    } catch {
      /* private mode / tests without IndexedDB */
    }
  }

  private async loadPersisted(key: string): Promise<IconUrls | null> {
    try {
      await this.init();
      const row = await this.db?.get('typeIcons', key);
      if (!row) return null;
      this.colorKeys.add(key);
      return { small: row.small as string, large: row.large as string };
    } catch {
      return null;
    }
  }

  /** Resolve icons for a VirtualFS node (local share or remote AFP). */
  async getForNode(
    node: VNode,
    findChild?: (parent: NodeRef, name: string) => Promise<VNode | undefined>,
    loadIconFork?: (node: VNode) => Promise<ResourceFork | null>,
    extras?: IconLookupExtras,
  ): Promise<IconUrls> {
    await this.ensureDefaults();
    if (node.isDir) {
      return this.getForDirectory(String(nodeRef(node)), node, findChild, loadIconFork);
    }
    const extDefault = (urls: IconUrls) => withExtensionDefault(node.name, urls);
    if (isWinIconName(node.name)) {
      const win = await this.getForWinFile(node, extras);
      if (win) return extDefault(win);
    }
    const { type, creator } = readTypeCreator(node.finderInfo);
    if (isVolumeDesktopFile(node.name, type, creator)) {
      return this.getForTypeCreator(type, creator, node.name);
    }
    const key = cacheKey(creator, type);
    const cached = this.memory.get(key) ?? (await this.loadPersisted(key));
    if (cached) this.memory.set(key, cached);
    const custom = (finderFlags(node.finderInfo) & HAS_CUSTOM_ICON) !== 0;
    if (cached && !custom && this.colorKeys.has(key)) return extDefault(cached);
    if (cached && !custom && this.defaultKeys.has(key)) return extDefault(cached);
    if (cached && !custom && this.iconForkTried.has(key)) return extDefault(cached);

    throwIfAborted(extras?.signal);

    const needFork =
      !!loadIconFork &&
      shouldReadIconFork(node.finderInfo, type, this.colorKeys.has(key) ? cached : null);

    if (!custom && !needFork) {
      const pending = this.typeInflight.get(key);
      if (pending) {
        try {
          const urls = await pending;
          throwIfAborted(extras?.signal);
          return extDefault(urls);
        } catch (err) {
          if (!(isAbortError(err) && extras?.signal && !extras.signal.aborted)) {
            throw err;
          }
        }
      }
    }

    const work = this.resolveFileNode(node, type, creator, cached, loadIconFork, extras);
    if (!custom && !needFork) {
      this.typeInflight.set(key, work);
      void work.finally(() => {
        if (this.typeInflight.get(key) === work) this.typeInflight.delete(key);
      });
    }
    return extDefault(await work);
  }

  private async resolveFileNode(
    node: VNode,
    type: string,
    creator: string,
    cached: IconUrls | null,
    loadIconFork?: (node: VNode) => Promise<ResourceFork | null>,
    extras?: IconLookupExtras,
  ): Promise<IconUrls> {
    throwIfAborted(extras?.signal);
    let fork: ResourceFork | null = null;
    const key = cacheKey(creator, type);
    const custom = (finderFlags(node.finderInfo) & HAS_CUSTOM_ICON) !== 0;
    const needFork =
      !!loadIconFork &&
      shouldReadIconFork(node.finderInfo, type, this.colorKeys.has(key) ? cached : null);
    if (needFork) {
      try {
        throwIfAborted(extras?.signal);
        fork = await loadIconFork!(node);
      } catch (err) {
        if (isAbortError(err)) throw err;
        fork = null;
      }
      if (!custom && fork) this.iconForkTried.add(key);
    }
    const urls = await this.getForFile({
      type,
      creator,
      resource: node.resource,
      data: node.data,
      finderInfo: node.finderInfo,
      fork,
    });
    if (!isSystemIconUrls(urls)) return urls;
    if (fork && iconSetForFile(fork, type, node.finderInfo)) return urls;
    const probeDesktop = !!extras?.loadDesktopIcons && (custom || needFork);
    if (probeDesktop) {
      const desktop = await this.desktopFallback(type, creator, extras);
      if (desktop) return desktop;
      if (!this.desktopMiss.has(key)) return urls;
    }
    this.rememberDefault(key, urls);
    return urls;
  }

  private rememberDefault(key: string, urls: IconUrls): void {
    this.memory.set(key, urls);
    this.defaultKeys.add(key);
  }

  private async desktopFallback(
    type: string,
    creator: string,
    extras?: IconLookupExtras,
  ): Promise<IconUrls | null> {
    if (!extras?.loadDesktopIcons) return null;
    throwIfAborted(extras.signal);
    const key = cacheKey(creator, type);
    if (this.desktopMiss.has(key)) return null;
    const hit = this.desktopMemory.get(key);
    if (hit) return hit;

    const start = (): Promise<IconUrls | null> => {
      const work = (async () => {
        throwIfAborted(extras.signal);
        try {
          const blobs = await extras.loadDesktopIcons!(type, creator, extras.signal);
          throwIfAborted(extras.signal);
          if (!blobs?.length) {
            this.desktopMiss.add(key);
            return null;
          }
          const icons = blobs
            .map((b) => decodeDesktopIcon(b.iconType, b.data))
            .filter((i): i is NonNullable<typeof i> => i != null);
          if (!icons.length) {
            this.desktopMiss.add(key);
            return null;
          }
          const urls = await iconSetToUrls(new IconSet(icons));
          if (urls) this.desktopMemory.set(key, urls);
          return urls;
        } catch (err) {
          if (isAbortError(err)) throw err;
          return null;
        }
      })();
      this.desktopInflight.set(key, work);
      void work.finally(() => {
        if (this.desktopInflight.get(key) === work) this.desktopInflight.delete(key);
      });
      return work;
    };

    for (;;) {
      throwIfAborted(extras.signal);
      const pending = this.desktopInflight.get(key);
      const work = pending ?? start();
      try {
        const urls = await work;
        throwIfAborted(extras.signal);
        return urls;
      } catch (err) {
        if (isAbortError(err) && extras.signal && !extras.signal.aborted) continue;
        throw err;
      }
    }
  }

  /**
   * Decode Finder icons from an already-extracted fork (StuffIt / BinHex / …)
   * so later listings do not reopen that fork over AFP.
   */
  async ingestExtracted(args: {
    name: string;
    finderInfo: Uint8Array;
    resource: Uint8Array;
    data?: Uint8Array;
    fork?: ResourceFork | null;
  }): Promise<void> {
    const { type, creator } = readTypeCreator(args.finderInfo);
    if (isVolumeDesktopFile(args.name, type, creator)) return;
    if (!shouldReadIconFork(args.finderInfo, type) && !isCustomFolderIconName(args.name)) return;
    await this.ensureDefaults();
    const key = cacheKey(creator, type);
    this.defaultKeys.delete(key);
    let fork = args.fork ?? null;
    if (!fork || fork.allEntries.length === 0) {
      const picked = forkBytesFromNode({
        resource: args.resource,
        data: args.data ?? new Uint8Array(),
      });
      if (picked.source === 'empty' || picked.bytes.length < 16) return;
      const bytes = picked.bytes;
      try {
        fork = await loadFinderIconFork(
          async (offset, count) => bytes.subarray(offset, Math.min(bytes.length, offset + count)),
          iconForkLoadOptions(args),
        );
      } catch {
        fork = ResourceFork.fromBytes(bytes);
      }
    }
    if (!fork || fork.allEntries.length === 0) return;
    this.iconForkTried.add(key);
    await this.getForFile({
      type,
      creator,
      resource: args.resource,
      data: args.data,
      finderInfo: args.finderInfo,
      fork,
    });
  }

  private async getForWinFile(node: VNode, extras?: IconLookupExtras): Promise<IconUrls | null> {
    const key = winCacheKey(node);
    const hit = this.winMemory.get(key);
    if (hit) return hit;
    const pending = this.winInflight.get(key);
    if (pending) return pending;

    const work = (async (): Promise<IconUrls | null> => {
      throwIfAborted(extras?.signal);
      try {
        const icons = extras?.loadDataRange
          ? await extras.loadDataRange(node, (read) => extractWinIcons(read))
          : node.data.length >= 6
            ? await extractWinIcons(bufferRangeReader(node.data))
            : [];
        throwIfAborted(extras?.signal);
        if (!icons.length) return null;
        const smallIcon = pickIconNear(icons, 16);
        const largeIcon = pickIconNear(icons, 32);
        if (!smallIcon && !largeIcon) return null;
        const small = smallIcon ? await decodedIconToDataUrl(smallIcon) : null;
        const large = largeIcon ? await decodedIconToDataUrl(largeIcon) : null;
        if (!small && !large) return null;
        const urls: IconUrls = { small: small ?? large!, large: large ?? small! };
        this.winMemory.set(key, urls);
        return urls;
      } catch (err) {
        if (isAbortError(err)) throw err;
        return null;
      }
    })();
    this.winInflight.set(key, work);
    void work.finally(() => {
      if (this.winInflight.get(key) === work) this.winInflight.delete(key);
    });
    return work;
  }

  /** Resolve icons when only Finder info is known (remote listings). */
  async getForTypeCreator(type: string, creator: string, name?: string): Promise<IconUrls> {
    await this.ensureDefaults();
    const key = cacheKey(creator, type);
    const pending = this.typeInflight.get(key);
    if (pending) return withExtensionDefault(name, await pending);
    const cached = this.memory.get(key) ?? (await this.loadPersisted(key));
    if (cached) {
      this.memory.set(key, cached);
      return withExtensionDefault(name, cached);
    }
    const urls: IconUrls = {
      small: await resolveSystemIcon(type, 16),
      large: await resolveSystemIcon(type, 32),
    };
    this.memory.set(key, urls);
    return withExtensionDefault(name, urls);
  }

  private async getForDirectory(
    pathKey: string,
    node: VNode,
    findChild?: (parent: NodeRef, name: string) => Promise<VNode | undefined>,
    loadIconFork?: (node: VNode) => Promise<ResourceFork | null>,
  ): Promise<IconUrls> {
    const hit = this.dirMemory.get(pathKey);
    if (hit) return hit;

    // Named Icon\\r lookup only when the folder has the custom-icon flag and
    // the caller supplies findChild (Finder does this for on-screen folders).
    // Do not enumerate the directory, and do not probe folders that are only
    // using the default glyph.
    const custom = (finderFlags(node.finderInfo) & HAS_CUSTOM_ICON) !== 0;
    if (!custom || !findChild) {
      const urls = this.defaultFolder ?? DEFAULT_FOLDER_ICONS;
      this.dirMemory.set(pathKey, urls);
      return urls;
    }

    const pending = this.dirInflight.get(pathKey);
    if (pending) return pending;
    const work = this.probeDirectory(pathKey, node, findChild, loadIconFork);
    this.dirInflight.set(pathKey, work);
    void work.finally(() => {
      if (this.dirInflight.get(pathKey) === work) this.dirInflight.delete(pathKey);
    });
    return work;
  }

  private async probeDirectory(
    pathKey: string,
    node: VNode,
    findChild: (parent: NodeRef, name: string) => Promise<VNode | undefined>,
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
        const rf = loadIconFork
          ? await loadIconFork(node)
          : node.resource.length > 16
            ? ResourceFork.fromBytes(node.resource)
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
      } catch (err) {
        if (isAbortError(err)) throw err;
        /* fall through */
      }
    }

    const urls = this.defaultFolder ?? DEFAULT_FOLDER_ICONS;
    this.dirMemory.set(pathKey, urls);
    return urls;
  }

  private async tryCustomFolderIconFile(
    dir: VNode,
    findChild?: (parent: NodeRef, name: string) => Promise<VNode | undefined>,
    loadIconFork?: (node: VNode) => Promise<ResourceFork | null>,
  ): Promise<IconUrls | null> {
    if (!findChild) return null;
    try {
      const iconFile =
        (await findChild(nodeRef(dir), CUSTOM_FOLDER_ICON_NAME)) ??
        (await findChild(nodeRef(dir), CUSTOM_FOLDER_ICON_HOST_NAME));
      if (!iconFile || iconFile.isDir) return null;
      const rsrcLen = iconFile.resourceBytes ?? iconFile.resource.length;
      if (iconFile.resource.length < 16 && rsrcLen < 16) return null;
      const rf = loadIconFork
        ? await loadIconFork(iconFile)
        : iconFile.resource.length >= 16
          ? ResourceFork.fromBytes(iconFile.resource)
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
    const custom = (finderFlags(args.finderInfo) & HAS_CUSTOM_ICON) !== 0;
    const cached = this.memory.get(key) ?? (await this.loadPersisted(key));
    if (cached && !custom && this.colorKeys.has(key) && !rf) {
      this.memory.set(key, cached);
      return cached;
    }

    if (!rf) {
      if (cached) {
        this.memory.set(key, cached);
        return cached;
      }
      const urls: IconUrls = {
        small: await resolveSystemIcon(args.type, 16),
        large: await resolveSystemIcon(args.type, 32),
      };
      this.memory.set(key, urls);
      return urls;
    }

    try {
      await this.tryBundle(rf, args.type, args.creator, key);
      if (this.colorKeys.has(key)) {
        const hit = this.memory.get(key);
        if (hit && !isSystemIconUrls(hit)) return hit;
      }

      const set = iconSetForFile(rf, args.type, args.finderInfo);
      if (set) {
        const urls = await iconSetToUrls(set);
        if (urls) {
          if (!custom) {
            this.memory.set(key, urls);
            if (iconSetHasPreferredColor(set)) {
              this.colorKeys.add(key);
              await this.persist(key, urls);
            }
          }
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
      this.iconForkTried.add(k);
      this.defaultKeys.delete(k);
      if (iconSetHasPreferredColor(set)) {
        this.colorKeys.add(k);
        await this.persist(k, urls);
      }
    };

    for (const [ftype, localId] of fref) {
      const set = icons.get(localId);
      if (!set) continue;
      await persistSet(cacheKey(ownerKey, ftype), set);
      if (ownerKey !== creator) await persistSet(cacheKey(creator, ftype), set);
    }

    if (this.colorKeys.has(key)) return;
    const set = iconSetForFile(rf, type, new Uint8Array(32));
    if (set) await persistSet(key, set);
  }
}

/** Shared singleton used by Finder + Advanced menu. */
export const iconCache = new IconCache();
