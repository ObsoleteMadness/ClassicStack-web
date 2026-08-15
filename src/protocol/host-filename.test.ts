import { describe, expect, it } from 'vitest';
import { escapeHostFilename, unescapeHostFilename } from './host-filename';

describe('host-filename', () => {
  it('round-trips Icon\\r via Icon0x0D', () => {
    expect(escapeHostFilename('Icon\r')).toBe('Icon0x0D');
    expect(unescapeHostFilename('Icon0x0D')).toBe('Icon\r');
  });

  it('round-trips NTFS-illegal slash token', () => {
    expect(escapeHostFilename('Hello/World')).toBe('Hello0x2FWorld');
    expect(unescapeHostFilename('Hello0x2FWorld')).toBe('Hello/World');
  });

  it('leaves non-reserved 0xNN tokens literal', () => {
    expect(unescapeHostFilename('file0x41name')).toBe('file0x41name');
  });

  it('passes through ordinary names', () => {
    expect(unescapeHostFilename('Netscape Navigator™ 2.02')).toBe('Netscape Navigator™ 2.02');
  });
});
