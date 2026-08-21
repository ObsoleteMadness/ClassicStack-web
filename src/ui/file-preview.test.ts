import { describe, expect, it } from 'vitest';
import { finderInfoFromName } from '../fs/extension-map';
import { previewKindFor, previewMime } from './file-preview';

function node(name: string, isDir = false) {
  return { name, isDir, finderInfo: finderInfoFromName(name) };
}

describe('file preview kinds', () => {
  it('classifies browser media, PICT, and text', () => {
    expect(previewKindFor(node('shot.jpg'))).toBe('image');
    expect(previewKindFor(node('shot.png'))).toBe('image');
    expect(previewKindFor(node('shot.gif'))).toBe('image');
    expect(previewKindFor(node('shot.bmp'))).toBe('image');
    expect(previewKindFor(node('clip.pict'))).toBe('pict');
    expect(previewKindFor(node('song.mp3'))).toBe('audio');
    expect(previewKindFor(node('loop.aiff'))).toBe('audio');
    expect(previewKindFor(node('hit.wav'))).toBe('audio');
    expect(previewKindFor(node('Read Me.txt'))).toBe('text');
    expect(previewKindFor(node('folder', true))).toBeNull();
    expect(previewKindFor(node('app'))).toBeNull();
  });

  it('picks MIME types for the browser elements', () => {
    expect(previewMime('image', 'x.png', 'PNG ')).toBe('image/png');
    expect(previewMime('image', 'x.bmp', 'BMPp')).toBe('image/bmp');
    expect(previewMime('audio', 'x.mp3', 'MPG3')).toBe('audio/mpeg');
    expect(previewMime('audio', 'x.aif', 'AIFF')).toBe('audio/aiff');
  });
});
