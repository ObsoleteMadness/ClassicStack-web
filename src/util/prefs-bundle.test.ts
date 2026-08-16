import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_MAP_STORAGE_KEY } from '../fs/extension-map';
import { WINDOWS_STORAGE_KEY } from '../ui/window-layout';
import {
  applyPrefsBundle,
  buildPrefsBundle,
  parsePrefsBundle,
  PREFS_BUNDLE_KIND,
  stringifyPrefsBundle,
} from './prefs-bundle';
import { PREFS_STORAGE_KEY, loadPrefs } from './prefs';

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

describe('prefs bundle', () => {
  it('rejects unknown files', () => {
    expect(() => parsePrefsBundle(null)).toThrow(/Not a ClassicStack/);
    expect(() => parsePrefsBundle({ kind: 'other', version: 1 })).toThrow(/Not a ClassicStack/);
    expect(() => parsePrefsBundle({ kind: PREFS_BUNDLE_KIND, version: 0 })).toThrow(/version/);
  });

  it('round-trips prefs, windows, and extension mappings', () => {
    installStorage();
    memory.set(
      PREFS_STORAGE_KEY,
      JSON.stringify({ showHiddenFiles: true, zipExportStyle: 'macosx', autoExpandFiles: false }),
    );
    memory.set(
      WINDOWS_STORAGE_KEY,
      JSON.stringify({ finder: { left: 12, top: 40, width: 800, height: 600, maximized: true, open: true } }),
    );
    memory.set(
      EXTENSION_MAP_STORAGE_KEY,
      JSON.stringify([{ extension: 'txt', creator: 'ttxt', type: 'TEXT', comment: 'ASCII Text' }]),
    );

    const json = stringifyPrefsBundle(buildPrefsBundle());
    const parsed = parsePrefsBundle(JSON.parse(json) as unknown);
    memory.clear();
    applyPrefsBundle(parsed);

    expect(loadPrefs()).toMatchObject({
      showHiddenFiles: true,
      zipExportStyle: 'macosx',
      autoExpandFiles: false,
      readFinderIcons: true,
    });
    expect(JSON.parse(memory.get(WINDOWS_STORAGE_KEY)!).finder).toMatchObject({
      left: 12,
      top: 40,
      width: 800,
      height: 600,
      maximized: true,
      open: true,
    });
    expect(JSON.parse(memory.get(EXTENSION_MAP_STORAGE_KEY)!)).toEqual([
      { extension: 'txt', creator: 'ttxt', type: 'TEXT', comment: 'ASCII Text' },
    ]);
  });
});
