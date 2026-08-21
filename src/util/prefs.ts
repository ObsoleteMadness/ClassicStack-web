/** Persisted UI preferences (localStorage). */

import type { ZipExportStyle } from '../fs/appledouble';

export type DefaultViewMode = 'icon' | 'list' | 'column';

export const PREFS_STORAGE_KEY = 'classicstack.prefs';

export interface AppPrefs {
  /** Finder view when no URL `view` parameter is present. */
  defaultView: DefaultViewMode;
  /** When false, Finder hides items with the AppleDouble/Finder kIsInvisible flag (and Icon\\r). */
  showHiddenFiles: boolean;
  /** When false, skip Icon\\r / resource-fork icon reads and use DIR/FILE system glyphs. */
  readFinderIcons: boolean;
  /** When true, dropped .hqx / MacBinary .bin / StuffIt .sit / ZIP .zip files are decoded. */
  autoExpandFiles: boolean;
  /** Zip download layout: AppleDouble `._` beside files, or Mac OS X `__MACOSX/` folder. */
  zipExportStyle: ZipExportStyle;
}

const DEFAULTS: AppPrefs = {
  defaultView: 'icon',
  showHiddenFiles: false,
  readFinderIcons: true,
  autoExpandFiles: true,
  zipExportStyle: 'appledouble',
};

export function parsePrefs(raw: unknown): AppPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const parsed = raw as Partial<AppPrefs>;
  return {
    defaultView:
      parsed.defaultView === 'list' || parsed.defaultView === 'column' || parsed.defaultView === 'icon'
        ? parsed.defaultView
        : DEFAULTS.defaultView,
    showHiddenFiles:
      typeof parsed.showHiddenFiles === 'boolean'
        ? parsed.showHiddenFiles
        : DEFAULTS.showHiddenFiles,
    readFinderIcons:
      typeof parsed.readFinderIcons === 'boolean'
        ? parsed.readFinderIcons
        : DEFAULTS.readFinderIcons,
    autoExpandFiles:
      typeof parsed.autoExpandFiles === 'boolean'
        ? parsed.autoExpandFiles
        : DEFAULTS.autoExpandFiles,
    zipExportStyle: parsed.zipExportStyle === 'macosx' ? 'macosx' : DEFAULTS.zipExportStyle,
  };
}

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return parsePrefs(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(patch: Partial<AppPrefs>): AppPrefs {
  const next = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
  return next;
}

export function replacePrefs(prefs: AppPrefs): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(parsePrefs(prefs)));
  } catch {
    /* quota / private mode */
  }
}

export function clearPrefs(): void {
  try {
    localStorage.removeItem(PREFS_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}
