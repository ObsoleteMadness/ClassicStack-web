import { describe, expect, it } from 'vitest';
import { finderInfoFromName } from '../fs/extension-map';
import { isBmpPreview, isIcoPreview, previewKindFor, previewMime } from './file-preview';

function node(name: string, isDir = false) {
  return { name, isDir, finderInfo: finderInfoFromName(name) };
}

describe('file preview kinds', () => {
  it('classifies browser media, PICT, HTML, and text', () => {
    expect(previewKindFor(node('shot.jpg'))).toBe('image');
    expect(previewKindFor(node('shot.JPEG'))).toBe('image');
    expect(previewKindFor(node('shot.png'))).toBe('image');
    expect(previewKindFor(node('shot.gif'))).toBe('image');
    expect(previewKindFor(node('shot.bmp'))).toBe('image');
    expect(previewKindFor(node('app.ico'))).toBe('image');
    expect(previewKindFor(node('pointer.CUR'))).toBe('image');
    expect(previewKindFor(node('clip.pict'))).toBe('pict');
    expect(previewKindFor(node('song.mp3'))).toBe('audio');
    expect(previewKindFor(node('loop.aiff'))).toBe('audio');
    expect(previewKindFor(node('hit.wav'))).toBe('audio');
    expect(previewKindFor(node('clip.mp4'))).toBe('video');
    expect(previewKindFor(node('clip.M4V'))).toBe('video');
    expect(previewKindFor(node('Read Me.txt'))).toBe('text');
    expect(previewKindFor(node('AUTOEXEC.BAT'))).toBe('text');
    expect(previewKindFor(node('readme.doc'))).toBe('text');
    expect(previewKindFor(node('index.html'))).toBe('html');
    expect(previewKindFor(node('index.HTM'))).toBe('html');
    expect(previewKindFor(node('manual.pdf'))).toBe('pdf');
    expect(previewKindFor(node('folder', true))).toBeNull();
    expect(previewKindFor(node('app'))).toBeNull();
  });

  it('prefers HTML over the TEXT type/creator mapping', () => {
    expect(previewKindFor(node('page.html'))).toBe('html');
    expect(previewKindFor({ name: 'page.html', isDir: false, finderInfo: new Uint8Array(32) })).toBe('html');
  });

  it('still previews txt/bat/doc when Finder info is empty', () => {
    const empty = new Uint8Array(32);
    expect(previewKindFor({ name: 'NOTES.TXT', isDir: false, finderInfo: empty })).toBe('text');
    expect(previewKindFor({ name: 'autoexec.bat', isDir: false, finderInfo: empty })).toBe('text');
    expect(previewKindFor({ name: 'readme.doc', isDir: false, finderInfo: empty })).toBe('text');
  });

  it('detects BMP and ICO/CUR frames that need a decoder', () => {
    expect(isBmpPreview('x.bmp', '????')).toBe(true);
    expect(isIcoPreview('app.ico', '????')).toBe(true);
    expect(isIcoPreview('pointer.cur', '????')).toBe(true);
    expect(isIcoPreview('shot.png', 'PNG ')).toBe(false);
  });

  it('picks MIME types for the browser elements', () => {
    expect(previewMime('image', 'x.png', 'PNG ')).toBe('image/png');
    expect(previewMime('image', 'x.bmp', 'BMPp')).toBe('image/bmp');
    expect(previewMime('image', 'x.ico', '????')).toBe('image/x-icon');
    expect(previewMime('image', 'x.cur', '????')).toBe('image/x-icon');
    expect(previewMime('audio', 'x.mp3', 'MPG3')).toBe('audio/mpeg');
    expect(previewMime('audio', 'x.wav', 'WAVE')).toBe('audio/wav');
    expect(previewMime('audio', 'x.aif', 'AIFF')).toBe('audio/aiff');
    expect(previewMime('video', 'x.mp4', '????')).toBe('video/mp4');
    expect(previewMime('html', 'x.html', 'TEXT')).toBe('text/html');
    expect(previewMime('pdf', 'x.pdf', 'PDF ')).toBe('application/pdf');
  });
});
