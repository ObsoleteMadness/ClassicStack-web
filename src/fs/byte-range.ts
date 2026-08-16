/** Byte-range reads against a catalog file fork. No AFP types. */

export type ByteRangeReader = (offset: number, count: number) => Promise<Uint8Array>;

/** Open a backend, run `fn` with a live reader, then release it. */
export type RangeFill = (fn: (read: ByteRangeReader) => Promise<void>) => Promise<void>;

/** Ranged reader over an already-loaded buffer. Short reads at EOF. */
export function bufferRangeReader(bytes: Uint8Array): ByteRangeReader {
  return async (offset, count) => {
    if (count <= 0 || offset >= bytes.length) return new Uint8Array();
    const start = Math.max(0, offset);
    return bytes.subarray(start, Math.min(bytes.length, start + count));
  };
}

type Run = { off: number; data: Uint8Array };

/**
 * Virtual fork image: disjoint cached runs, filled from a ByteRangeReader
 * (or a later `RangeFill` session) when a missing range is accessed.
 */
export class SparseBytes {
  private runs: Run[] = [];
  private inner: ByteRangeReader | null;
  private fill: RangeFill | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(inner?: ByteRangeReader) {
    this.inner = inner ?? null;
  }

  static fromBuffer(bytes: Uint8Array): SparseBytes {
    const s = new SparseBytes();
    if (bytes.length) s.runs.push({ off: 0, data: bytes });
    return s;
  }

  bindInner(inner: ByteRangeReader | null): void {
    this.inner = inner;
  }

  bindFill(fill: RangeFill | null): void {
    this.fill = fill;
  }

  asReader(): ByteRangeReader {
    return (offset, count) => this.slice(offset, count);
  }

  /** High-water mark of cached bytes (full length when seeded from a buffer). */
  get length(): number {
    let m = 0;
    for (const r of this.runs) m = Math.max(m, r.off + r.data.length);
    return m;
  }

  has(offset: number, count: number): boolean {
    if (count <= 0) return true;
    const end = offset + count;
    let pos = offset;
    for (const r of this.runs) {
      const rEnd = r.off + r.data.length;
      if (rEnd <= pos) continue;
      if (r.off > pos) return false;
      pos = rEnd;
      if (pos >= end) return true;
    }
    return pos >= end;
  }

  peek(offset: number, count: number): Uint8Array | null {
    if (!this.has(offset, count)) return null;
    return this.copy(offset, count);
  }

  async slice(offset: number, count: number): Promise<Uint8Array> {
    if (count <= 0) return new Uint8Array();
    await this.ensure(offset, count);
    return this.copy(offset, count);
  }

  private copy(offset: number, count: number): Uint8Array {
    const end = offset + count;
    const out = new Uint8Array(count);
    let written = 0;
    for (const r of this.runs) {
      const rEnd = r.off + r.data.length;
      if (rEnd <= offset || r.off >= end) continue;
      const from = Math.max(offset, r.off);
      const to = Math.min(end, rEnd);
      out.set(r.data.subarray(from - r.off, to - r.off), from - offset);
      written = Math.max(written, to - offset);
    }
    return written < count ? out.subarray(0, written) : out;
  }

  private async ensure(offset: number, count: number): Promise<void> {
    const run = async () => {
      if (this.has(offset, count)) return;
      const fault = async (read: ByteRangeReader) => {
        for (const h of this.holes(offset, count)) {
          const got = await read(h.off, h.count);
          if (got.length) this.insert(h.off, got);
          if (got.length < h.count) break;
        }
      };
      if (this.inner) await fault(this.inner);
      else if (this.fill) await this.fill(fault);
    };
    const p = this.chain.then(run, run);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    await p;
  }

  private holes(offset: number, count: number): { off: number; count: number }[] {
    const end = offset + count;
    const gaps: { off: number; count: number }[] = [];
    let pos = offset;
    for (const r of this.runs) {
      const rEnd = r.off + r.data.length;
      if (rEnd <= pos) continue;
      if (r.off >= end) break;
      if (r.off > pos) gaps.push({ off: pos, count: r.off - pos });
      pos = Math.max(pos, rEnd);
      if (pos >= end) return gaps;
    }
    if (pos < end) gaps.push({ off: pos, count: end - pos });
    return gaps;
  }

  private insert(off: number, data: Uint8Array): void {
    if (!data.length) return;
    let uStart = off;
    let uEnd = off + data.length;
    const overlap: Run[] = [];
    const keep: Run[] = [];
    for (const r of this.runs) {
      const rEnd = r.off + r.data.length;
      if (rEnd < uStart || r.off > uEnd) keep.push(r);
      else {
        overlap.push(r);
        uStart = Math.min(uStart, r.off);
        uEnd = Math.max(uEnd, rEnd);
      }
    }
    const buf = new Uint8Array(uEnd - uStart);
    for (const r of overlap) buf.set(r.data, r.off - uStart);
    buf.set(data, off - uStart);
    keep.push({ off: uStart, data: buf });
    keep.sort((a, b) => a.off - b.off);
    this.runs = keep;
  }
}
