/**
 * Host filesystem filename reserved-char escaping (ClassicStack core/fs/codec.go).
 * Control chars and NTFS-illegal runes are stored as reversible "0xNN" tokens
 * (e.g. Mac "Icon\r" → "Icon0x0D" on disk). Unescape when importing into VFS.
 */

const NTFS_EXTRA = new Set<number>([
  '<'.codePointAt(0)!,
  '>'.codePointAt(0)!,
  ':'.codePointAt(0)!,
  '"'.codePointAt(0)!,
  '/'.codePointAt(0)!,
  '\\'.codePointAt(0)!,
  '|'.codePointAt(0)!,
  '?'.codePointAt(0)!,
  '*'.codePointAt(0)!,
]);

function isHostReserved(cp: number): boolean {
  return cp < 0x20 || NTFS_EXTRA.has(cp);
}

function fromHex(c: number): number | null {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return null;
}

function upperHexRune(cp: number): string {
  const hex = cp.toString(16).toUpperCase();
  return hex.length < 2 ? hex.padStart(2, '0') : hex;
}

/** Escape reserved runes as "0xNN" (ClassicStack ReservedSet.escape). */
export function escapeHostFilename(s: string): string {
  let needs = false;
  for (const ch of s) {
    if (isHostReserved(ch.codePointAt(0)!)) {
      needs = true;
      break;
    }
  }
  if (!needs) return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += isHostReserved(cp) ? `0x${upperHexRune(cp)}` : ch;
  }
  return out;
}

/**
 * Reverse "0xNN" tokens whose code point is host-reserved.
 * "Icon0x0D" → "Icon\r". Non-reserved tokens stay literal.
 */
export function unescapeHostFilename(s: string): string {
  if (!s.includes('0x')) return s;
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (i + 4 <= s.length && s[i] === '0' && s[i + 1] === 'x') {
      const h = fromHex(s.charCodeAt(i + 2));
      const l = fromHex(s.charCodeAt(i + 3));
      if (h != null && l != null) {
        const cp = (h << 4) | l;
        if (isHostReserved(cp)) {
          out += String.fromCharCode(cp);
          i += 4;
          continue;
        }
      }
    }
    const cp = s.codePointAt(i)!;
    out += String.fromCodePoint(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}
