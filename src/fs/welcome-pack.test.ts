import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppleSingle } from './appledouble';
import { decodeMacRoman } from '../protocol/macroman';
import { expandIncoming } from './expand-incoming';
import { buildClassicStore } from './stuffit';
import type { VNode } from './virtual-fs';
import {
  addWelcomePack,
  importWelcomePack,
  isWelcomePackSourceFile,
  materializeWelcomeFile,
  parseWelcomeManifest,
  seedWelcomePackIfNeeded,
  welcomePackFileUrl,
  welcomePackStamp,
  WELCOME_PACK_META_KEY,
  type WelcomePackStore,
} from './welcome-pack';

function textFile(path: string, body: string) {
  return { path, data: new TextEncoder().encode(body) };
}

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function mockStore(): WelcomePackStore & {
  files: Map<string, { id: number; isDir: boolean; name: string }>;
  blobs: { parentId: number; name: string }[];
  created: VNode[];
  meta: Map<string, unknown>;
  names(): string[];
} {
  const files = new Map<string, { id: number; isDir: boolean; name: string }>();
  const byId = new Map<number, { parentId: number; name: string }>();
  let nextId = 10;
  const key = (parentId: number, name: string) => `${parentId}\0${name.toLowerCase()}`;
  const store: WelcomePackStore & {
    files: Map<string, { id: number; isDir: boolean; name: string }>;
    blobs: { parentId: number; name: string }[];
    created: VNode[];
    meta: Map<string, unknown>;
    names(): string[];
  } = {
    files,
    blobs: [],
    created: [],
    meta: new Map(),
    names() {
      return [...files.values()].filter((n) => !n.isDir).map((n) => n.name);
    },
    rootId: () => 2,
    beginBatch() {},
    endBatch() {},
    async lookup(parentId, name) {
      return files.get(key(parentId, name));
    },
    async ensureDir(parentId, name) {
      const k = key(parentId, name);
      const existing = files.get(k);
      if (existing?.isDir) return existing;
      const node = { id: nextId++, isDir: true, name };
      files.set(k, node);
      byId.set(node.id, { parentId, name });
      return node;
    },
    async importBlob(parentId, file) {
      const node = { id: nextId++, isDir: false as const, name: file.name };
      files.set(key(parentId, file.name), node);
      byId.set(node.id, { parentId, name: file.name });
      this.blobs.push({ parentId, name: file.name });
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
      files.set(key(parentId, name), { id: node.id, isDir: false, name });
      byId.set(node.id, { parentId, name });
      this.created.push(node);
      return node;
    },
    async put(node) {
      files.set(key(node.parentId, node.name), { id: node.id, isDir: node.isDir, name: node.name });
      byId.set(node.id, { parentId: node.parentId, name: node.name });
    },
    async remove(id) {
      const loc = byId.get(id);
      if (!loc) return;
      files.delete(key(loc.parentId, loc.name));
      byId.delete(id);
    },
    async getMeta(k) {
      return this.meta.get(k);
    },
    async setMeta(k, value) {
      this.meta.set(k, value);
    },
  };
  return store;
}

describe('welcome pack source filter', () => {
  it('keeps Mac files and AppleDouble sidecars', () => {
    expect(isWelcomePackSourceFile('Read Me.txt')).toBe(true);
    expect(isWelcomePackSourceFile('Utilities/Disk Copy')).toBe(true);
    expect(isWelcomePackSourceFile('Utilities/._Disk Copy')).toBe(true);
  });

  it('skips developer docs and junk', () => {
    expect(isWelcomePackSourceFile('README.md')).toBe(false);
    expect(isWelcomePackSourceFile('Utilities/README.md')).toBe(false);
    expect(isWelcomePackSourceFile('LICENSE')).toBe(false);
    expect(isWelcomePackSourceFile('LICENSE-netboot.txt')).toBe(false);
    expect(isWelcomePackSourceFile('manifest.json')).toBe(false);
    expect(isWelcomePackSourceFile('.DS_Store')).toBe(false);
    expect(isWelcomePackSourceFile('.gitkeep')).toBe(false);
  });
});

describe('welcome pack manifest', () => {
  it('parses paths and drops traversal / skipped names', () => {
    expect(
      parseWelcomeManifest({
        files: [
          { path: 'Read Me.txt' },
          { path: 'README.md' },
          { path: '../secret' },
          { path: 'foo/../bar' },
          { path: 'Utilities\\Notes.txt' },
        ],
      }),
    ).toEqual(['Read Me.txt', 'Utilities/Notes.txt']);
  });

  it('builds fetch URLs with encoded segments', () => {
    expect(welcomePackFileUrl('Read Me.txt')).toBe('/welcome/Read%20Me.txt');
    expect(welcomePackFileUrl('Utilities/Network Notes.txt')).toBe(
      '/welcome/Utilities/Network%20Notes.txt',
    );
  });
});

describe('materializeWelcomeFile', () => {
  it('wraps plain text as AppleSingle TEXT/ttxt without the .txt suffix', () => {
    const out = materializeWelcomeFile('Read Me.txt', new TextEncoder().encode('Hello\nworld\n'));
    expect(out.name).toBe('Read Me');
    expect(out.dirs).toEqual([]);
    const as = parseAppleSingle(out.data);
    expect(as).not.toBeNull();
    expect(decodeMacRoman(as!.data)).toBe('Hello\rworld\r');
    expect(String.fromCharCode(...as!.finderInfo.subarray(0, 4))).toBe('TEXT');
    expect(String.fromCharCode(...as!.finderInfo.subarray(4, 8))).toBe('ttxt');
  });

  it('preserves nested folders and host-escaped names', () => {
    const out = materializeWelcomeFile('Utilities/Icon0x0D', new Uint8Array([1, 2, 3]));
    expect(out.dirs).toEqual(['Utilities']);
    expect(out.name).toBe('Icon\r');
    expect([...out.data]).toEqual([1, 2, 3]);
  });
});

describe('importWelcomePack', () => {
  it('creates folders and skips names that already exist', async () => {
    const fs = mockStore();
    const utilities = await fs.ensureDir(2, 'Utilities');
    await fs.importBlob(utilities.id, new File([new Uint8Array([9])], 'Network Notes'));

    const result = await importWelcomePack(fs, [
      textFile('Read Me.txt', 'hi'),
      textFile('Utilities/Network Notes.txt', 'already there'),
      textFile('Utilities/Disk Copy.sit', 'sit'),
    ]);

    expect(result).toEqual({ imported: 2, skipped: 1 });
    expect(fs.blobs.map((b) => b.name)).toEqual(['Network Notes', 'Read Me', 'Disk Copy.sit']);
  });

  it('imports each item in its own batch so the Finder can paint between them', async () => {
    const fs = mockStore();
    let depth = 0;
    let maxDepth = 0;
    let batches = 0;
    fs.beginBatch = () => {
      depth++;
      batches++;
      maxDepth = Math.max(maxDepth, depth);
    };
    fs.endBatch = () => {
      depth--;
    };
    const names: string[] = [];
    await importWelcomePack(
      fs,
      [textFile('Read Me.txt', 'a'), textFile('Utilities/Notes.txt', 'b')],
      { onItem: (item) => {
        names.push(item.name);
        return undefined;
      } },
    );
    expect(batches).toBe(2);
    expect(maxDepth).toBe(1);
    expect(names).toEqual(['Read Me', 'Notes']);
  });

  it('skips an AppleDouble sidecar when the logical file already exists', async () => {
    const fs = mockStore();
    await fs.importBlob(2, new File([new Uint8Array([1])], 'Disk Copy'));
    const result = await importWelcomePack(fs, [
      { path: '._Disk Copy', data: new Uint8Array([2, 3]) },
    ]);
    expect(result).toEqual({ imported: 0, skipped: 1 });
  });

  it('expands archives into inner items and does not keep the wrapper', async () => {
    const fs = mockStore();
    const packed = buildClassicStore([
      { name: 'Notes', data: ascii('hi') },
      { name: 'App', data: Uint8Array.of(1, 2, 3), type: 'APPL', creator: 'CARO' },
    ]);
    const result = await importWelcomePack(fs, [{ path: 'Utilities/Disk Copy.sit', data: packed }]);
    expect(result).toEqual({ imported: 2, skipped: 0 });
    expect(fs.names()).toEqual(['Notes', 'App']);
    expect(fs.blobs).toEqual([]);
  });

  it('removes a previously imported archive after expanding', async () => {
    const fs = mockStore();
    const utilities = await fs.ensureDir(2, 'Utilities');
    await fs.importBlob(utilities.id, new File([new Uint8Array([9])], 'Disk Copy.sit'));
    const packed = buildClassicStore([{ name: 'Disk Copy', data: ascii('app') }]);
    const result = await importWelcomePack(fs, [{ path: 'Utilities/Disk Copy.sit', data: packed }]);
    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(fs.names()).toEqual(['Disk Copy']);
  });

  it('skips inner names that already exist and still drops the wrapper', async () => {
    const fs = mockStore();
    const utilities = await fs.ensureDir(2, 'Utilities');
    await fs.importBlob(utilities.id, new File([new Uint8Array([9])], 'Notes'));
    await fs.importBlob(utilities.id, new File([new Uint8Array([8])], 'Stuff.sit'));
    const packed = buildClassicStore([
      { name: 'Notes', data: ascii('new') },
      { name: 'App', data: Uint8Array.of(1) },
    ]);
    const result = await importWelcomePack(fs, [{ path: 'Utilities/Stuff.sit', data: packed }]);
    expect(result).toEqual({ imported: 1, skipped: 1 });
    expect(fs.names().sort()).toEqual(['App', 'Notes']);
  });

  it('keeps a wrapper that cannot be expanded', async () => {
    const fs = mockStore();
    const sit = new Uint8Array(64);
    sit.set(ascii('SIT!'), 0);
    const result = await importWelcomePack(fs, [{ path: 'Utilities/Broken.sit', data: sit }]);
    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(fs.names()).toEqual(['Broken.sit']);
  });

  it('expands StuffIt Expander from the welcome pack without leaving the .sit', async () => {
    const packed = new Uint8Array(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../public/welcome/Utilities/StuffIt Expander 4.0.2.sit'),
      ),
    );
    const fs = mockStore();
    const result = await importWelcomePack(fs, [
      { path: 'Utilities/StuffIt Expander 4.0.2.sit', data: packed },
    ]);
    expect(result.imported).toBeGreaterThan(0);
    expect(fs.names()).not.toContain('StuffIt Expander 4.0.2.sit');
    expect([...fs.files.values()].some((n) => n.isDir && n.name === 'StuffIt Expander™ 4.0.2')).toBe(true);
  });

  it('does not keep wrappers for bundled welcome archives that expand', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../public/welcome/Utilities');
    const archives = readdirSync(dir).filter((n) => /\.(sit|hqx|bin|zip)$/i.test(n));
    expect(archives.length).toBeGreaterThan(0);
    const leftover: string[] = [];
    for (const name of archives) {
      const data = new Uint8Array(readFileSync(join(dir, name)));
      const fs = mockStore();
      await importWelcomePack(fs, [{ path: `Utilities/${name}`, data }]);
      if (fs.names().includes(name)) leftover.push(name);
    }
    const unexpected = leftover.filter((name) => {
      try {
        return Boolean(expandIncoming(name, new Uint8Array(readFileSync(join(dir, name))))?.length);
      } catch {
        return false;
      }
    });
    expect(unexpected).toEqual([]);
  }, 60_000);
});

describe('seedWelcomePackIfNeeded', () => {
  it('imports once per bundled file list', async () => {
    const fs = mockStore();
    const files = [{ path: 'Read Me.txt' }];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) {
        return new Response(JSON.stringify({ files }), { status: 200 });
      }
      return new Response('hello', { status: 200 });
    };
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const first = await seedWelcomePackIfNeeded(fs);
      expect(first).toEqual({ imported: 1, skipped: 0 });
      expect(fs.meta.get(WELCOME_PACK_META_KEY)).toBe(welcomePackStamp(['Read Me.txt']));
      const second = await seedWelcomePackIfNeeded(fs);
      expect(second).toBeNull();
      expect(fs.blobs).toHaveLength(1);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('addWelcomePack restores missing items without replacing', async () => {
    const fs = mockStore();
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('manifest.json')) {
        return new Response(
          JSON.stringify({ files: [{ path: 'Read Me.txt' }, { path: 'Utilities/Notes.txt' }] }),
          { status: 200 },
        );
      }
      return new Response('hello', { status: 200 });
    };
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await addWelcomePack(fs);
      expect(fs.blobs.map((b) => b.name)).toEqual(['Read Me', 'Notes']);
      await addWelcomePack(fs);
      expect(fs.blobs).toHaveLength(2);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
