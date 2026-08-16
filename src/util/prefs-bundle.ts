/** Export / import ClassicStack UI preferences as a JSON file. */

import { loadExtensionMap, parseExtensionMap, saveExtensionMap, type ExtensionMapping } from '../fs/extension-map';
import { loadWindowLayouts, parseWindowLayouts, replaceWindowLayouts, type WindowLayouts } from '../ui/window-layout';
import { loadPrefs, parsePrefs, replacePrefs, type AppPrefs } from './prefs';

export const PREFS_BUNDLE_KIND = 'classicstack.preferences';
export const PREFS_BUNDLE_VERSION = 1;

export interface PrefsBundle {
  kind: typeof PREFS_BUNDLE_KIND;
  version: number;
  prefs: AppPrefs;
  windows: WindowLayouts;
  extensionMap: ExtensionMapping[];
}

export type ParsedPrefsBundle = {
  prefs?: AppPrefs;
  windows?: WindowLayouts;
  extensionMap?: ExtensionMapping[];
};

export function buildPrefsBundle(): PrefsBundle {
  return {
    kind: PREFS_BUNDLE_KIND,
    version: PREFS_BUNDLE_VERSION,
    prefs: loadPrefs(),
    windows: loadWindowLayouts(),
    extensionMap: loadExtensionMap(),
  };
}

export function stringifyPrefsBundle(bundle: PrefsBundle = buildPrefsBundle()): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function parsePrefsBundle(raw: unknown): ParsedPrefsBundle {
  if (!raw || typeof raw !== 'object') throw new Error('Not a ClassicStack preferences file.');
  const o = raw as Record<string, unknown>;
  if (o.kind !== PREFS_BUNDLE_KIND) throw new Error('Not a ClassicStack preferences file.');
  if (typeof o.version !== 'number' || o.version < 1) throw new Error('Unsupported preferences file version.');
  const out: ParsedPrefsBundle = {};
  if ('prefs' in o) out.prefs = parsePrefs(o.prefs);
  if ('windows' in o) out.windows = parseWindowLayouts(o.windows);
  if ('extensionMap' in o) {
    const map = parseExtensionMap(o.extensionMap);
    if (map) out.extensionMap = map;
  }
  return out;
}

export function applyPrefsBundle(parsed: ParsedPrefsBundle): void {
  if (parsed.prefs) replacePrefs(parsed.prefs);
  if (parsed.windows) replaceWindowLayouts(parsed.windows);
  if (parsed.extensionMap) saveExtensionMap(parsed.extensionMap);
}
