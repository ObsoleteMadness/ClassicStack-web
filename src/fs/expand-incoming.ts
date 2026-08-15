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
const EXPANDABLE_EXTS = new Set(['sit', 'hqx', 'bin', 'zip']);

/** True when the Finder should offer Expand (`.sit` / `.hqx` / `.bin` / `.zip`, StuffIt type, ZIP, or BinHex TEXT/SITx). */
export function isExpandableArchive(name: string, finderInfo?: Uint8Array): boolean {
  if (EXPANDABLE_EXTS.has(filenameExtension(name))) return true;
  if (!finderInfo || finderInfo.length < 8) return false;
  const type = ostypeFromBytes(finderInfo, 0);
  const creator = ostypeFromBytes(finderInfo, 4);
  return SIT_TYPES.has(type) || type === 'ZIP ' || (type === 'TEXT' && creator === 'SITx');
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

  const hqx = parseBinHex(data);
  if (hqx) return finishMacFile(hqx, depth + 1);

  const mb = parseMacBinary(data);
  if (mb) return finishMacFile(mb, depth + 1);

  if (resource.length === 0) {
    const as = parseAppleSingle(data);
    if (as) {
      return finishMacFile(
        {
          name,
          data: as.data,
          resource: as.resource,
          finderInfo: as.finderInfo,
        },
        depth + 1,
      );
    }
  }

  if (isStuffItArchive(data)) {
    const entries = parseStuffIt(data);
    if (entries && entries.length) return expandNodes(sitEntriesToTree(entries), depth + 1);
  }

  if (isZipArchive(data)) {
    const entries = parseZip(data);
    if (entries && entries.length) return expandNodes(zipMembersToTree(entries), depth + 1);
  }
  return null;
}

function finishMacFile(file: MacFile, depth: number): ExpandedNode[] {
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
  const nested = expandBytes(current.name, current.data, current.resource, depth);
  if (nested) return nested;
  return [{ kind: 'file', ...current }];
}

/** Keep unwrapping members that are themselves BinHex / MacBinary / StuffIt / ZIP. */
function expandNodes(nodes: ExpandedNode[], depth: number): ExpandedNode[] {
  const out: ExpandedNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.push({ ...node, children: expandNodes(node.children, depth) });
      continue;
    }
    const nested = expandBytes(node.name, node.data, node.resource, depth);
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
