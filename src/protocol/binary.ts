/** Big-endian binary helpers (mirrors ClassicStack binaryprimitives). */

export function be16(b: Uint8Array, o = 0): number {
  return ((b[o]! << 8) | b[o + 1]!) >>> 0;
}

/** Little-endian uint16 (PE / NE / ICO / ZIP). */
export function le16(b: Uint8Array, o = 0): number {
  return (b[o]! | (b[o + 1]! << 8)) >>> 0;
}

/** Little-endian uint32 (PE / NE / ICO / ZIP). */
export function le32(b: Uint8Array, o = 0): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

export function writeLe16(dst: Uint8Array, o: number, v: number): void {
  dst[o] = v & 0xff;
  dst[o + 1] = (v >>> 8) & 0xff;
}

export function writeLe32(dst: Uint8Array, o: number, v: number): void {
  dst[o] = v & 0xff;
  dst[o + 1] = (v >>> 8) & 0xff;
  dst[o + 2] = (v >>> 16) & 0xff;
  dst[o + 3] = (v >>> 24) & 0xff;
}

export function appendLe16(dst: number[], v: number): void {
  dst.push(v & 0xff, (v >>> 8) & 0xff);
}

export function appendLe32(dst: number[], v: number): void {
  dst.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

export function be32(b: Uint8Array, o = 0): number {
  return (
    ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
  );
}

export function writeBe16(dst: Uint8Array, o: number, v: number): void {
  dst[o] = (v >>> 8) & 0xff;
  dst[o + 1] = v & 0xff;
}

export function writeBe32(dst: Uint8Array, o: number, v: number): void {
  dst[o] = (v >>> 24) & 0xff;
  dst[o + 1] = (v >>> 16) & 0xff;
  dst[o + 2] = (v >>> 8) & 0xff;
  dst[o + 3] = v & 0xff;
}

export function appendBe16(dst: number[], v: number): void {
  dst.push((v >>> 8) & 0xff, v & 0xff);
}

export function appendBe32(dst: number[], v: number): void {
  dst.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Signed int32 from big-endian bytes (AFP/ASP result codes). */
export function be32s(b: Uint8Array, o = 0): number {
  return (be32(b, o) << 0) >> 0;
}

export function u32ToI32(v: number): number {
  return (v << 0) >> 0;
}
