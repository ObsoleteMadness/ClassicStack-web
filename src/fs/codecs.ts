/**
 * Pluggable Macintosh file codecs.
 *
 * When ClassicStack-web splits into packages, these registries are the public
 * seams — not FinderWindow. Third parties register their own StuffIt expander,
 * rez decoder, dcmp method, or resource-type viewer without forking the PWA.
 *
 * Later registrations win on sniff (unshift), so an app can replace the bundled
 * SIT implementation.
 */

import type { ExpandedNode } from './expand-incoming';

export type ArchiveSniff = {
  name: string;
  finderInfo?: Uint8Array;
  data?: Uint8Array;
  resource?: Uint8Array;
};

/** Bundled archive codec ids. Re-register the same id to replace the default expander. */
export const ARCHIVE_CODEC_SIT = 'sit';
export const ARCHIVE_CODEC_BINHEX = 'binhex';
export const ARCHIVE_CODEC_MACBINARY = 'macbinary';
export const ARCHIVE_CODEC_ZIP = 'zip';
export const ARCHIVE_CODEC_APPLESINGLE = 'applesingle';

/** Bundled Apple compressed-resource decompressor. Re-register to replace dcmp 0/1/2. */
export const RESOURCE_DECOMPRESSOR_DCMP = 'dcmp';

/** BinHex / MacBinary / StuffIt / ZIP / a third-party archive format. */
export interface ArchiveCodec {
  /** Stable id (`sit`, `binhex`, `zip`, or a vendor name). */
  id: string;
  /**
   * When false, sniffing this codec does not offer Finder Expand
   * (AppleSingle is unwrapped while expanding other archives).
   */
  expandable?: boolean;
  sniff(input: ArchiveSniff): boolean;
  expand(name: string, data: Uint8Array): ExpandedNode[] | null;
}

/** Apple compressed-resource ('dcmp' 0/1/2) or a replacement decompressor. */
export interface ResourceDecompressor {
  id: string;
  sniff(data: Uint8Array, attributes?: number): boolean;
  decompress(data: Uint8Array): Uint8Array;
}

/**
 * Decode one resource type (ICN#, cicn, vers, or a rez-style text dump).
 * `type` is a four-character OSType, or `*` for a catch-all.
 */
export interface ResourceTypeDecoder {
  type: string;
  decode(type: string, id: number, payload: Uint8Array): unknown | null;
}

/**
 * Decompile / compile ResEdit-style `.r` (rez) text. No bundled implementation;
 * register one to teach the Resource Fork explorer a text view.
 */
export interface RezCodec {
  id: string;
  decompile?(type: string, id: number, payload: Uint8Array): string | null;
  compile?(source: string): { type: string; id: number; payload: Uint8Array }[] | null;
}

const archives: ArchiveCodec[] = [];
const decompressors: ResourceDecompressor[] = [];
const typeDecoders: ResourceTypeDecoder[] = [];
const rezCodecs: RezCodec[] = [];

function unshiftUnique<T extends { id?: string; type?: string }>(list: T[], item: T, key: keyof T): void {
  const id = item[key];
  if (id != null) {
    const i = list.findIndex((x) => x[key] === id);
    if (i >= 0) list.splice(i, 1);
  }
  list.unshift(item);
}

/** Register an archive expander. Re-registering the same `id` replaces the previous codec. */
export function registerArchiveCodec(codec: ArchiveCodec): void {
  unshiftUnique(archives, codec, 'id');
}

export function registeredArchiveCodecs(): readonly ArchiveCodec[] {
  return archives;
}

export function registerResourceDecompressor(codec: ResourceDecompressor): void {
  unshiftUnique(decompressors, codec, 'id');
}

export function registeredResourceDecompressors(): readonly ResourceDecompressor[] {
  return decompressors;
}

export function registerResourceTypeDecoder(decoder: ResourceTypeDecoder): void {
  unshiftUnique(typeDecoders, decoder, 'type');
}

export function registeredResourceTypeDecoders(): readonly ResourceTypeDecoder[] {
  return typeDecoders;
}

export function registerRezCodec(codec: RezCodec): void {
  unshiftUnique(rezCodecs, codec, 'id');
}

export function registeredRezCodecs(): readonly RezCodec[] {
  return rezCodecs;
}

export function sniffArchiveCodec(input: ArchiveSniff): ArchiveCodec | undefined {
  return archives.find((c) => c.sniff(input));
}

export function decodeResourceType(type: string, id: number, payload: Uint8Array): unknown | null {
  for (const d of typeDecoders) {
    if (d.type !== '*' && d.type !== type) continue;
    const out = d.decode(type, id, payload);
    if (out != null) return out;
  }
  return null;
}

export function decompileRez(type: string, id: number, payload: Uint8Array): string | null {
  for (const c of rezCodecs) {
    const out = c.decompile?.(type, id, payload);
    if (out != null) return out;
  }
  return null;
}
