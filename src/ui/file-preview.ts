import { filenameExtension } from '../fs/extension-map';
import { readTypeCreator } from '../fs/icon-cache';

export type FilePreviewKind = 'text' | 'image' | 'audio' | 'pict' | 'pdf';

const TEXT_TYPES = new Set(['TEXT', 'ttro']);
const IMAGE_TYPES = new Set(['JPEG', 'GIFf', 'PNG ', 'BMPp', 'BMP ']);
const AUDIO_TYPES = new Set(['WAVE', 'MPG3', 'AIFF', 'AIFC']);
const PICT_TYPES = new Set(['PICT']);
const PDF_TYPES = new Set(['PDF ']);

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp']);
const AUDIO_EXTS = new Set(['wav', 'mp3', 'aiff', 'aif']);
const PICT_EXTS = new Set(['pict', 'pic', 'pct']);
const TEXT_EXTS = new Set(['ttro', 'bat', 'cmd', 'doc']);
const PDF_EXTS = new Set(['pdf']);

export function previewKindFor(node: { name: string; finderInfo: Uint8Array; isDir: boolean }): FilePreviewKind | null {
  if (node.isDir) return null;
  const type = readTypeCreator(node.finderInfo).type;
  const ext = filenameExtension(node.name);
  if (PDF_TYPES.has(type) || PDF_EXTS.has(ext)) return 'pdf';
  if (PICT_TYPES.has(type) || PICT_EXTS.has(ext)) return 'pict';
  if (IMAGE_TYPES.has(type) || IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_TYPES.has(type) || AUDIO_EXTS.has(ext)) return 'audio';
  if (TEXT_TYPES.has(type) || TEXT_EXTS.has(ext)) return 'text';
  return null;
}

export function isBmpPreview(name: string, type: string): boolean {
  return type === 'BMPp' || type === 'BMP ' || filenameExtension(name) === 'bmp';
}

export function previewMime(kind: FilePreviewKind, name: string, type: string): string {
  const ext = filenameExtension(name);
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'image') {
    if (type === 'GIFf' || ext === 'gif') return 'image/gif';
    if (type === 'PNG ' || ext === 'png') return 'image/png';
    if (type === 'BMPp' || type === 'BMP ' || ext === 'bmp') return 'image/bmp';
    return 'image/jpeg';
  }
  if (kind === 'audio') {
    if (type === 'WAVE' || ext === 'wav') return 'audio/wav';
    if (type === 'AIFF' || type === 'AIFC' || ext === 'aiff' || ext === 'aif') return 'audio/aiff';
    return 'audio/mpeg';
  }
  return 'application/octet-stream';
}
