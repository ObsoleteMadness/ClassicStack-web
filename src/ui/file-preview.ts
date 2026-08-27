import { filenameExtension } from '../fs/extension-map';
import { readTypeCreator } from '../fs/icon-cache';

export type FilePreviewKind = 'text' | 'image' | 'audio' | 'video' | 'html' | 'pict' | 'pdf';

const TEXT_TYPES = new Set(['TEXT', 'ttro']);
const IMAGE_TYPES = new Set(['JPEG', 'GIFf', 'PNG ', 'BMPp', 'BMP ', 'ICO ']);
const AUDIO_TYPES = new Set(['WAVE', 'MPG3', 'AIFF', 'AIFC']);
const VIDEO_TYPES = new Set(['M4V ', 'MPG4']);
const PICT_TYPES = new Set(['PICT']);
const PDF_TYPES = new Set(['PDF ']);
const HTML_TYPES = new Set(['HTML']);

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'ico', 'cur']);
const AUDIO_EXTS = new Set(['wav', 'mp3', 'aiff', 'aif']);
const VIDEO_EXTS = new Set(['mp4', 'm4v']);
const PICT_EXTS = new Set(['pict', 'pic', 'pct']);
const TEXT_EXTS = new Set(['txt', 'text', 'ttro', 'bat', 'cmd', 'doc']);
const PDF_EXTS = new Set(['pdf']);
const HTML_EXTS = new Set(['html', 'htm']);

export function previewKindFor(node: { name: string; finderInfo: Uint8Array; isDir: boolean }): FilePreviewKind | null {
  if (node.isDir) return null;
  const type = readTypeCreator(node.finderInfo).type;
  const ext = filenameExtension(node.name);
  // html/htm map to TEXT in the extension table; check them before text.
  if (HTML_TYPES.has(type) || HTML_EXTS.has(ext)) return 'html';
  if (PDF_TYPES.has(type) || PDF_EXTS.has(ext)) return 'pdf';
  if (PICT_TYPES.has(type) || PICT_EXTS.has(ext)) return 'pict';
  if (IMAGE_TYPES.has(type) || IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_TYPES.has(type) || VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_TYPES.has(type) || AUDIO_EXTS.has(ext)) return 'audio';
  if (TEXT_TYPES.has(type) || TEXT_EXTS.has(ext)) return 'text';
  return null;
}

export function isBmpPreview(name: string, type: string): boolean {
  return type === 'BMPp' || type === 'BMP ' || filenameExtension(name) === 'bmp';
}

export function isIcoPreview(name: string, type: string): boolean {
  const ext = filenameExtension(name);
  return ext === 'ico' || ext === 'cur' || type === 'ICO ';
}

export function previewMime(kind: FilePreviewKind, name: string, type: string): string {
  const ext = filenameExtension(name);
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'html') return 'text/html';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'image') {
    if (type === 'GIFf' || ext === 'gif') return 'image/gif';
    if (type === 'PNG ' || ext === 'png') return 'image/png';
    if (type === 'BMPp' || type === 'BMP ' || ext === 'bmp') return 'image/bmp';
    if (type === 'ICO ' || ext === 'ico' || ext === 'cur') return 'image/x-icon';
    return 'image/jpeg';
  }
  if (kind === 'audio') {
    if (type === 'WAVE' || ext === 'wav') return 'audio/wav';
    if (type === 'AIFF' || type === 'AIFC' || ext === 'aiff' || ext === 'aif') return 'audio/aiff';
    return 'audio/mpeg';
  }
  return 'application/octet-stream';
}
