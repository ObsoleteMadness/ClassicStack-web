/** Volume-declared Finder catalog capabilities (shared by PWA and Go SPA). */

import type { ShareKind } from '../ui/finder-host';

/** Native catalog address: CNID number or store path (`''` = volume root). */
export type NodeRef = number | string;

export type AddressBy = 'cnid' | 'path';
export type NameKind = 'long' | 'medium' | 'short';
export type DateField = 'created' | 'modified' | 'accessed' | 'backup';
export type NameCase = 'preserve' | 'upper' | 'insensitive';
export type PathFormat = 'posix' | 'mac' | 'dos' | 'ncp';

export type AttrField = {
  id: string;
  label: string;
  type: 'bool';
  editable?: boolean;
};

export type VolumeIdentity = {
  shareKind: ShareKind;
  protocol?: ShareKind | 'afp' | 'smb' | 'ncp' | 'etherdfs';
  filesystem?: string;
  transport?: string;
  forkBackend?: string;
  dialect?: string;
  os?: string;
};

export type CatalogCapabilities = {
  identity: VolumeIdentity;
  addressBy: AddressBy;
  readOnly: boolean;
  resourceFork: boolean;
  finderInfo: boolean;
  desktopIcons: boolean;
  resourceIcons: boolean;
  names: NameKind[];
  maxNameBytes: Partial<Record<NameKind, number>>;
  nameCase: NameCase;
  dates: DateField[];
  attributes: AttrField[];
  hideAttribute?: string;
  pathFormat: PathFormat;
};

const DOS_ATTRS: AttrField[] = [
  { id: 'readonly', label: 'Read only', type: 'bool', editable: true },
  { id: 'hidden', label: 'Hidden', type: 'bool', editable: true },
  { id: 'system', label: 'System', type: 'bool', editable: true },
  { id: 'archive', label: 'Archive', type: 'bool', editable: true },
];

const AFP_ATTRS: AttrField[] = [
  { id: 'invisible', label: 'Invisible', type: 'bool', editable: true },
  { id: 'locked', label: 'Locked', type: 'bool', editable: true },
];

const AFP_DATES: DateField[] = ['created', 'modified', 'backup'];
const DOS_DATES: DateField[] = ['created', 'modified', 'accessed'];

export const afpVolumeCaps: CatalogCapabilities = {
  identity: { shareKind: 'afp', protocol: 'afp' },
  addressBy: 'cnid',
  readOnly: false,
  resourceFork: true,
  finderInfo: true,
  desktopIcons: true,
  resourceIcons: true,
  names: ['long'],
  maxNameBytes: { long: 31 },
  nameCase: 'preserve',
  dates: AFP_DATES,
  attributes: AFP_ATTRS,
  hideAttribute: 'invisible',
  pathFormat: 'mac',
};

export const smbVolumeCaps: CatalogCapabilities = {
  identity: { shareKind: 'smb', protocol: 'smb' },
  addressBy: 'path',
  readOnly: false,
  resourceFork: false,
  finderInfo: false,
  desktopIcons: false,
  resourceIcons: false,
  names: ['long', 'short'],
  maxNameBytes: { long: 255, short: 12 },
  nameCase: 'preserve',
  dates: DOS_DATES,
  attributes: DOS_ATTRS,
  hideAttribute: 'hidden',
  pathFormat: 'dos',
};

export const ncpVolumeCaps: CatalogCapabilities = {
  identity: { shareKind: 'ncp', protocol: 'ncp' },
  addressBy: 'path',
  readOnly: false,
  resourceFork: false,
  finderInfo: false,
  desktopIcons: false,
  resourceIcons: false,
  names: ['long', 'short'],
  maxNameBytes: { long: 255, short: 12 },
  nameCase: 'insensitive',
  dates: DOS_DATES,
  attributes: DOS_ATTRS,
  hideAttribute: 'hidden',
  pathFormat: 'ncp',
};

export const edfsVolumeCaps: CatalogCapabilities = {
  identity: { shareKind: 'etherdfs', protocol: 'etherdfs' },
  addressBy: 'path',
  readOnly: false,
  resourceFork: false,
  finderInfo: false,
  desktopIcons: false,
  resourceIcons: false,
  names: ['short'],
  maxNameBytes: { short: 12 },
  nameCase: 'upper',
  dates: DOS_DATES,
  attributes: DOS_ATTRS,
  hideAttribute: 'hidden',
  pathFormat: 'dos',
};

/** Local ClassicStack share: union of fork + DOS engines; addressing follows protocol. */
export const localShareCaps: CatalogCapabilities = {
  identity: { shareKind: 'local', protocol: 'afp', filesystem: 'local_fs' },
  addressBy: 'cnid',
  readOnly: false,
  resourceFork: true,
  finderInfo: true,
  desktopIcons: false,
  resourceIcons: true,
  names: ['long', 'medium', 'short'],
  maxNameBytes: { long: 255, medium: 31, short: 12 },
  nameCase: 'preserve',
  dates: ['created', 'modified', 'accessed'],
  attributes: [...AFP_ATTRS, ...DOS_ATTRS],
  hideAttribute: 'invisible',
  pathFormat: 'posix',
};

const AFP_EPOCH_MS = Date.UTC(2000, 0, 1);

/** Catalog timestamps are Unix ms. Convert AFP Mac time or Unix seconds if needed. */
export function toUnixMs(t: number): number {
  if (!t) return 0;
  if (t > 1e11) return t;
  if (t > 1e9) return t * 1000;
  return AFP_EPOCH_MS + t * 1000;
}

/** Unix milliseconds → AFP Mac time (seconds since 2000-01-01 UTC). */
export function fromUnixMs(ms: number): number {
  if (!ms) return 0;
  return Math.round((ms - AFP_EPOCH_MS) / 1000);
}

/** Get Info type/creator editors — only when the volume stores Finder info. */
export function showsTypeCreator(caps: CatalogCapabilities, isDir = false): boolean {
  return !!caps.finderInfo && !isDir;
}

/** Resource Fork action — only when the volume stores a resource fork. */
export function showsResourceFork(caps: CatalogCapabilities): boolean {
  return !!caps.resourceFork;
}

/** Catalog capabilities for a Finder session. Prefer the server-declared set. */
export function catalogCapsForSession(session: {
  kind?: string;
  protocol?: string;
  capabilities?: CatalogCapabilities | null;
}): CatalogCapabilities {
  if (session.capabilities) return session.capabilities;
  const kind = (session.kind || '').toLowerCase();
  const proto = (session.protocol || kind).toLowerCase();
  const asLocal = (caps: CatalogCapabilities, protocol: VolumeIdentity['protocol']): CatalogCapabilities =>
    kind === 'local'
      ? { ...caps, identity: { shareKind: 'local', protocol, filesystem: 'local_fs' } }
      : caps;
  switch (proto) {
    case 'smb':
      return asLocal(smbVolumeCaps, 'smb');
    case 'ncp':
      return asLocal(ncpVolumeCaps, 'ncp');
    case 'etherdfs':
      return asLocal(edfsVolumeCaps, 'etherdfs');
    case 'local':
      return localShareCaps;
    default:
      return kind === 'local' ? localShareCaps : afpVolumeCaps;
  }
}

export function isPathRef(ref: NodeRef): ref is string {
  return typeof ref === 'string';
}

export function refsEqual(a: NodeRef, b: NodeRef): boolean {
  return a === b;
}

/** Map key that distinguishes CNID `2` from path `"2"`. */
export function refKey(ref: NodeRef): string {
  return typeof ref === 'string' ? `p:${ref}` : `c:${ref}`;
}

export function parentPathOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function joinStorePath(parent: string, name: string): string {
  const n = name.replace(/^\/+|\/+$/g, '');
  if (!n) return parent;
  return parent ? `${parent}/${n}` : n;
}

export function leafName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Parse a `refKey` (or a legacy numeric `data-id`) back to a NodeRef. */
export function parseRefKey(key: string | null | undefined): NodeRef | null {
  if (key == null || key === '') return null;
  if (key.startsWith('p:')) return key.slice(2);
  if (key.startsWith('c:')) {
    const n = Number(key.slice(2));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(key);
  if (key !== '' && Number.isFinite(n) && String(n) === key) return n;
  return key;
}

/** Narrow a NodeRef to a CNID. Path catalogs must not call this. */
export function asCnid(ref: NodeRef): number {
  if (typeof ref !== 'number') throw new Error('cnid catalog requires numeric id');
  return ref;
}

/** Narrow a NodeRef to a store path. CNID catalogs must not call this. */
export function asPath(ref: NodeRef): string {
  if (typeof ref !== 'string') throw new Error('path catalog requires store path');
  return ref;
}

/** Query params for a native catalog ref (`id` xor `path`). */
export function refQuery(ref: NodeRef): { id?: string; path?: string } {
  return typeof ref === 'string' ? { path: ref } : { id: String(ref) };
}

export function refBody(ref: NodeRef): { id?: number; path?: string } {
  return typeof ref === 'string' ? { path: ref } : { id: ref };
}

export function parentBody(parent: NodeRef): { parentId?: number; parentPath?: string } {
  return typeof parent === 'string' ? { parentPath: parent } : { parentId: parent };
}
