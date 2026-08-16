import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { be16 } from '../protocol/binary';
import { fromMacTime, hfsTimeToAfp } from '../protocol/afp/constants';
import { expandIncoming } from './expand-incoming';
import {
  importDataTransferInto,
  importExpandedTree,
  namedResourceForkPath,
  readNamedResourceFork,
  shouldProbeNamedResourceFork,
} from './import-transfer';
import { makeFinderInfo } from './mac-file';
import { iconCache } from './icon-cache';
import type { Catalog, VNode } from './virtual-fs';

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function mockCatalog() {
  let nextId = 10;
  const nodes = new Map<number, VNode>();
  const created: VNode[] = [];
  const fs: Pick<Catalog, 'ensureDir' | 'createFile' | 'put'> = {
    async ensureDir(parentId, name) {
      const node: VNode = {
        id: nextId++,
        parentId,
        name,
        isDir: true,
        data: new Uint8Array(),
        resource: new Uint8Array(),
        finderInfo: new Uint8Array(32),
        createDate: 1,
        modDate: 1,
      };
      nodes.set(node.id, node);
      return node;
    },
    async createFile(parentId, name, data, resource = new Uint8Array(), finderInfo = new Uint8Array(32)) {
      const node: VNode = {
        id: nextId++,
        parentId,
        name,
        isDir: false,
        data,
        resource,
        finderInfo,
        createDate: 1,
        modDate: 1,
      };
      nodes.set(node.id, node);
      created.push(node);
      return node;
    },
    async put(node) {
      nodes.set(node.id, { ...node });
    },
  };
  return { fs, nodes, created };
}

describe('importExpandedTree', () => {
  it('writes data fork, resource fork, Finder info, and Mac dates via createFile', async () => {
    const { fs, nodes, created } = mockCatalog();
    const finderInfo = makeFinderInfo('APPL', 'CARO', 0x0400);
    await importExpandedTree(fs, 2, [
      {
        kind: 'file',
        name: 'App',
        data: Uint8Array.of(1, 2, 3),
        resource: Uint8Array.of(0xca, 0xfe),
        finderInfo,
        createDate: 0xb3d2a000,
        modDate: 0xb3d2b000,
      },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe('App');
    expect([...created[0]!.data]).toEqual([1, 2, 3]);
    expect([...created[0]!.resource]).toEqual([0xca, 0xfe]);
    expect(String.fromCharCode(...created[0]!.finderInfo.subarray(0, 8))).toBe('APPLCARO');
    const stamped = nodes.get(created[0]!.id)!;
    expect(stamped.createDate).toBe(hfsTimeToAfp(0xb3d2a000));
    expect(stamped.modDate).toBe(hfsTimeToAfp(0xb3d2b000));
    expect(fromMacTime(stamped.createDate).getUTCFullYear()).toBe(1999);
    expect(fromMacTime(stamped.modDate).getUTCFullYear()).toBe(1999);
  });

  it('caches icons from the extracted resource fork', async () => {
    const { fs } = mockCatalog();
    const spy = vi.spyOn(iconCache, 'ingestExtracted').mockResolvedValue();
    const finderInfo = makeFinderInfo('APPL', 'CARO', 0x0400);
    await importExpandedTree(fs, 2, [
      {
        kind: 'file',
        name: 'App',
        data: Uint8Array.of(1, 2, 3),
        resource: Uint8Array.of(0xca, 0xfe),
        finderInfo,
      },
    ]);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'App',
        resource: expect.any(Uint8Array),
        finderInfo,
      }),
    );
    spy.mockRestore();
  });

  it('applies folder Finder flags after ensureDir', async () => {
    const { fs, nodes } = mockCatalog();
    const folderInfo = makeFinderInfo('    ', '    ', 0x0400);
    await importExpandedTree(fs, 2, [
      {
        kind: 'dir',
        name: 'Disk',
        finderInfo: folderInfo,
        createDate: 0xb3d2a000,
        children: [
          {
            kind: 'file',
            name: 'Notes',
            data: ascii('hi'),
            resource: new Uint8Array(),
            finderInfo: makeFinderInfo('TEXT', 'ttxt'),
          },
        ],
      },
    ]);
    const disk = [...nodes.values()].find((n) => n.isDir && n.name === 'Disk');
    expect(disk).toBeDefined();
    expect(be16(disk!.finderInfo, 8)).toBe(0x0400);
    expect(disk!.createDate).toBe(hfsTimeToAfp(0xb3d2a000));
    expect(fromMacTime(disk!.createDate).getUTCFullYear()).toBe(1999);
    const notes = [...nodes.values()].find((n) => n.name === 'Notes');
    expect(notes?.parentId).toBe(disk!.id);
  });

  it('converts StuffIt HFS dates so Finder shows the archive year, not the 1950s', async () => {
    const packed = new Uint8Array(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'testdata/stuffit45.sit')),
    );
    const expanded = expandIncoming('Archive.sit', packed);
    expect(expanded?.length).toBeGreaterThan(0);
    const { fs, nodes } = mockCatalog();
    await importExpandedTree(fs, 2, expanded!);
    const image = [...nodes.values()].find((n) => n.name === 'Test Image');
    expect(image).toBeDefined();
    expect(fromMacTime(image!.createDate).getUTCFullYear()).toBe(2023);
    expect(fromMacTime(image!.modDate).getUTCFullYear()).toBe(2023);
  });

  it('resets parent progress to extracted size and credits parent as files are written', async () => {
    const { fs } = mockCatalog();
    const parentBytes: number[] = [];
    let parentTotal = -1;
    const childBytes: number[] = [];
    await importExpandedTree(
      fs,
      2,
      [
        {
          kind: 'file',
          name: 'A',
          data: Uint8Array.of(1, 2, 3, 4),
          resource: new Uint8Array(),
          finderInfo: makeFinderInfo('TEXT', 'ttxt'),
        },
        {
          kind: 'dir',
          name: 'Folder',
          children: [
            {
              kind: 'file',
              name: 'B',
              data: Uint8Array.of(5, 6),
              resource: Uint8Array.of(7, 8, 9),
              finderInfo: makeFinderInfo('TEXT', 'ttxt'),
            },
          ],
        },
      ],
      {
        onBytes: (n) => parentBytes.push(n),
        onExpandBegin: (total) => {
          parentTotal = total;
        },
        onExpand: () => ({
          onBytes: (n) => childBytes.push(n),
        }),
      },
    );
    expect(parentTotal).toBe(9);
    expect(parentBytes.reduce((a, b) => a + b, 0)).toBe(9);
    expect(childBytes.reduce((a, b) => a + b, 0)).toBe(9);
  });

  it('announces every extracted file before writes start', async () => {
    const { fs } = mockCatalog();
    let queued: { name: string; path: string; bytesTotal: number }[] = [];
    const started: string[] = [];
    await importExpandedTree(
      fs,
      2,
      [
        {
          kind: 'file',
          name: 'A',
          data: Uint8Array.of(1, 2, 3, 4),
          resource: new Uint8Array(),
          finderInfo: makeFinderInfo('TEXT', 'ttxt'),
        },
        {
          kind: 'dir',
          name: 'Folder',
          children: [
            {
              kind: 'file',
              name: 'B',
              data: Uint8Array.of(5, 6),
              resource: Uint8Array.of(7, 8, 9),
              finderInfo: makeFinderInfo('TEXT', 'ttxt'),
            },
          ],
        },
      ],
      {
        onExpandBegin: (_total, files) => {
          queued = files.map((f) => ({ name: f.name, path: f.path, bytesTotal: f.bytesTotal }));
        },
        onExpand: (item) => {
          started.push(item.path);
          return {};
        },
      },
    );
    expect(queued).toEqual([
      { name: 'A', path: 'A', bytesTotal: 4 },
      { name: 'B', path: 'Folder/B', bytesTotal: 5 },
    ]);
    expect(started).toEqual(['A', 'Folder/B']);
  });

  it('skips an extracted file whose nested job was cancelled', async () => {
    const { fs, created } = mockCatalog();
    const ac = new AbortController();
    ac.abort();
    await importExpandedTree(
      fs,
      2,
      [
        {
          kind: 'file',
          name: 'Keep',
          data: Uint8Array.of(1),
          resource: new Uint8Array(),
          finderInfo: makeFinderInfo('TEXT', 'ttxt'),
        },
        {
          kind: 'file',
          name: 'Skip',
          data: Uint8Array.of(2),
          resource: new Uint8Array(),
          finderInfo: makeFinderInfo('TEXT', 'ttxt'),
        },
      ],
      {
        onExpand: (item) => (item.name === 'Skip' ? { signal: ac.signal } : {}),
      },
    );
    expect(created.map((n) => n.name)).toEqual(['Keep']);
  });

  it('deletes a partial dest file when an extracted write is aborted', async () => {
    const { fs, created } = mockCatalog();
    const removed: string[] = [];
    const ac = new AbortController();
    const origCreate = fs.createFile.bind(fs);
    fs.createFile = async (parentId, name, data, resource, finderInfo, onBytes, signal) => {
      const node = await origCreate(parentId, name, data, resource, finderInfo, onBytes, signal);
      ac.abort();
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    };
    await expect(
      importExpandedTree(
        fs,
        2,
        [
          {
            kind: 'file',
            name: 'ReadMe',
            data: Uint8Array.of(1, 2, 3),
            resource: new Uint8Array(),
            finderInfo: makeFinderInfo('TEXT', 'ttxt'),
          },
        ],
        {
          signal: ac.signal,
          removePartial: async (_parentId, name) => {
            removed.push(name);
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(created.map((n) => n.name)).toEqual(['ReadMe']);
    expect(removed).toEqual(['ReadMe']);
  });
});

describe('hfsTimeToAfp', () => {
  it('maps seconds-since-1904 onto AFP seconds-since-2000', () => {
    expect(hfsTimeToAfp(0)).toBe(0);
    expect(fromMacTime(hfsTimeToAfp(0xb3d2a000)).toISOString().slice(0, 10)).toBe('1999-08-08');
  });
});

describe('named resource fork', () => {
  it('builds the Chrome/macOS parallel path', () => {
    expect(namedResourceForkPath('SimpleText')).toBe('SimpleText/..namedfork/rsrc');
  });

  it('skips AppleDouble sidecars and named-fork directories', () => {
    expect(shouldProbeNamedResourceFork('SimpleText')).toBe(true);
    expect(shouldProbeNamedResourceFork('._SimpleText')).toBe(false);
    expect(shouldProbeNamedResourceFork('..namedfork')).toBe(false);
    expect(shouldProbeNamedResourceFork('')).toBe(false);
  });

  it('reads a non-empty named fork and ignores missing or empty ones', async () => {
    const rsrc = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe);
    const dir = mockDirectoryEntry({
      SimpleText: rsrc,
      Empty: new Uint8Array(),
    });
    expect([...(await readNamedResourceFork(dir, 'SimpleText'))!]).toEqual([...rsrc]);
    expect(await readNamedResourceFork(dir, 'Empty')).toBeNull();
    expect(await readNamedResourceFork(dir, 'Missing')).toBeNull();
    expect(await readNamedResourceFork(dir, '._SimpleText')).toBeNull();
  });

  it('imports a folder drop with the host resource fork attached to the data file', async () => {
    const rsrc = Uint8Array.of(0x00, 0x00, 0x01, 0x00);
    const folder = mockDirectoryEntry(
      { SimpleText: rsrc },
      [
        mockFileEntry('SimpleText', ascii('hello')),
        mockFileEntry('Notes.txt', ascii('hi')),
      ],
      'Apps',
    );
    const imported: { name: string; resource?: Uint8Array }[] = [];
    await importDataTransferInto(
      mockImportFs(),
      2,
      mockDataTransfer([folder]),
      async (_parent, file, _onBytes, resource) => {
        imported.push({ name: file.name, resource });
      },
    );
    const app = imported.find((f) => f.name === 'SimpleText');
    const notes = imported.find((f) => f.name === 'Notes.txt');
    expect(app).toBeDefined();
    expect([...(app!.resource ?? [])]).toEqual([...rsrc]);
    expect(notes?.resource).toBeUndefined();
  });
});

function mockFileEntry(name: string, data: Uint8Array): FileSystemFileEntry {
  const file = new File([data], name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    filesystem: null as unknown as FileSystem,
    file(ok: (f: File) => void) {
      ok(file);
    },
    getParent(_ok: (p: FileSystemDirectoryEntry) => void, err?: (e: DOMException) => void) {
      err?.(new DOMException('no parent'));
    },
  } as FileSystemFileEntry;
}

function mockDirectoryEntry(
  namedForks: Record<string, Uint8Array>,
  children: FileSystemEntry[] = [],
  name = 'Folder',
): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    filesystem: null as unknown as FileSystem,
    createReader() {
      let sent = false;
      return {
        readEntries(ok: (batch: FileSystemEntry[]) => void) {
          if (sent) {
            ok([]);
            return;
          }
          sent = true;
          ok(children);
        },
      };
    },
    getFile(
      path: string,
      _opts: FileSystemFlags | undefined,
      ok: (entry: FileSystemFileEntry) => void,
      err?: (e: DOMException) => void,
    ) {
      const suffix = '/..namedfork/rsrc';
      if (!path.endsWith(suffix)) {
        err?.(new DOMException('not found'));
        return;
      }
      const fileName = path.slice(0, -suffix.length);
      const data = namedForks[fileName];
      if (data == null) {
        err?.(new DOMException('not found'));
        return;
      }
      ok(mockFileEntry(fileName, data));
    },
    getDirectory() {
      throw new Error('unused');
    },
    getParent(_ok: (p: FileSystemDirectoryEntry) => void, err?: (e: DOMException) => void) {
      err?.(new DOMException('no parent'));
    },
  } as FileSystemDirectoryEntry;
}

function mockDataTransfer(entries: FileSystemEntry[]): DataTransfer {
  const items = entries.map((entry) => ({
    kind: 'file',
    webkitGetAsEntry: () => entry,
  }));
  return {
    items: Object.assign(items, { length: items.length }),
    files: [] as unknown as FileList,
  } as unknown as DataTransfer;
}

function mockImportFs() {
  let nextId = 10;
  return {
    beginBatch() {},
    endBatch() {},
    async lookup() {
      return undefined;
    },
    async remove() {},
    async put() {},
    async createFile() {
      throw new Error('unused');
    },
    async ensureDir(_parentId: number, name: string) {
      return {
        id: nextId++,
        parentId: 2,
        name,
        isDir: true,
        data: new Uint8Array(),
        resource: new Uint8Array(),
        finderInfo: new Uint8Array(32),
        createDate: 1,
        modDate: 1,
      };
    },
  };
}
