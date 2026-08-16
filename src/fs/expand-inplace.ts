/** Expand an existing StuffIt archive via Catalog ranged reads (headers, then each member). */

import { hfsTimeToAfp } from '../protocol/afp/constants';
import { makeFinderInfo } from './mac-file';
import { expandedFromSitEntries, type ExpandedDir } from './expand-incoming';
import { importExpandedTree, type ImportItemTrack, type ExpandTrackFile } from './import-transfer';
import {
  extractSitMember,
  parseStuffItFromReader,
  stuffItExpandError,
  type SitPackedMember,
} from './stuffit';
import { SitError } from './stuffit-codec';
import {
  planItemPlacement,
  TransferCancelled,
  type NameConflictChoice,
} from './name-conflict';
import { throwIfAborted } from '../util/abort';
import { log } from '../util/logger';
import type { Catalog, VNode } from './virtual-fs';
import type { ByteRangeReader } from './byte-range';

export type ExpandSitInPlaceOpts = {
  fileSize?: number;
  track?: ImportItemTrack;
  resolveConflict: (info: {
    name: string;
    isDir: boolean;
    suggestedName: string;
  }) => Promise<NameConflictChoice>;
  /** Wrap catalog writes (Finder own-mutation + beginBatch/endBatch). */
  wrapWrite?: (fn: () => Promise<void>) => Promise<void>;
};

type MetaFile = { kind: 'file'; name: string; member: SitPackedMember };
type MetaDir = { kind: 'dir'; name: string; children: MetaNode[]; member?: SitPackedMember };
type MetaNode = MetaFile | MetaDir;

type ExpandFs = Pick<
  Catalog,
  'withRangeReader' | 'lookup' | 'remove' | 'ensureDir' | 'createFile' | 'put'
>;

/**
 * Expand a StuffIt archive through VFS range reads. Returns false when the
 * payload is not StuffIt (caller should load the whole file and use expandArchiveFile).
 */
export async function expandSitInPlace(
  fs: ExpandFs,
  node: VNode,
  opts: ExpandSitInPlaceOpts,
): Promise<boolean> {
  log.trace(`expand in-place “${node.name}” ${opts.fileSize ?? node.dataBytes ?? node.data.length}b`, 'expand');
  return fs.withRangeReader(
    node,
    (read) => expandSitFromReader(fs, node.parentId, read, opts),
    { signal: opts.track?.signal },
  );
}

async function expandSitFromReader(
  fs: ExpandFs,
  parentId: number,
  read: ByteRangeReader,
  opts: ExpandSitInPlaceOpts,
): Promise<boolean> {
  let creditCatalog = true;
  const catalogRead: ByteRangeReader = async (offset, count) => {
    throwIfAborted(opts.track?.signal);
    const buf = await read(offset, count);
    if (creditCatalog) opts.track?.onBytes?.(buf.length);
    return buf;
  };
  opts.track?.onStatus?.('Reading archive');
  let members: SitPackedMember[] | null;
  try {
    members = await parseStuffItFromReader(catalogRead, opts.fileSize);
  } catch (err) {
    if (err instanceof SitError) throw err;
    throw stuffItExpandError(new Uint8Array(), err);
  }
  creditCatalog = false;
  if (!members) return false;
  if (!members.length) throw stuffItExpandError(new Uint8Array());
  log.trace(`expand catalog ${members.length} member(s)`, 'expand');

  const tree = sitPackedToTree(members);
  const reserved = new Set<string>();
  const planned: { item: MetaNode; replaceId: number | null }[] = [];
  for (const item of tree) {
    const plan = await planItemPlacement(fs, parentId, item.name, item.kind === 'dir', {
      reserved,
      resolveConflict: opts.resolveConflict,
    });
    if (!plan) throw new TransferCancelled();
    reserved.add(plan.destName.toLowerCase());
    planned.push({ item: renameMeta(item, plan.destName), replaceId: plan.replaceId });
  }

  const files = metaFiles(planned.map((row) => row.item));
  opts.track?.onExpandBegin?.(
    files.reduce((n, f) => n + f.bytesTotal, 0),
    files,
  );

  const write = async (): Promise<void> => {
    for (const row of planned) {
      if (row.replaceId != null) await fs.remove(row.replaceId);
    }
    for (const row of planned) {
      await writeMetaNode(fs, parentId, row.item, catalogRead, opts.track);
    }
  };
  if (opts.wrapWrite) await opts.wrapWrite(write);
  else await write();
  return true;
}

function renameMeta(node: MetaNode, name: string): MetaNode {
  return { ...node, name };
}

function sitPackedToTree(members: SitPackedMember[]): MetaNode[] {
  const root: MetaNode[] = [];
  const dirs = new Map<string, MetaDir>();
  const ensureDir = (path: string, member?: SitPackedMember): MetaDir => {
    const hit = dirs.get(path);
    if (hit) {
      if (member) hit.member = member;
      return hit;
    }
    const parts = path.split('/');
    const name = parts.pop()!;
    const node: MetaDir = { kind: 'dir', name, children: [], member };
    dirs.set(path, node);
    if (parts.length === 0) root.push(node);
    else ensureDir(parts.join('/')).children.push(node);
    return node;
  };
  for (const m of members) {
    const parts = m.name.split('/').filter(Boolean);
    if (!parts.length) continue;
    const parentPath = parts.slice(0, -1).join('/');
    const parent = parentPath ? ensureDir(parentPath).children : root;
    if (m.isFolder) {
      ensureDir(m.name, m);
      continue;
    }
    parent.push({ kind: 'file', name: parts[parts.length - 1]!, member: m });
  }
  return root;
}

function metaFiles(nodes: MetaNode[], prefix = ''): ExpandTrackFile[] {
  const out: ExpandTrackFile[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.kind === 'dir') {
      out.push(...metaFiles(node.children, path));
      continue;
    }
    out.push({
      name: node.name,
      path,
      bytesTotal: node.member.dataUlen + node.member.rsrcUlen,
      finderInfo: makeFinderInfo(node.member.fileType, node.member.creator, node.member.finderFlags),
    });
  }
  return out;
}

async function writeMetaNode(
  fs: ExpandFs,
  parentId: number,
  node: MetaNode,
  read: ByteRangeReader,
  track?: ImportItemTrack,
  prefix = '',
): Promise<void> {
  const path = prefix ? `${prefix}/${node.name}` : node.name;
  if (node.kind === 'dir') {
    log.trace(`expand dir “${path}”`, 'expand');
    const dir = await fs.ensureDir(parentId, node.name);
    const folderMeta = folderExpanded(node);
    if (folderMeta) await stampDir(fs, dir, folderMeta);
    track?.onDir?.(parentId, node.name, dir.id, path);
    for (const child of node.children) {
      await writeMetaNode(fs, dir.id, child, read, track, path);
    }
    return;
  }
  const file: ExpandTrackFile = {
    name: node.name,
    path,
    bytesTotal: node.member.dataUlen + node.member.rsrcUlen,
    finderInfo: makeFinderInfo(node.member.fileType, node.member.creator, node.member.finderFlags),
  };
  track?.onExpand?.(file);
  log.trace(`expand extract “${path}” packed=${node.member.rsrcClen + node.member.dataClen}b`, 'expand');
  const entry = await extractSitMember(read, { ...node.member, name: node.name });
  log.trace(
    `expand write “${path}” data=${entry.data.length}b rsrc=${entry.resource.length}b`,
    'expand',
  );
  const expanded = expandedFromSitEntries([{ ...entry, name: node.name }]);
  await importExpandedTree(fs, parentId, expanded, track, { announce: false, prefix });
}

function folderExpanded(node: MetaDir): ExpandedDir | null {
  const m = node.member;
  if (!m) return null;
  return {
    kind: 'dir',
    name: node.name,
    children: [],
    finderInfo: makeFinderInfo(m.fileType, m.creator, m.finderFlags),
    createDate: m.createDate || undefined,
    modDate: m.modDate || undefined,
  };
}

async function stampDir(fs: Pick<Catalog, 'put'>, dir: VNode, meta: ExpandedDir): Promise<void> {
  let dirty = false;
  if (meta.finderInfo && meta.finderInfo.some((b) => b !== 0)) {
    dir.finderInfo = meta.finderInfo;
    dirty = true;
  }
  if (meta.createDate) {
    dir.createDate = hfsTimeToAfp(meta.createDate);
    dirty = true;
  }
  if (meta.modDate) {
    dir.modDate = hfsTimeToAfp(meta.modDate);
    dirty = true;
  }
  if (dirty) await fs.put(dir);
}
