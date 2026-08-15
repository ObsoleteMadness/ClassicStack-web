/** Persisted UI preferences (localStorage). */

import type { ZipExportStyle } from '../fs/appledouble';

const STORAGE_KEY = 'classicstack.prefs';

export interface AppPrefs {
  /** When false, Finder hides items with the AppleDouble/Finder kIsInvisible flag (and Icon\\r). */
  showHiddenFiles: boolean;
  /** When true, dropped .hqx / MacBinary .bin / StuffIt .sit / ZIP .zip files are decoded. */
  autoExpandFiles: boolean;
  /** Zip download layout: AppleDouble `._` beside files, or Mac OS X `__MACOSX/` folder. */
  zipExportStyle: ZipExportStyle;
}

const DEFAULTS: AppPrefs = {
  showHiddenFiles: false,
  autoExpandFiles: true,
  zipExportStyle: 'appledouble',
};

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppPrefs>;
    return {
      showHiddenFiles:
        typeof parsed.showHiddenFiles === 'boolean'
          ? parsed.showHiddenFiles
          : DEFAULTS.showHiddenFiles,
      autoExpandFiles:
        typeof parsed.autoExpandFiles === 'boolean'
          ? parsed.autoExpandFiles
          : DEFAULTS.autoExpandFiles,
      zipExportStyle: parsed.zipExportStyle === 'macosx' ? 'macosx' : DEFAULTS.zipExportStyle,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(patch: Partial<AppPrefs>): AppPrefs {
  const next = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
  return next;
}
