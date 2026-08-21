/** Netatalk `.ext "TYPE" "CRTR"` codec for the shared extension-map editor. */

import {
  normalizeExtension,
  normalizeMappings,
  padOsType,
  type ExtensionMapping,
} from './extension-map';

const LINE = /^(\S+)\s+"([^"]*)"\s+"([^"]*)"(.*)$/;

function parseNetatalkLine(line: string): ExtensionMapping | null {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  const token = m[1]!;
  const extension = token === '.' ? '.' : normalizeExtension(token);
  if (!extension) return null;
  return {
    extension,
    type: padOsType(m[2]!),
    creator: padOsType(m[3]!),
    comment: (m[4] ?? '').trim(),
  };
}

/** Enabled (uncommented) Netatalk mappings. `#` lines and blanks are ignored. */
export function parseNetatalkExtensionMap(text: string): ExtensionMapping[] {
  const rows: ExtensionMapping[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const row = parseNetatalkLine(line);
    if (row) rows.push(row);
  }
  return normalizeMappings(rows);
}

export function formatNetatalkLine(row: ExtensionMapping): string {
  const ext = row.extension === '.' ? '.' : `.${row.extension}`;
  const comment = row.comment ? `      ${row.comment}` : '';
  return `${ext} "${padOsType(row.type)}" "${padOsType(row.creator)}"${comment}`;
}

/**
 * Write enabled rows in Netatalk form. When `original` is the previous file,
 * `#` comments and commented-out mappings are kept; enabled lines are replaced
 * in place and new extensions are appended.
 */
export function serializeNetatalkExtensionMap(
  rows: readonly ExtensionMapping[],
  original = '',
): string {
  const enabled = normalizeMappings(rows);
  const byExt = new Map(enabled.map((r) => [r.extension, r]));
  const written = new Set<string>();
  const out: string[] = [];
  if (original) {
    for (const raw of original.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) {
        out.push('');
        continue;
      }
      if (t.startsWith('#')) {
        out.push(raw);
        continue;
      }
      const parsed = parseNetatalkLine(t);
      if (!parsed) continue;
      const next = byExt.get(parsed.extension);
      if (!next) continue;
      out.push(formatNetatalkLine(next));
      written.add(parsed.extension);
    }
  }
  for (const row of enabled) {
    if (!written.has(row.extension)) out.push(formatNetatalkLine(row));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? `${out.join('\n')}\n` : '';
}
