/** Enumerate a Finder catalog tree, then stream files into an AppleDouble zip. */

import { buildAppleDouble, zipSidecarPath, type ZipExportStyle } from './appledouble';
import { refKey, type NodeRef } from './catalog-caps';
import { throwIfAborted } from '../util/abort';
import { nodeRef, type Catalog, type VNode } from './virtual-fs';

/** One catalog file to fetch when building the zip. Directories are not members. */
export type ZipFilePlan = {
  node: VNode;
  /** Data-fork path inside the zip (`Docs/Read Me`). */
  path: string;
  bytes: number;
};

export type ZipSearchProgress = {
  items: number;
  bytes: number;
};

/** On-disk size from a listing row (no fork download). */
export function zipListingBytes(node: VNode): number {
  if (node.isDir) return 0;
  return (node.dataBytes ?? node.data.length) + (node.resourceBytes ?? node.resource.length);
}

/**
 * Walk directories (and paged listings) to count items and bytes before any
 * fork download. `onProgress` fires as each file or folder is found.
 */
export async function enumerateZipFiles(
  vfs: Catalog,
  node: VNode,
  prefix = '',
  onProgress?: (p: ZipSearchProgress) => void,
  signal?: AbortSignal,
): Promise<{ files: ZipFilePlan[]; items: number; bytes: number }> {
  const files: ZipFilePlan[] = [];
  let items = 0;
  let bytes = 0;

  const note = (): void => {
    onProgress?.({ items, bytes });
  };

  const walk = async (n: VNode, pre: string): Promise<void> => {
    throwIfAborted(signal);
    items++;
    if (!n.isDir) {
      const size = zipListingBytes(n);
      bytes += size;
      files.push({ node: n, path: pre ? `${pre}${n.name}` : n.name, bytes: size });
      note();
      return;
    }
    note();
    const dirPrefix = pre ? `${pre}${n.name}/` : `${n.name}/`;
    const seen = new Set<string>();
    const consider = async (kid: VNode): Promise<void> => {
      const key = childKey(kid);
      if (seen.has(key)) return;
      seen.add(key);
      await walk(kid, dirPrefix);
    };
    const kids = await vfs.children(
      nodeRef(n),
      async (batch) => {
        for (const kid of batch) await consider(kid);
      },
      signal,
    );
    for (const kid of kids) await consider(kid);
  };

  await walk(node, prefix);
  return { files, items, bytes };
}

function childKey(node: VNode): string {
  const ref: NodeRef = nodeRef(node);
  return refKey(ref);
}

/** Download planned files and emit AppleDouble pairs for zipStore. */
export async function collectZipEntries(
  vfs: Catalog,
  files: ZipFilePlan[],
  style: ZipExportStyle = 'appledouble',
  onBytes?: (n: number) => void,
  signal?: AbortSignal,
): Promise<{ name: string; data: Uint8Array }[]> {
  const out: { name: string; data: Uint8Array }[] = [];
  const creditRead = vfs.reportsChunkedBytes ? onBytes : undefined;
  const creditLoaded = !vfs.reportsChunkedBytes ? onBytes : undefined;
  for (const f of files) {
    throwIfAborted(signal);
    const full = (await vfs.ensureContent(nodeRef(f.node), creditRead, signal)) ?? f.node;
    creditLoaded?.(full.data.length + full.resource.length);
    out.push({ name: f.path, data: full.data });
    out.push({
      name: zipSidecarPath(f.path, style),
      data: buildAppleDouble(full.finderInfo, full.resource),
    });
  }
  return out;
}
