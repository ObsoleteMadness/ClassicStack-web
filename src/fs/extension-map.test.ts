import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSION_MAP,
  EXTENSION_MAP_STORAGE_KEY,
  cloneDefaultExtensionMap,
  filenameExtension,
  finderInfoFromName,
  loadExtensionMap,
  lookupExtension,
  normalizeExtension,
  normalizeMappings,
  padOsType,
  parseExtensionMap,
  saveExtensionMap,
} from './extension-map';

const memory = new Map<string, string>();

function installStorage(): void {
  memory.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memory.set(k, v);
      },
      removeItem: (k: string) => {
        memory.delete(k);
      },
    },
  });
}

afterEach(() => {
  memory.clear();
});

describe('extension-map', () => {
  it('pads OSTypes and strips a leading dot from extensions', () => {
    expect(padOsType('PDF')).toBe('PDF ');
    expect(padOsType('')).toBe('????');
    expect(normalizeExtension('.TXT')).toBe('txt');
    expect(filenameExtension('Read Me.txt')).toBe('txt');
    expect(filenameExtension('archive.tar.gz')).toBe('gz');
    expect(filenameExtension('noext')).toBe('');
  });

  it('looks up type/creator and writes FinderInfo', () => {
    const rows = cloneDefaultExtensionMap();
    expect(lookupExtension('notes.md', rows)).toEqual({ type: 'TEXT', creator: 'ttxt' });
    expect(lookupExtension('x.pdf', rows)).toEqual({ type: 'PDF ', creator: 'CARO' });
    expect(lookupExtension('archive.sit', rows)).toEqual({ type: 'SIT!', creator: 'SITx' });
    expect(lookupExtension('clip.pict', rows)).toEqual({ type: 'PICT', creator: 'TVOD' });
    expect(lookupExtension('System.image', rows)).toEqual({ type: 'dImg', creator: 'ddsk' });
    expect(lookupExtension('unknown.xyz', rows)).toEqual({ type: '????', creator: '????' });
    const fi = finderInfoFromName('photo.png', rows);
    expect(String.fromCharCode(...fi.subarray(0, 4))).toBe('PNG ');
    expect(String.fromCharCode(...fi.subarray(4, 8))).toBe('ogle');
  });

  it('dedupes on extension (last wins) and drops empty rows', () => {
    const rows = normalizeMappings([
      { extension: 'txt', creator: 'ttxt', type: 'TEXT', comment: 'ASCII Text' },
      { extension: '', creator: 'xxxx', type: 'YYYY', comment: 'gone' },
      { extension: '.TXT', creator: 'MSWD', type: 'TEXT', comment: 'Word Document' },
    ]);
    expect(rows).toEqual([
      { extension: 'txt', creator: 'MSWD', type: 'TEXT', comment: 'Word Document' },
    ]);
  });

  it('parses stored JSON and rejects non-arrays', () => {
    expect(parseExtensionMap(null)).toBeNull();
    expect(parseExtensionMap({ txt: 'TEXT' })).toBeNull();
    expect(
      parseExtensionMap([{ extension: 'gif', creator: 'ogle', type: 'GIFf', comment: 'GIF Picture' }]),
    ).toEqual([{ extension: 'gif', creator: 'ogle', type: 'GIFf', comment: 'GIF Picture' }]);
    expect(parseExtensionMap([{ extension: 'gif', creator: 'ogle', type: 'GIFf' }])).toEqual([
      { extension: 'gif', creator: 'ogle', type: 'GIFf', comment: '' },
    ]);
  });

  it('loads defaults, then persists user edits in localStorage', () => {
    installStorage();
    expect(loadExtensionMap()).toEqual([...DEFAULT_EXTENSION_MAP]);
    const saved = saveExtensionMap([
      { extension: 'swift', creator: 'Xcod', type: 'TEXT', comment: 'Swift Source' },
    ]);
    expect(saved).toEqual([{ extension: 'swift', creator: 'Xcod', type: 'TEXT', comment: 'Swift Source' }]);
    expect(JSON.parse(memory.get(EXTENSION_MAP_STORAGE_KEY)!)).toEqual(saved);
    expect(loadExtensionMap()).toEqual(saved);
  });
});
