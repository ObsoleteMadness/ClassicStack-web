/**
 * Apple PackBits (TIFF PackBits / IFF ByteRun1), as used by PICT PackBitsRect
 * and DirectBitsRect packType 3/4. See Inside Macintosh: Imaging With QuickDraw §A-5.
 *
 * Flag byte n as signed:
 *   0..127   copy the next n+1 units literally
 *   -127..-1 repeat the next unit (1-n) times
 *   -128     NOP
 *
 * `unitBytes` is 1 for indexed/24-bit component rows and 2 for 16-bit pixels.
 */

export function decodePackBits(src: Uint8Array, expectedBytes: number, unitBytes = 1): Uint8Array {
  const out = new Uint8Array(expectedBytes);
  const unitsNeeded = Math.floor(expectedBytes / unitBytes);
  let si = 0;
  let written = 0;
  while (written < unitsNeeded) {
    if (si >= src.length) break;
    const flag = (src[si]! << 24) >> 24;
    si += 1;
    if (flag >= 0) {
      const n = flag + 1;
      const take = Math.min(n, unitsNeeded - written);
      const byteCount = take * unitBytes;
      if (si + byteCount > src.length) {
        out.set(src.subarray(si, src.length), written * unitBytes);
        break;
      }
      out.set(src.subarray(si, si + byteCount), written * unitBytes);
      si += n * unitBytes;
      written += take;
    } else if (flag === -128) {
      continue;
    } else {
      const n = 1 - flag;
      if (si + unitBytes > src.length) break;
      const take = Math.min(n, unitsNeeded - written);
      if (unitBytes === 1) {
        out.fill(src[si]!, written, written + take);
      } else {
        for (let i = 0; i < take; i++) {
          const d = (written + i) * unitBytes;
          for (let b = 0; b < unitBytes; b++) out[d + b] = src[si + b]!;
        }
      }
      si += unitBytes;
      written += take;
    }
  }
  return out;
}

/** Greedy PackBits encoder used by tests (and for building synthetic PICTs). */
export function encodePackBits(src: Uint8Array, unitBytes = 1): Uint8Array {
  if (unitBytes !== 1 && unitBytes !== 2) throw new Error('unitBytes must be 1 or 2');
  if (src.length % unitBytes !== 0) throw new Error('source length not a multiple of unitBytes');
  const units = src.length / unitBytes;
  const out: number[] = [];
  let i = 0;

  const unitEq = (a: number, b: number): boolean => {
    for (let k = 0; k < unitBytes; k++) if (src[a * unitBytes + k] !== src[b * unitBytes + k]) return false;
    return true;
  };
  const emitRun = (start: number, count: number): void => {
    out.push((1 - count) & 0xff);
    for (let k = 0; k < unitBytes; k++) out.push(src[start * unitBytes + k]!);
  };
  const emitRaw = (start: number, count: number): void => {
    out.push(count - 1);
    out.push(...src.subarray(start * unitBytes, (start + count) * unitBytes));
  };

  while (i < units) {
    let run = 1;
    while (run < 128 && i + run < units && unitEq(i, i + run)) run++;
    if (run >= 3) {
      emitRun(i, run);
      i += run;
      continue;
    }
    let raw = 1;
    while (raw < 128 && i + raw < units) {
      const s = i + raw;
      if (s + 2 < units && unitEq(s, s + 1) && unitEq(s, s + 2)) break;
      raw++;
    }
    emitRaw(i, raw);
    i += raw;
  }
  return Uint8Array.from(out);
}
