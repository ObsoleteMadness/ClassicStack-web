/**
 * Windows icon extraction: standalone .ico and icons embedded in PE/NE .exe/.scr.
 */

import type { ByteRangeReader } from '../byte-range';
import { bufferRangeReader } from '../byte-range';
import type { DecodedIcon } from '../resource-types/icon-decoder';
import { decodeIcoFromReader, sniffIcoHeader } from './ico';
import { extractNeIcons } from './ne';
import { extractPeIcons } from './pe';
import { readExact } from './read';
import { le16, le32 } from '../../protocol/binary';

const WIN_ICON_EXT = /\.(exe|scr|cpl|ocx|ico|icl|cur)$/i;
const WIN_EXE_EXT = /\.(exe|scr|dll|cpl|ocx|icl)$/i;
const WIN_VERSION_EXT = /\.(exe|dll|scr|ocx)$/i;
const MZ = 0x5a4d;
const PE_SIG = 0x4550;
const NE_SIG = 0x454e;

export type WinIconKind = 'ico' | 'pe' | 'ne';

function winBaseName(name: string): string {
  return name.split(/[/\\]/).pop() ?? name;
}

/** True when the filename is a Windows icon or executable that may contain one. */
export function isWinIconName(name: string): boolean {
  return WIN_ICON_EXT.test(winBaseName(name));
}

/** True when the filename is a PE/NE module (not a standalone .ico/.cur). */
export function isWinExeName(name: string): boolean {
  return WIN_EXE_EXT.test(winBaseName(name));
}

/** True when Get Info should look for RT_VERSION / VERSIONINFO. */
export function isWinVersionName(name: string): boolean {
  return WIN_VERSION_EXT.test(winBaseName(name));
}

/** True when the Windows resource explorer applies (PE/NE/ICO, including .dll). */
export function isWinResourceName(name: string): boolean {
  return isWinIconName(name) || isWinExeName(name);
}

export function sniffWinIcon(header: Uint8Array): WinIconKind | null {
  if (sniffIcoHeader(header)) return 'ico';
  if (header.length >= 2 && le16(header, 0) === MZ) {
    if (header.length < 64) return 'pe';
    const lfanew = le32(header, 0x3c);
    if (lfanew + 4 <= header.length) {
      const sig = le16(header, lfanew);
      if (sig === NE_SIG) return 'ne';
      if (le32(header, lfanew) === PE_SIG) return 'pe';
    }
    return 'pe';
  }
  return null;
}

/** Closest frame to `target` px (prefer exact, then smallest ≥ target, then largest). */
export function pickIconNear(icons: DecodedIcon[], target: number): DecodedIcon | undefined {
  if (!icons.length) return undefined;
  const score = (i: DecodedIcon): number => {
    const d = Math.max(i.width, i.height);
    const depth = i.isColor ? 1 : 0;
    if (d === target) return 1000 + depth;
    if (d > target) return 500 - (d - target) + depth;
    return d + depth;
  };
  return [...icons].sort((a, b) => score(b) - score(a))[0];
}

export async function extractWinIcons(read: ByteRangeReader): Promise<DecodedIcon[]> {
  const header = await readExact(read, 0, 64);
  if (!header) return [];
  const kind = sniffWinIcon(header);
  if (kind === 'ico') return decodeIcoFromReader(read);
  if (kind === 'ne') {
    const lfanew = le32(header, 0x3c);
    const ne = await readExact(read, lfanew, 2);
    if (ne && le16(ne, 0) === NE_SIG) return extractNeIcons(read);
    return extractPeIcons(read);
  }
  if (kind === 'pe') {
    const lfanew = header.length >= 64 ? le32(header, 0x3c) : 0;
    if (lfanew) {
      const sig = await readExact(read, lfanew, 4);
      if (sig && le16(sig, 0) === NE_SIG) return extractNeIcons(read);
    }
    return extractPeIcons(read);
  }
  return [];
}

export async function extractWinIconsFromBuffer(data: Uint8Array): Promise<DecodedIcon[]> {
  return extractWinIcons(bufferRangeReader(data));
}

export { decodeIco, decodeIcoFromReader, encodeIco } from './ico';
export { extractPeIcons, extractPeIconsFromBuffer } from './pe';
export { extractNeIcons, extractNeIconsFromBuffer } from './ne';
