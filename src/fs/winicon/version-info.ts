/**
 * RT_VERSION / VERSIONINFO (VS_VERSION_INFO) for Finder Get Info.
 */

import { le16, le32 } from '../../protocol/binary';
import type { ByteRangeReader } from '../byte-range';
import { decodeVersionInfo } from './decode-res';
import { sniffWinIcon } from './extract';
import { enumerateNeResources } from './ne';
import { enumeratePeResources } from './pe';
import { readExact } from './read';
import { RT_VERSION } from './rt';

const NE_SIG = 0x454e;
const LANG_NEUTRAL = 0;
const LANG_US_ENGLISH = 0x0409;

export interface WinVersionGetInfo {
  version: string;
  productVersion: string;
  product: string;
  description: string;
  copyright: string;
  company: string;
}

function field(map: Map<string, string>, key: string): string {
  return (map.get(key) ?? '').trim();
}

function isBlankVersion(s: string): boolean {
  return !s || /^[0.]+$/.test(s);
}

/** Map VERSIONINFO strings to Get Info rows. */
export function winVersionForGetInfo(fields: { key: string; value: string }[]): WinVersionGetInfo | null {
  const map = new Map(fields.map((f) => [f.key, f.value]));
  const fileVer = field(map, 'FileVersion');
  const prodVer = field(map, 'ProductVersion');
  const version = !isBlankVersion(fileVer) ? fileVer : prodVer;
  const productVersion = !isBlankVersion(prodVer) && prodVer !== version ? prodVer : '';
  const info: WinVersionGetInfo = {
    version: isBlankVersion(version) ? '' : version,
    productVersion,
    product: field(map, 'ProductName'),
    description: field(map, 'FileDescription'),
    copyright: field(map, 'LegalCopyright'),
    company: field(map, 'CompanyName'),
  };
  if (!info.version && !info.product && !info.description && !info.copyright && !info.company) return null;
  return info;
}

function pickVersionBytes(
  leaves: { typeId: number | null; language?: number; bytes: Uint8Array }[],
): Uint8Array | null {
  const vers = leaves.filter((l) => l.typeId === RT_VERSION && l.bytes.length);
  if (!vers.length) return null;
  const prefer =
    vers.find((l) => l.language === LANG_US_ENGLISH) ??
    vers.find((l) => (l.language ?? 0) === LANG_NEUTRAL) ??
    vers[0];
  return prefer?.bytes ?? null;
}

/** RT_VERSION payload from a PE or NE image, or null. */
export async function extractWinVersion(read: ByteRangeReader): Promise<WinVersionGetInfo | null> {
  const header = await readExact(read, 0, 64);
  if (!header) return null;
  const kind = sniffWinIcon(header);
  if (kind === 'ne') {
    const lfanew = le32(header, 0x3c);
    const ne = await readExact(read, lfanew, 2);
    if (ne && le16(ne, 0) === NE_SIG) {
      const table = await enumerateNeResources(read);
      const bytes = table ? pickVersionBytes(table.leaves) : null;
      return bytes ? winVersionForGetInfo(decodeVersionInfo(bytes)) : null;
    }
  }
  if (kind === 'pe' || kind === 'ne') {
    const lfanew = header.length >= 64 ? le32(header, 0x3c) : 0;
    if (lfanew) {
      const sig = await readExact(read, lfanew, 4);
      if (sig && le16(sig, 0) === NE_SIG) {
        const table = await enumerateNeResources(read);
        const bytes = table ? pickVersionBytes(table.leaves) : null;
        return bytes ? winVersionForGetInfo(decodeVersionInfo(bytes)) : null;
      }
    }
    const table = await enumeratePeResources(read);
    const bytes = table ? pickVersionBytes(table.leaves) : null;
    return bytes ? winVersionForGetInfo(decodeVersionInfo(bytes)) : null;
  }
  return null;
}
