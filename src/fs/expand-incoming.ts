/** Unwrap BinHex / MacBinary / StuffIt / ZIP wrappers dropped into the Finder. */

import { parseAppleSingle } from './appledouble';
import { parseBinHex } from './binhex';
import { filenameExtension } from './extension-map';
import type { MacFile } from './mac-file';
import { makeFinderInfo, ostypeFromBytes } from './mac-file';
import { parseMacBinary } from './macbinary';
import { SitError } from './stuffit-codec';
import { isStuffItArchive, parseStuffIt, stuffItExpandError, type SitEntry } from './stuffit';
import { isZipArchive, parseZip, type ZipMember } from './zip';
import {
  ARCHIVE_CODEC_APPLESINGLE,
  ARCHIVE_CODEC_BINHEX,
  ARCHIVE_CODEC_MACBINARY,
  ARCHIVE_CODEC_SIT,
  ARCHIVE_CODEC_ZIP,
  registerArchiveCodec,
  sniffArchiveCodec,
} from './codecs';

const MAX_DEPTH = 8;

export type ExpandedFile = MacFile & { kind: 'file' };
export type ExpandedDir = {
  kind: 'dir';
  name: string;
  children: ExpandedNode[];
  finderInfo?: Uint8Array;
  createDate?: number;
  modDate?: number;
};
export type ExpandedNode = ExpandedFile | ExpandedDir;

export { isStuffItArchive, isZipArchive };

const SIT_TYPES = new Set(['SIT!', 'SIT5', 'SITD']);

/**
 * True when the Finder should offer Expand (`.sit` / `.hqx` / `.bin` / `.zip`, StuffIt type, ZIP,
 * or BinHex stored as TEXT/SITx). Pass `data` when loaded: Expander Read Me files are also
 * TEXT/SITx but are not archives. Registered archive codecs are consulted first so a replacement
 * SIT expander can opt files in or out.
 */
export function isExpandableArchive(name: string, finderInfo?: Uint8Array, data?: Uint8Array): boolean {
  const codec = sniffArchiveCodec({ name, finderInfo, data });
  return codec != null && codec.expandable !== false;
}

/** Modal body when Expand cannot unpack a file. Never uses Finder type/creator. */
export function expandFailureMessage(err?: unknown): string {
  if (err instanceof SitError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'This archive appears to be corrupted.';
}

/**
 * Expand for the Finder menu: throws SitError (corrupt vs unsupported header type/codec).
 * Drop-import still uses expandIncoming, which returns null for packed leftovers.
 */
export function expandArchiveFile(name: string, bytes: Uint8Array): ExpandedNode[] {
  try {
    const out = expandIncoming(name, bytes);
    if (out) {
      if (isUnexpandedSit(out) && isSitExpandTarget(name, bytes)) {
        const inner = out[0]!.kind === 'file' ? out[0].data : bytes;
        throw stuffItExpandError(inner);
      }
      return out;
    }
    if (isSitExpandTarget(name, bytes)) throw stuffItExpandError(bytes);
    throw new SitError('This archive appears to be corrupted.', 'corrupt');
  } catch (err) {
    if (err instanceof SitError) throw err;
    if (isSitExpandTarget(name, bytes)) throw stuffItExpandError(bytes, err);
    throw err instanceof Error ? err : new SitError('This archive appears to be corrupted.', 'corrupt');
  }
}

function isUnexpandedSit(nodes: ExpandedNode[]): boolean {
  return nodes.length === 1 && nodes[0]!.kind === 'file' && isStuffItArchive(nodes[0].data);
}

function isSitExpandTarget(name: string, bytes: Uint8Array): boolean {
  return filenameExtension(name) === 'sit' || isStuffItArchive(bytes);
}

/**
 * If `bytes` is BinHex, MacBinary, StuffIt, or ZIP (possibly nested), return the inner items.
 * Returns null when the payload should be imported unchanged.
 */
export function expandIncoming(name: string, bytes: Uint8Array): ExpandedNode[] | null {
  return expandBytes(name, bytes, new Uint8Array(), 0);
}

function expandBytes(name: string, data: Uint8Array, resource: Uint8Array, depth: number): ExpandedNode[] | null {
  if (depth > MAX_DEPTH) return null;

  const codec = sniffArchiveCodec({ name, data, resource });
  if (!codec) return null;
  const out = codec.expand(name, data);
  if (!out?.length) return null;
  return expandNodes(out, depth + 1);
}

function macFileNode(file: MacFile): ExpandedFile {
  let current = file;
  if (current.resource.length === 0) {
    const as = parseAppleSingle(current.data);
    if (as) {
      current = {
        name: current.name,
        data: as.data,
        resource: as.resource,
        finderInfo: as.finderInfo,
        createDate: current.createDate,
        modDate: current.modDate,
      };
    }
  }
  return { kind: 'file', ...current };
}

/** Nested members that cannot be unpacked stay packed instead of aborting the parent archive. */
function tryExpandBytes(
  name: string,
  data: Uint8Array,
  resource: Uint8Array,
  depth: number,
): ExpandedNode[] | null {
  try {
    return expandBytes(name, data, resource, depth);
  } catch {
    return null;
  }
}

/** Keep unwrapping members that are themselves BinHex / MacBinary / StuffIt / ZIP. */
export function expandedFromSitEntries(entries: SitEntry[]): ExpandedNode[] {
  return expandNodes(sitEntriesToTree(entries), 1);
}

function expandNodes(nodes: ExpandedNode[], depth: number): ExpandedNode[] {
  const out: ExpandedNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.push({ ...node, children: expandNodes(node.children, depth) });
      continue;
    }
    const nested = tryExpandBytes(node.name, node.data, node.resource, depth);
    if (nested) out.push(...nested);
    else out.push(node);
  }
  return out;
}

function sitEntriesToTree(entries: SitEntry[]): ExpandedNode[] {
  return membersToTree(
    entries.map((e) => ({
      path: e.name,
      isFolder: e.isFolder,
      data: e.data,
      resource: e.resource,
      finderInfo: makeFinderInfo(e.fileType, e.creator, e.finderFlags),
      createDate: e.createDate || undefined,
      modDate: e.modDate || undefined,
    })),
  );
}

function zipMembersToTree(entries: ZipMember[]): ExpandedNode[] {
  return membersToTree(entries);
}

function membersToTree(
  entries: {
    path: string;
    isFolder: boolean;
    data?: Uint8Array;
    resource?: Uint8Array;
    finderInfo?: Uint8Array;
    createDate?: number;
    modDate?: number;
  }[],
): ExpandedNode[] {
  const root: ExpandedNode[] = [];
  const dirs = new Map<string, ExpandedDir>();
  const ensureDir = (path: string): ExpandedDir => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const parts = path.split('/');
    const name = parts.pop()!;
    const node: ExpandedDir = { kind: 'dir', name, children: [] };
    dirs.set(path, node);
    if (parts.length === 0) root.push(node);
    else ensureDir(parts.join('/')).children.push(node);
    return node;
  };
  for (const e of entries) {
    const parts = e.path.split('/').filter(Boolean);
    if (!parts.length) continue;
    const parentPath = parts.slice(0, -1).join('/');
    const parent = parentPath ? ensureDir(parentPath).children : root;
    if (e.isFolder) {
      const dir = ensureDir(e.path);
      if (e.finderInfo) dir.finderInfo = e.finderInfo;
      if (e.createDate) dir.createDate = e.createDate;
      if (e.modDate) dir.modDate = e.modDate;
      continue;
    }
    parent.push({
      kind: 'file',
      name: parts[parts.length - 1]!,
      data: e.data ?? new Uint8Array(),
      resource: e.resource ?? new Uint8Array(),
      finderInfo: e.finderInfo ?? new Uint8Array(32),
      createDate: e.createDate,
      modDate: e.modDate,
    });
  }
  return root;
}

function finderType(finderInfo?: Uint8Array): string | undefined {
  if (!finderInfo || finderInfo.length < 4) return undefined;
  return ostypeFromBytes(finderInfo, 0);
}

function finderCreator(finderInfo?: Uint8Array): string | undefined {
  if (!finderInfo || finderInfo.length < 8) return undefined;
  return ostypeFromBytes(finderInfo, 4);
}

/** Register bundled expanders. Later `registerArchiveCodec` with the same id replaces one. */
function registerBuiltinArchiveCodecs(): void {
  // Last registered is sniffed first, matching the previous BinHex → MacBinary → AppleSingle → SIT → ZIP order.
  registerArchiveCodec({
    id: ARCHIVE_CODEC_ZIP,
    sniff: ({ name, finderInfo, data }) =>
      filenameExtension(name) === 'zip' || finderType(finderInfo) === 'ZIP ' || (!!data?.length && isZipArchive(data)),
    expand: (_name, data) => {
      const entries = parseZip(data);
      return entries?.length ? zipMembersToTree(entries) : null;
    },
  });
  registerArchiveCodec({
    id: ARCHIVE_CODEC_SIT,
    sniff: ({ name, finderInfo, data }) => {
      const type = finderType(finderInfo);
      return (
        filenameExtension(name) === 'sit' ||
        (!!type && SIT_TYPES.has(type)) ||
        (!!data?.length && isStuffItArchive(data))
      );
    },
    expand: (_name, data) => {
      const entries = parseStuffIt(data);
      return entries?.length ? sitEntriesToTree(entries) : null;
    },
  });
  registerArchiveCodec({
    id: ARCHIVE_CODEC_APPLESINGLE,
    expandable: false,
    sniff: ({ data, resource }) => !resource?.length && !!data?.length && parseAppleSingle(data) != null,
    expand: (name, data) => {
      const as = parseAppleSingle(data);
      if (!as) return null;
      return [{ kind: 'file', name, data: as.data, resource: as.resource, finderInfo: as.finderInfo }];
    },
  });
  registerArchiveCodec({
    id: ARCHIVE_CODEC_MACBINARY,
    sniff: ({ name, data }) => filenameExtension(name) === 'bin' || (!!data?.length && parseMacBinary(data) != null),
    expand: (_name, data) => {
      const mb = parseMacBinary(data);
      return mb ? [macFileNode(mb)] : null;
    },
  });
  registerArchiveCodec({
    id: ARCHIVE_CODEC_BINHEX,
    sniff: ({ name, finderInfo, data }) => {
      if (filenameExtension(name) === 'hqx') return true;
      if (finderType(finderInfo) === 'TEXT' && finderCreator(finderInfo) === 'SITx') {
        return !data?.length || parseBinHex(data) != null;
      }
      return !!data?.length && parseBinHex(data) != null;
    },
    expand: (_name, data) => {
      const hqx = parseBinHex(data);
      return hqx ? [macFileNode(hqx)] : null;
    },
  });
}

registerBuiltinArchiveCodecs();
