/**
 * MacRoman encode/decode + AppleTalk case fold for NBP matching.
 * Subset covering the classic MacRoman repertoire used by AFP pathnames.
 */

const MACROMAN_HIGH: string[] = [
  'Ä', 'Å', 'Ç', 'É', 'Ñ', 'Ö', 'Ü', 'á', 'à', 'â', 'ä', 'ã', 'å', 'ç', 'é', 'è',
  'ê', 'ë', 'í', 'ì', 'î', 'ï', 'ñ', 'ó', 'ò', 'ô', 'ö', 'õ', 'ú', 'ù', 'û', 'ü',
  '†', '°', '¢', '£', '§', '•', '¶', 'ß', '®', '©', '™', '´', '¨', '≠', 'Æ', 'Ø',
  '∞', '±', '≤', '≥', '¥', 'µ', '∂', '∑', '∏', 'π', '∫', 'ª', 'º', 'Ω', 'æ', 'ø',
  '¿', '¡', '¬', '√', 'ƒ', '≈', '∆', '«', '»', '…', '\u00A0', 'À', 'Ã', 'Õ', 'Œ', 'œ',
  '–', '—', '“', '”', '‘', '’', '÷', '◊', 'ÿ', 'Ÿ', '⁄', '€', '‹', '›', 'ﬁ', 'ﬂ',
  '‡', '·', '‚', '„', '‰', 'Â', 'Ê', 'Á', 'Ë', 'È', 'Í', 'Î', 'Ï', 'Ì', 'Ó', 'Ô',
  '', 'Ò', 'Ú', 'Û', 'Ù', 'ı', 'ˆ', '˜', '¯', '˘', '˙', '˚', '¸', '˝', '˛', 'ˇ',
];

const encodeMap = new Map<string, number>();
for (let i = 0; i < 128; i++) encodeMap.set(String.fromCharCode(i), i);
for (let i = 0; i < MACROMAN_HIGH.length; i++) {
  encodeMap.set(MACROMAN_HIGH[i]!, 0x80 + i);
}

export function encodeMacRoman(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = encodeMap.get(ch);
    out[i] = code !== undefined ? code : 0x3f; // '?'
  }
  return out;
}

export function decodeMacRoman(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    s += c < 0x80 ? String.fromCharCode(c) : MACROMAN_HIGH[c - 0x80] ?? '?';
  }
  return s;
}

/** AppleTalk case-insensitive fold used by NBP (ASCII A-Z → a-z). */
export function atalkFold(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    out[i] = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
  }
  return out;
}

export function atalkEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const fa = atalkFold(a);
  const fb = atalkFold(b);
  for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return false;
  return true;
}
