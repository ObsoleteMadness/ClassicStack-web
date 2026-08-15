import { describe, expect, it } from 'vitest';
import { parseAppleSingle } from './appledouble';
import { decodeMacRoman } from '../protocol/macroman';
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

function mockStore(): WelcomePackStore & {
  files: Map<string, { id: number; isDir: boolean }>;
  blobs: { parentId: number; name: string }[];
  meta: Map<string, unknown>;
} {
  const files = new Map<string, { id: number; isDir: boolean }>();
  let nextId = 10;
  const key = (parentId: number, name: string) => `${parentId}\0${name.toLowerCase()}`;
  return {
    files,
    blobs: [],
    meta: new Map(),
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
      const node = { id: nextId++, isDir: true };
      files.set(k, node);
      return node;
    },
    async importBlob(parentId, file) {
      files.set(key(parentId, file.name), { id: nextId++, isDir: false });
      this.blobs.push({ parentId, name: file.name });
    },
    async getMeta(k) {
      return this.meta.get(k);
    },
    async setMeta(k, value) {
      this.meta.set(k, value);
    },
  };
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

  it('skips an AppleDouble sidecar when the logical file already exists', async () => {
    const fs = mockStore();
    await fs.importBlob(2, new File([new Uint8Array([1])], 'Disk Copy'));
    const result = await importWelcomePack(fs, [
      { path: '._Disk Copy', data: new Uint8Array([2, 3]) },
    ]);
    expect(result).toEqual({ imported: 0, skipped: 1 });
  });
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
