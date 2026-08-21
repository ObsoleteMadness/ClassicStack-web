import { describe, expect, it } from 'vitest';
import { CapabilityCatalog } from './capability-catalog';
import { afpVolumeCaps } from './catalog-caps';
import { parseAppleDouble } from './appledouble';
import { collectZipEntries, enumerateZipFiles, type ZipSearchProgress } from './zip-export';
import { nodeRef, type VNode } from './virtual-fs';

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('enumerateZipFiles', () => {
  it('counts folders and files and reports growing totals without reading forks', async () => {
    const cat = new CapabilityCatalog(afpVolumeCaps);
    const docs = await cat.mkdir(2, 'Docs');
    await cat.createFile(nodeRef(docs), 'Read Me', ascii('hello'), ascii('rsrc'));
    const nested = await cat.mkdir(nodeRef(docs), 'Nested');
    await cat.createFile(nodeRef(nested), 'Notes', ascii('xy'));

    const reads: ReturnType<typeof nodeRef>[] = [];
    const origEnsure = cat.ensureContent.bind(cat);
    cat.ensureContent = async (ref, onBytes, signal) => {
      reads.push(ref);
      return origEnsure(ref, onBytes, signal);
    };

    const ticks: ZipSearchProgress[] = [];
    const listed = await enumerateZipFiles(cat, docs, '', (p) => ticks.push({ ...p }));

    expect(reads).toEqual([]);
    expect(listed.items).toBe(4);
    expect(listed.bytes).toBe(5 + 4 + 2);
    expect(listed.files.map((f) => f.path)).toEqual(['Docs/Read Me', 'Docs/Nested/Notes']);
    expect(ticks[0]).toEqual({ items: 1, bytes: 0 });
    expect(ticks.at(-1)).toEqual({ items: 4, bytes: 11 });
    expect(ticks.map((t) => t.items)).toEqual([1, 2, 3, 4]);
  });

  it('walks new children as listing pages arrive', async () => {
    const cat = new CapabilityCatalog(afpVolumeCaps);
    const docs = await cat.mkdir(2, 'Docs');
    await cat.createFile(nodeRef(docs), 'A', ascii('a'));
    await cat.createFile(nodeRef(docs), 'B', ascii('bb'));

    const origChildren = cat.children.bind(cat);
    cat.children = async (parent, onBatch, signal) => {
      const kids = await origChildren(parent, undefined, signal);
      const acc: VNode[] = [];
      for (const kid of kids) {
        acc.push(kid);
        await onBatch?.(acc);
      }
      return kids;
    };

    const ticks: ZipSearchProgress[] = [];
    const listed = await enumerateZipFiles(cat, docs, '', (p) => ticks.push({ ...p }));
    expect(listed.items).toBe(3);
    expect(listed.bytes).toBe(1 + 2);
    expect(ticks.map((t) => t.items)).toEqual([1, 2, 3]);
  });
});

describe('collectZipEntries', () => {
  it('downloads planned files after enumerate and writes AppleDouble pairs', async () => {
    const cat = new CapabilityCatalog(afpVolumeCaps);
    const docs = await cat.mkdir(2, 'Docs');
    const fi = new Uint8Array(32);
    fi.set(ascii('TEXT'), 0);
    fi.set(ascii('ttxt'), 4);
    await cat.createFile(nodeRef(docs), 'Read Me', ascii('hello'), ascii('rsrc'), fi);

    const listed = await enumerateZipFiles(cat, docs);
    const reads: ReturnType<typeof nodeRef>[] = [];
    const origEnsure = cat.ensureContent.bind(cat);
    cat.ensureContent = async (ref, onBytes, signal) => {
      reads.push(ref);
      return origEnsure(ref, onBytes, signal);
    };

    let downloaded = 0;
    const entries = await collectZipEntries(cat, listed.files, 'appledouble', (n) => {
      downloaded += n;
    });
    expect(reads).toHaveLength(1);
    expect(downloaded).toBe(5 + 4);
    expect(entries.map((e) => e.name)).toEqual(['Docs/Read Me', 'Docs/._Read Me']);
    expect([...entries[0]!.data]).toEqual([...ascii('hello')]);
    const ad = parseAppleDouble(entries[1]!.data);
    expect(ad).not.toBeNull();
    expect([...ad!.resource]).toEqual([...ascii('rsrc')]);
  });
});
