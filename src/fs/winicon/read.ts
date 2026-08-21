/** Range-read helpers for PE / NE / ICO parsers. */

import type { ByteRangeReader } from '../byte-range';

const MAX_SLICE = 8 * 1024 * 1024;

export async function readSlice(
  read: ByteRangeReader,
  offset: number,
  count: number,
): Promise<Uint8Array> {
  if (count <= 0 || offset < 0) return new Uint8Array();
  const n = Math.min(count, MAX_SLICE);
  const got = await read(offset, n);
  return got.length <= n ? got : got.subarray(0, n);
}

export async function readExact(
  read: ByteRangeReader,
  offset: number,
  count: number,
): Promise<Uint8Array | null> {
  const got = await readSlice(read, offset, count);
  return got.length >= count ? got.subarray(0, count) : null;
}
