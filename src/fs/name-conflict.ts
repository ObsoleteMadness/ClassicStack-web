/** Name clashes when copying, moving, or importing into a folder. */

import { isAbortError } from '../util/abort';
import type { NodeRef } from './catalog-caps';
import { nodeRef, type VNode } from './virtual-fs';

export type NameConflictChoice = 'replace' | 'rename' | 'cancel';

export class TransferCancelled extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'TransferCancelled';
  }
}

export function isTransferCancelled(err: unknown): boolean {
  return (
    err instanceof TransferCancelled ||
    (err instanceof Error && err.name === 'TransferCancelled') ||
    isAbortError(err)
  );
}

export function splitItemName(name: string): { stem: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return { stem: name, ext: '' };
  const ext = name.slice(i);
  if (ext.length > 8 || /\s/.test(ext.slice(1))) return { stem: name, ext: '' };
  return { stem: name.slice(0, i), ext };
}

export function copyItemName(base: string): string {
  const { stem, ext } = splitItemName(base);
  return `${stem} - Copy${ext}`;
}

type LookupFs = {
  lookup(parent: NodeRef, name: string): Promise<VNode | undefined>;
};

export async function uniqueCopyName(
  fs: LookupFs,
  parentId: NodeRef,
  base: string,
  reserved: Set<string> = new Set(),
): Promise<string> {
  const taken = async (name: string): Promise<boolean> =>
    reserved.has(name.toLowerCase()) || !!(await fs.lookup(parentId, name));
  const first = copyItemName(base);
  if (!(await taken(first))) return first;
  const { stem, ext } = splitItemName(base);
  const prefix = `${stem} - Copy`;
  let n = 2;
  for (;;) {
    const name = `${prefix} ${n}${ext}`;
    if (!(await taken(name))) return name;
    n++;
  }
}

export type PlacementPlan = { destName: string; replaceId: NodeRef | null };

export async function planItemPlacement(
  fs: LookupFs,
  parentId: NodeRef,
  name: string,
  isDir: boolean,
  opts: {
    ignoreId?: NodeRef;
    reserved?: Set<string>;
    resolveConflict: (info: {
      name: string;
      isDir: boolean;
      suggestedName: string;
    }) => Promise<NameConflictChoice>;
  },
): Promise<PlacementPlan | null> {
  const reserved = opts.reserved ?? new Set();
  const existing = await fs.lookup(parentId, name);
  if (!existing || nodeRef(existing) === opts.ignoreId) {
    return { destName: name, replaceId: null };
  }
  const suggestedName = await uniqueCopyName(fs, parentId, name, reserved);
  const choice = await opts.resolveConflict({ name, isDir, suggestedName });
  if (choice === 'cancel') return null;
  if (choice === 'replace') return { destName: name, replaceId: nodeRef(existing) };
  return { destName: suggestedName, replaceId: null };
}
