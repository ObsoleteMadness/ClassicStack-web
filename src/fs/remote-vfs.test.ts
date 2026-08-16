import { describe, expect, it } from 'vitest';
import { RemoteVfs } from './remote-vfs';
import type { AfpClient } from '../services/afp-client/client';
import type { DirEntry } from '../services/afp-client/commands';

function entry(name: string, cnid: number): DirEntry {
  return {
    isDir: false,
    name,
    cnid,
    parentId: 2,
    dataLen: 0,
    rsrcLen: 0,
    createDate: 0,
    modDate: 0,
    finderInfo: new Uint8Array(32),
  };
}

function clientWithPages(pages: DirEntry[][]): AfpClient {
  return {
    async list(_dirId: number, _path: string, _volId?: number, onBatch?: (batch: DirEntry[]) => void | Promise<void>) {
      const all: DirEntry[] = [];
      for (const page of pages) {
        all.push(...page);
        await onBatch?.(page);
      }
      return all;
    },
  } as unknown as AfpClient;
}

describe('RemoteVfs.children', () => {
  it('adopts and reports nodes after each enumerate page', async () => {
    const vfs = new RemoteVfs(
      clientWithPages([[entry('One', 10), entry('Two', 11)], [entry('Three', 12)]]),
      'Vol',
      1,
    );
    const snapshots: string[][] = [];
    const kids = await vfs.children(2, (soFar) => {
      snapshots.push(soFar.map((n) => n.name));
    });
    expect(snapshots).toEqual([['One', 'Two'], ['One', 'Two', 'Three']]);
    expect(kids.map((n) => n.name)).toEqual(['One', 'Two', 'Three']);
    expect(await vfs.get(12)).toMatchObject({ name: 'Three', parentId: 2 });
  });

  it('still lists when the client returns everything without onBatch', async () => {
    const vfs = new RemoteVfs(
      {
        async list() {
          return [entry('Solo', 9)];
        },
      } as unknown as AfpClient,
      'Vol',
      1,
    );
    const snaps: number[] = [];
    const kids = await vfs.children(2, (soFar) => {
      snaps.push(soFar.length);
    });
    expect(kids).toHaveLength(1);
    expect(kids[0]!.name).toBe('Solo');
    expect(snaps).toEqual([1]);
  });
});
