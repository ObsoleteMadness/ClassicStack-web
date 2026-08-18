/** In-browser copy/move/expand between Finder catalogs (AFP PWA). */

import type { Catalog, VNode } from '../fs/virtual-fs';
import { RemoteVfs } from '../fs/remote-vfs';
import { expandArchiveFile } from '../fs/expand-incoming';
import { expandSitInPlace } from '../fs/expand-inplace';
import { importExpandedTree } from '../fs/import-transfer';
import { throwIfAborted } from '../util/abort';
import type { CrossTransferRequest, OpProgress } from './types';

type CopyCtx = {
  destName: string;
  destParentId: number;
  bytesDone: number;
  bytesTotal?: number;
  signal?: AbortSignal;
};

function sameAfpClient(a: Catalog, b: Catalog): boolean {
  return a instanceof RemoteVfs && b instanceof RemoteVfs && a.client === b.client;
}

function nodeBytes(node: VNode): number {
  if (node.isDir) return 0;
  return (node.dataBytes ?? node.data.length) + (node.resourceBytes ?? node.resource.length);
}

async function* copyNode(
  src: Catalog,
  dest: Catalog,
  node: VNode,
  destParent: number,
  destName: string,
  ctx: CopyCtx,
): AsyncGenerator<OpProgress> {
  throwIfAborted(ctx.signal);
  yield {
    phase: 'copying',
    path: destName,
    destName: ctx.destName,
    destParentId: ctx.destParentId,
    bytesDone: ctx.bytesDone,
    bytesTotal: ctx.bytesTotal,
  };
  if (node.isDir) {
    const dir = await dest.mkdir(destParent, destName);
    for (const child of await src.children(node.id, undefined, ctx.signal)) {
      yield* copyNode(src, dest, child, dir.id, child.name, ctx);
    }
    return;
  }
  if (sameAfpClient(src, dest) && src instanceof RemoteVfs && dest instanceof RemoteVfs) {
    await src.client.copyFile(node.parentId, node.name, dest.volId, destParent, destName, src.volId);
    ctx.bytesDone += nodeBytes(node);
    yield {
      phase: 'copying',
      path: destName,
      destName: ctx.destName,
      bytesDone: ctx.bytesDone,
      bytesTotal: ctx.bytesTotal,
    };
    return;
  }
  const creditRead = !!src.reportsChunkedBytes && !dest.reportsChunkedBytes;
  const creditWrite = !!dest.reportsChunkedBytes || !creditRead;
  const onRead = creditRead
    ? (n: number) => {
        ctx.bytesDone += n;
      }
    : undefined;
  const onWrite = creditWrite
    ? (n: number) => {
        ctx.bytesDone += n;
      }
    : undefined;
  const full = (await src.ensureContent(node.id, onRead, ctx.signal)) ?? node;
  throwIfAborted(ctx.signal);
  await dest.createFile(
    destParent,
    destName,
    full.data,
    full.resource,
    full.finderInfo,
    onWrite,
    ctx.signal,
  );
  yield {
    phase: 'copying',
    path: destName,
    destName: ctx.destName,
    destParentId: ctx.destParentId,
    bytesDone: ctx.bytesDone,
    bytesTotal: ctx.bytesTotal,
  };
}

/** Copy a node between catalogs, yielding OpProgress. Same-server AFP files use FPCopyFile. */
export async function* copyBetweenCatalogs(
  src: Catalog,
  dest: Catalog,
  req: CrossTransferRequest,
  signal?: AbortSignal,
): AsyncGenerator<OpProgress> {
  const node = await src.get(req.srcId);
  if (!node) {
    yield { error: 'not found', done: true };
    return;
  }
  if (req.replace) {
    const existing = await dest.lookup(req.destParentId, req.destName);
    if (existing) await dest.remove(existing.id);
  }
  const ctx: CopyCtx = {
    destName: req.destName,
    destParentId: req.destParentId,
    bytesDone: 0,
    bytesTotal: node.isDir ? undefined : nodeBytes(node),
    signal,
  };
  dest.beginBatch();
  try {
    yield* copyNode(src, dest, node, req.destParentId, req.destName, ctx);
    yield {
      phase: 'copying',
      destName: req.destName,
      destParentId: req.destParentId,
      bytesDone: ctx.bytesDone,
      bytesTotal: ctx.bytesTotal,
    };
  } finally {
    dest.endBatch();
  }
}

/** Move across catalogs: same AFP volume uses FPMoveAndRename; otherwise copy then delete. */
export async function* moveBetweenCatalogs(
  src: Catalog,
  dest: Catalog,
  req: CrossTransferRequest,
  signal?: AbortSignal,
): AsyncGenerator<OpProgress> {
  const node = await src.get(req.srcId);
  if (!node) {
    yield { error: 'not found', done: true };
    return;
  }
  if (src === dest || (src instanceof RemoteVfs && dest instanceof RemoteVfs && src.client === dest.client && src.volId === dest.volId)) {
    if (req.replace) {
      const existing = await dest.lookup(req.destParentId, req.destName);
      if (existing && existing.id !== req.srcId) await dest.remove(existing.id);
    }
    if (req.destName && req.destName !== node.name) await src.rename(req.srcId, req.destName);
    await src.move(req.srcId, req.destParentId);
    yield { phase: 'moving', destName: req.destName };
    return;
  }
  yield* copyBetweenCatalogs(src, dest, req, signal);
  await src.remove(req.srcId);
  yield { phase: 'moving', destName: req.destName };
}

/** Expand an archive next to itself on a catalog (StuffIt in-place, else load + expand). */
export async function* expandOnCatalog(
  cat: Catalog,
  id: number,
  signal?: AbortSignal,
): AsyncGenerator<OpProgress> {
  const node = await cat.get(id);
  if (!node || node.isDir) {
    yield { error: 'not an archive', done: true };
    return;
  }
  let bytesDone = 0;
  const bytesTotal = nodeBytes(node);
  yield { phase: 'expanding', path: node.name, bytesTotal };
  const track = {
    signal,
    onBytes: (n: number) => {
      bytesDone += n;
    },
  };
  cat.beginBatch();
  try {
    const inPlace = await expandSitInPlace(cat, node, {
      fileSize: node.dataBytes ?? node.data.length,
      track,
      resolveConflict: async () => 'rename',
    });
    if (!inPlace) {
      const full = (await cat.ensureContent(id, track.onBytes, signal)) ?? node;
      throwIfAborted(signal);
      const tree = expandArchiveFile(full.name, full.data);
      await importExpandedTree(cat, node.parentId, tree, track);
    }
    yield { phase: 'expanding', path: node.name, bytesDone, bytesTotal, done: true };
  } finally {
    cat.endBatch();
  }
}
