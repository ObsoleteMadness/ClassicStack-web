import { filenameExtension } from '../fs/extension-map';
import { readTypeCreator } from '../fs/icon-cache';

export type FilePreviewKind = 'text' | 'image' | 'audio' | 'pict';

const TEXT_TYPES = new Set(['TEXT', 'ttro']);
const IMAGE_TYPES = new Set(['JPEG', 'GIFf', 'PNG ']);
const AUDIO_TYPES = new Set(['WAVE', 'MPG3', 'AIFF', 'AIFC']);
const PICT_TYPES = new Set(['PICT']);

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif']);
const AUDIO_EXTS = new Set(['wav', 'mp3', 'aiff', 'aif']);
const PICT_EXTS = new Set(['pict', 'pic', 'pct']);
const TEXT_EXTS = new Set(['ttro']);

export function previewKindFor(node: { name: string; finderInfo: Uint8Array; isDir: boolean }): FilePreviewKind | null {
  if (node.isDir) return null;
  const type = readTypeCreator(node.finderInfo).type;
  const ext = filenameExtension(node.name);
  if (PICT_TYPES.has(type) || PICT_EXTS.has(ext)) return 'pict';
  if (IMAGE_TYPES.has(type) || IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_TYPES.has(type) || AUDIO_EXTS.has(ext)) return 'audio';
  if (TEXT_TYPES.has(type) || TEXT_EXTS.has(ext)) return 'text';
  return null;
}

export function previewMime(kind: FilePreviewKind, name: string, type: string): string {
  const ext = filenameExtension(name);
  if (kind === 'image') {
    if (type === 'GIFf' || ext === 'gif') return 'image/gif';
    if (type === 'PNG ' || ext === 'png') return 'image/png';
    return 'image/jpeg';
  }
  if (kind === 'audio') {
    if (type === 'WAVE' || ext === 'wav') return 'audio/wav';
    if (type === 'AIFF' || type === 'AIFC' || ext === 'aiff' || ext === 'aif') return 'audio/aiff';
    return 'audio/mpeg';
  }
  return 'application/octet-stream';
}
