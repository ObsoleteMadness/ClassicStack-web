/** Byte-range reads against a catalog file fork. No AFP types. */

export type ByteRangeReader = (offset: number, count: number) => Promise<Uint8Array>;

/** Ranged reader over an already-loaded buffer. Short reads at EOF. */
export function bufferRangeReader(bytes: Uint8Array): ByteRangeReader {
  return async (offset, count) => {
    if (count <= 0 || offset >= bytes.length) return new Uint8Array();
    const start = Math.max(0, offset);
    return bytes.subarray(start, Math.min(bytes.length, start + count));
  };
}
