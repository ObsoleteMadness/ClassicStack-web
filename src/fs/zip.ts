/** ZIP expand: store/deflate members, merge `._` and `__MACOSX` AppleDouble. */

import { unzipSync } from 'fflate';
import { parseAppleDouble, type AppleDoubleData } from './appledouble';
import { finderInfoFromName } from './extension-map';
import { SitError } from './stuffit-codec';

export type ZipMember = {
  path: string;
  isFolder: boolean;
  data: Uint8Array;
  resource: Uint8Array;
  finderInfo: Uint8Array;
};

const PK = 0x50;
const LOCAL = 0x04034b50;
const EOCD = 0x06054b50;
const SPAN = 0x08074b50;

function le32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

export function isZipArchive(data: Uint8Array): boolean {
  if (data.length < 4 || data[0] !== PK || data[1] !== 0x4b) return false;
  const sig = le32(data, 0);
  return sig === LOCAL || sig === EOCD || sig === SPAN;
}

function isAppleDoubleSidecarName(name: string): boolean {
  return name.startsWith('._') && name.length > 2;
}

function isJunkBase(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.ds_store' || lower === '._.ds_store';
}

/** Split a ZIP path; reject `..` and empty. */
function zipParts(raw: string): { parts: string[]; isDir: boolean } | null {
  const isDir = raw.endsWith('/') || raw.endsWith('\\');
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  if (!parts.length || parts.some((s) => s === '..')) return null;
  return { parts, isDir };
}

function logicalFromSidecar(parts: string[]): string | null {
  const base = parts[parts.length - 1]!;
  if (!isAppleDoubleSidecarName(base)) return null;
  const rest = [...parts.slice(0, -1), base.slice(2)];
  if (!rest[rest.length - 1] || isJunkBase(rest[rest.length - 1]!)) return null;
  return rest.join('/');
}

type FileRec = { data: Uint8Array; resource: Uint8Array; finderInfo: Uint8Array };

function applyAppleDouble(
  files: Map<string, FileRec>,
  dirs: Map<string, Uint8Array>,
  path: string,
  ad: AppleDoubleData,
): void {
  const isDir =
    dirs.has(path) ||
    [...files.keys()].some((k) => k.startsWith(`${path}/`)) ||
    [...dirs.keys()].some((k) => k.startsWith(`${path}/`));
  if (isDir) {
    dirs.set(path, ad.finderInfo);
    return;
  }
  const existing = files.get(path);
  if (existing) {
    existing.resource = ad.resource;
    existing.finderInfo = ad.finderInfo;
    return;
  }
  files.set(path, {
    data: new Uint8Array(),
    resource: ad.resource,
    finderInfo: ad.finderInfo,
  });
}

function ensureParentDirs(dirs: Map<string, Uint8Array>, path: string): void {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!dirs.has(dir)) dirs.set(dir, new Uint8Array(32));
  }
}

/**
 * Unzip `bytes` and merge AppleDouble sidecars (`._Name` next to the file, or
 * `__MACOSX/.../._Name`). Returns null when the payload is not a readable ZIP.
 */
export function parseZip(bytes: Uint8Array): ZipMember[] | null {
  if (!isZipArchive(bytes)) return null;
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/compression/i.test(msg)) {
      throw new SitError(`Unsupported type ${msg}`, 'unsupported');
    }
    return null;
  }

  const files = new Map<string, FileRec>();
  const dirs = new Map<string, Uint8Array>();
  const dotSidecars: { path: string; ad: AppleDoubleData }[] = [];
  const macosxSidecars: { path: string; ad: AppleDoubleData }[] = [];

  for (const [raw, data] of Object.entries(unpacked)) {
    const parsed = zipParts(raw);
    if (!parsed) continue;
    const { parts, isDir } = parsed;
    const macIdx = parts.indexOf('__MACOSX');
    if (macIdx >= 0) {
      const rest = parts.slice(macIdx + 1);
      if (!rest.length || isDir) continue;
      const logical = logicalFromSidecar(rest);
      if (!logical) continue;
      const ad = parseAppleDouble(data);
      if (ad) macosxSidecars.push({ path: logical, ad });
      continue;
    }

    const base = parts[parts.length - 1]!;
    if (isJunkBase(base)) continue;
    const path = parts.join('/');
    if (isDir) {
      if (!dirs.has(path)) dirs.set(path, new Uint8Array(32));
      ensureParentDirs(dirs, path);
      continue;
    }
    if (isAppleDoubleSidecarName(base)) {
      const logical = logicalFromSidecar(parts);
      const ad = parseAppleDouble(data);
      if (logical && ad) {
        dotSidecars.push({ path: logical, ad });
        continue;
      }
    }
    files.set(path, {
      data,
      resource: new Uint8Array(),
      finderInfo: finderInfoFromName(base),
    });
    ensureParentDirs(dirs, path);
  }

  // Nearby `._` first; Finder Compress `__MACOSX` wins when both exist.
  for (const s of dotSidecars) applyAppleDouble(files, dirs, s.path, s.ad);
  for (const s of macosxSidecars) applyAppleDouble(files, dirs, s.path, s.ad);

  const members: ZipMember[] = [];
  const dirPaths = [...dirs.keys()].sort();
  for (const path of dirPaths) {
    members.push({
      path,
      isFolder: true,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: dirs.get(path)!,
    });
  }
  const filePaths = [...files.keys()].sort();
  for (const path of filePaths) {
    const rec = files.get(path)!;
    members.push({
      path,
      isFolder: false,
      data: rec.data,
      resource: rec.resource,
      finderInfo: rec.finderInfo,
    });
  }
  return members;
}
