import { describe, expect, it } from 'vitest';
import { writeLe16, writeLe32 } from '../../protocol/binary';
import { decodeStringTable, decodeVersionInfo } from './decode-res';

function utf16z(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c & 0xff, (c >> 8) & 0xff);
  }
  out.push(0, 0);
  return out;
}

describe('Win resource decoders', () => {
  it('reads FileVersion from VS_FIXEDFILEINFO', () => {
    const hdr: number[] = [0, 0, 52, 0, 0, 0, ...utf16z('VS_VERSION_INFO')];
    while (hdr.length % 4) hdr.push(0);
    const ffi = new Uint8Array(52);
    writeLe32(ffi, 0, 0xfeef04bd);
    writeLe32(ffi, 8, (1 << 16) | 2);
    writeLe32(ffi, 12, (3 << 16) | 4);
    writeLe32(ffi, 16, (5 << 16) | 6);
    writeLe32(ffi, 20, (7 << 16) | 8);
    const buf = new Uint8Array(hdr.length + ffi.length);
    buf.set(hdr);
    buf.set(ffi, hdr.length);
    writeLe16(buf, 0, buf.length);
    const fields = decodeVersionInfo(buf);
    expect(fields.some((f) => f.key === 'FileVersion' && f.value === '1.2.3.4')).toBe(true);
    expect(fields.some((f) => f.key === 'ProductVersion' && f.value === '5.6.7.8')).toBe(true);
  });

  it('lets StringFileInfo values replace the binary FileVersion', () => {
    const hdr: number[] = [0, 0, 52, 0, 0, 0, ...utf16z('VS_VERSION_INFO')];
    while (hdr.length % 4) hdr.push(0);
    const ffi = new Uint8Array(52);
    writeLe32(ffi, 0, 0xfeef04bd);
    writeLe32(ffi, 8, (1 << 16) | 0);
    writeLe32(ffi, 12, 0);
    const strKey = utf16z('FileVersion');
    const strVal = utf16z('1.00');
    const str: number[] = [0, 0, strVal.length / 2, 0, 1, 0, ...strKey];
    while (str.length % 4) str.push(0);
    str.push(...strVal);
    while (str.length % 4) str.push(0);
    str[0] = str.length & 0xff;
    str[1] = (str.length >> 8) & 0xff;
    const buf = new Uint8Array(hdr.length + ffi.length + str.length);
    buf.set(hdr);
    buf.set(ffi, hdr.length);
    buf.set(str, hdr.length + ffi.length);
    writeLe16(buf, 0, buf.length);
    const fields = decodeVersionInfo(buf);
    expect(fields.find((f) => f.key === 'FileVersion')?.value).toBe('1.00');
  });

  it('reads a string-table block', () => {
    const bytes = new Uint8Array(2 + 5 * 2 + 15 * 2);
    writeLe16(bytes, 0, 5);
    const hello = 'Hello';
    for (let i = 0; i < hello.length; i++) writeLe16(bytes, 2 + i * 2, hello.charCodeAt(i));
    expect(decodeStringTable(bytes, 1)).toEqual([{ index: 0, text: 'Hello' }]);
  });
});
