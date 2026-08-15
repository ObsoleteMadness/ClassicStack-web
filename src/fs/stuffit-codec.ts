/** StuffIt decompressors ported from stuffit-rs / The Unarchiver. */

import { inflateSync } from 'fflate';
import {
  FIRST_CODE_LENGTHS,
  META_CODE_LENGTHS,
  META_CODES,
  OFFSET_CODE_LENGTHS,
  OFFSET_CODE_SIZES,
  RANDOMIZATION_TABLE,
  SECOND_CODE_LENGTHS,
} from './stuffit-tables';

const I32_MIN = -2147483648;
const ARITH_BITS = 26;
const ARITH_ONE = 1 << (ARITH_BITS - 1);
const ARITH_HALF = 1 << (ARITH_BITS - 2);

export class SitError extends Error {
  readonly code?: 'unsupported' | 'corrupt';
  constructor(message: string, code?: 'unsupported' | 'corrupt') {
    super(message);
    this.name = 'SitError';
    this.code = code;
  }
}

export class BitReader {
  private pos = 0;
  private bitBuf = 0n;
  private bitsInBuf = 0;

  constructor(private readonly data: Uint8Array) {}

  private fillBuf(): void {
    while (this.bitsInBuf <= 56 && this.pos < this.data.length) {
      this.bitBuf |= BigInt(this.data[this.pos]!) << BigInt(this.bitsInBuf);
      this.pos++;
      this.bitsInBuf += 8;
    }
  }

  readBitsLe(n: number): number {
    if (n === 0) return 0;
    this.fillBuf();
    const res = Number(this.bitBuf & ((1n << BigInt(n)) - 1n));
    const available = Math.min(n, this.bitsInBuf);
    this.bitBuf >>= BigInt(available);
    this.bitsInBuf -= available;
    return res;
  }

  readBitsLeChecked(n: number): number | null {
    if (n === 0) return 0;
    this.fillBuf();
    if (this.bitsInBuf < n) return null;
    const res = Number(this.bitBuf & ((1n << BigInt(n)) - 1n));
    this.bitBuf >>= BigInt(n);
    this.bitsInBuf -= n;
    return res;
  }

  skipBitsLe(n: number): boolean {
    let left = n;
    while (left > 0) {
      this.fillBuf();
      if (this.bitsInBuf === 0) return false;
      const take = Math.min(left, this.bitsInBuf);
      this.bitBuf >>= BigInt(take);
      this.bitsInBuf -= take;
      left -= take;
    }
    return true;
  }

  /** Discard leftover bits in the current byte (xadIOByteBoundary). */
  byteAlign(): void {
    const extra = this.bitsInBuf % 8;
    if (extra) this.skipBitsLe(extra);
  }

  readBitLe(): boolean {
    return this.readBitsLe(1) !== 0;
  }

  readBitBe(): boolean {
    if (this.bitsInBuf === 0) {
      if (this.pos < this.data.length) {
        this.bitBuf = BigInt(this.data[this.pos]!);
        this.pos++;
        this.bitsInBuf = 8;
      } else {
        return false;
      }
    }
    const res = (this.bitBuf & (1n << BigInt(this.bitsInBuf - 1))) !== 0n;
    this.bitsInBuf--;
    return res;
  }

  readByte(): number | null {
    const v = this.readBitsLeChecked(8);
    return v === null ? null : v;
  }
}

class HuffmanDecoder {
  constructor(readonly tree: number[][]) {}

  static fromLengths(lengths: readonly number[], numSymbols: number): HuffmanDecoder {
    const tree: number[][] = [[I32_MIN, I32_MIN]];
    let code = 0;
    for (let length = 1; length <= 32; length++) {
      for (let i = 0; i < numSymbols; i++) {
        if (lengths[i] !== length) continue;
        let node = 0;
        for (let bitPos = length - 1; bitPos >= 0; bitPos--) {
          const bit = (code >>> bitPos) & 1;
          if (tree[node]![bit] === I32_MIN) {
            tree[node]![bit] = tree.length;
            tree.push([I32_MIN, I32_MIN]);
          }
          node = tree[node]![bit]!;
        }
        tree[node]![0] = i;
        tree[node]![1] = i;
        code++;
      }
      code <<= 1;
    }
    return new HuffmanDecoder(tree);
  }

  static fromExplicitCodes(
    codes: readonly number[],
    lengths: readonly number[],
    numSymbols: number,
  ): HuffmanDecoder {
    const tree: number[][] = [[I32_MIN, I32_MIN]];
    for (let i = 0; i < numSymbols; i++) {
      const length = lengths[i]!;
      if (length <= 0) continue;
      const code = codes[i]!;
      let node = 0;
      for (let bitPos = 0; bitPos < length; bitPos++) {
        const bit = (code >>> bitPos) & 1;
        if (tree[node]![bit] === I32_MIN) {
          tree[node]![bit] = tree.length;
          tree.push([I32_MIN, I32_MIN]);
        }
        node = tree[node]![bit]!;
      }
      tree[node]![0] = i;
      tree[node]![1] = i;
    }
    return new HuffmanDecoder(tree);
  }

  decodeLe(reader: BitReader): number {
    let node = 0;
    for (;;) {
      const row = this.tree[node]!;
      if (row[0] === row[1]) return row[0]!;
      const bit = reader.readBitsLe(1);
      const next = row[bit];
      if (next === undefined || next === I32_MIN) return -1;
      node = next;
    }
  }
}

function allocAndParseHuffmanCode(
  reader: BitReader,
  numCodes: number,
  metacode: HuffmanDecoder,
): HuffmanDecoder {
  const lengths = new Array<number>(numCodes).fill(0);
  let length = 0;
  let i = 0;
  while (i < numCodes) {
    const val = metacode.decodeLe(reader);
    if (val < 0) throw new SitError('Invalid meta code');
    switch (val) {
      case 31:
        length = -1;
        break;
      case 32:
        length += 1;
        break;
      case 33:
        length -= 1;
        break;
      case 34:
        if (reader.readBitLe()) {
          lengths[i] = length;
          i++;
        }
        break;
      case 35: {
        let count = reader.readBitsLe(3) + 2;
        while (count > 0 && i < numCodes) {
          lengths[i] = length;
          i++;
          count--;
        }
        break;
      }
      case 36: {
        let count = reader.readBitsLe(6) + 10;
        while (count > 0 && i < numCodes) {
          lengths[i] = length;
          i++;
          count--;
        }
        break;
      }
      default:
        length = val + 1;
        break;
    }
    if (i < numCodes) {
      lengths[i] = length;
      i++;
    }
  }
  return HuffmanDecoder.fromLengths(lengths, numCodes);
}

export function decompressRle(data: Uint8Array, uncompLen: number): Uint8Array {
  const output: number[] = [];
  let i = 0;
  while (i < data.length && output.length < uncompLen) {
    const b = data[i++]!;
    if (b !== 0x90) {
      output.push(b);
      continue;
    }
    if (i >= data.length) break;
    const count = data[i++]!;
    if (count === 0) {
      output.push(0x90);
      continue;
    }
    if (i >= data.length) break;
    const val = data[i++]!;
    for (let n = 0; n < count && output.length < uncompLen; n++) output.push(val);
  }
  return Uint8Array.from(output);
}

function decompressLzw(data: Uint8Array, uncompLen: number): Uint8Array {
  const reader = new BitReader(data);
  const initDict = (): Uint8Array[] => {
    const dict: Uint8Array[] = [];
    for (let i = 0; i < 256; i++) dict.push(Uint8Array.of(i));
    dict.push(new Uint8Array());
    return dict;
  };
  let dictionary = initDict();
  let codeSize = 9;
  let nextCode = 257;
  let codesInBlock = 0;
  const output: number[] = [];
  let oldCode: number | null = null;

  const resetBlock = (): boolean => {
    if (codesInBlock % 8 !== 0) {
      const padding = 8 - (codesInBlock % 8);
      if (!reader.skipBitsLe(codeSize * padding)) return false;
    }
    dictionary = initDict();
    codeSize = 9;
    nextCode = 257;
    codesInBlock = 0;
    return true;
  };

  while (output.length < uncompLen) {
    const code = reader.readBitsLeChecked(codeSize);
    if (code === null) break;
    codesInBlock++;
    if (code === 256) {
      if (!resetBlock()) break;
      oldCode = null;
      continue;
    }
    let current: Uint8Array;
    if (code < dictionary.length) {
      current = dictionary[code]!;
    } else if (code === nextCode) {
      if (oldCode === null) throw new SitError('LZW Error: First code is special');
      const seq = dictionary[oldCode]!;
      const ext = new Uint8Array(seq.length + 1);
      ext.set(seq);
      ext[seq.length] = seq[0]!;
      current = ext;
    } else {
      throw new SitError(`LZW Error: Invalid code ${code}`);
    }
    const remaining = uncompLen - output.length;
    if (current.length > remaining) {
      for (let i = 0; i < remaining; i++) output.push(current[i]!);
      break;
    }
    for (let i = 0; i < current.length; i++) output.push(current[i]!);
    if (oldCode !== null) {
      const prev = dictionary[oldCode]!;
      const neu = new Uint8Array(prev.length + 1);
      neu.set(prev);
      neu[prev.length] = current[0]!;
      if (dictionary.length < 16384) {
        dictionary.push(neu);
        nextCode++;
        if ((nextCode & (nextCode - 1)) === 0 && nextCode < 16384 && codeSize < 14) {
          codeSize++;
        }
      }
    }
    oldCode = code;
  }
  return Uint8Array.from(output);
}

function decompressHuffman(data: Uint8Array, uncompLen: number): Uint8Array {
  const reader = new BitReader(data);
  const tree: number[][] = [[I32_MIN, I32_MIN]];
  const parseTree = (node: number): void => {
    if (tree.length > 512) return;
    if (reader.readBitBe()) {
      let sym = 0;
      for (let i = 0; i < 8; i++) sym = (sym << 1) | (reader.readBitBe() ? 1 : 0);
      tree[node]![0] = sym;
      tree[node]![1] = sym;
      return;
    }
    const left = tree.length;
    tree[node]![0] = left;
    tree.push([I32_MIN, I32_MIN]);
    parseTree(left);
    const right = tree.length;
    tree[node]![1] = right;
    tree.push([I32_MIN, I32_MIN]);
    parseTree(right);
  };
  parseTree(0);
  const decodeBe = (): number => {
    let node = 0;
    for (;;) {
      const row = tree[node]!;
      if (row[0] === row[1]) return row[0]!;
      const next = row[reader.readBitBe() ? 1 : 0]!;
      if (next < 0 || next >= tree.length) return -1;
      node = next;
    }
  };
  const output: number[] = [];
  while (output.length < uncompLen) {
    const val = decodeBe();
    if (val < 0) break;
    output.push(val);
  }
  return Uint8Array.from(output);
}

export function decompressSit13(data: Uint8Array, uncompLen: number): Uint8Array {
  const reader = new BitReader(data);
  if (uncompLen === 0) return new Uint8Array();
  const firstByte = reader.readByte();
  if (firstByte === null) throw new SitError('Unexpected end of SIT13 stream');
  const code = firstByte >> 4;
  let first: HuffmanDecoder;
  let second: HuffmanDecoder;
  let offset: HuffmanDecoder;
  if (code === 0) {
    const metacode = HuffmanDecoder.fromExplicitCodes(META_CODES, META_CODE_LENGTHS, 37);
    first = allocAndParseHuffmanCode(reader, 321, metacode);
    second = (firstByte & 0x08) !== 0 ? first : allocAndParseHuffmanCode(reader, 321, metacode);
    const offsetSize = (firstByte & 0x07) + 10;
    offset = allocAndParseHuffmanCode(reader, offsetSize, metacode);
  } else if (code < 6) {
    const idx = code - 1;
    first = HuffmanDecoder.fromLengths(FIRST_CODE_LENGTHS[idx]!, 321);
    second = HuffmanDecoder.fromLengths(SECOND_CODE_LENGTHS[idx]!, 321);
    offset = HuffmanDecoder.fromLengths(OFFSET_CODE_LENGTHS[idx]!, OFFSET_CODE_SIZES[idx]!);
  } else {
    throw new SitError(`Invalid SIT13 code: ${code}`);
  }

  const output: number[] = [];
  let current = first;
  while (output.length < uncompLen) {
    const val = current.decodeLe(reader);
    if (val < 0) break;
    if (val < 256) {
      output.push(val);
      current = first;
    } else if (val < 320) {
      current = second;
      let length = val - 256 + 3;
      if (val === 318) length = reader.readBitsLe(10) + 65;
      else if (val === 319) length = reader.readBitsLe(15) + 65;
      const bitLen = offset.decodeLe(reader);
      if (bitLen < 0) break;
      let dist: number;
      if (bitLen === 0) dist = 1;
      else if (bitLen === 1) dist = 2;
      else dist = (1 << (bitLen - 1)) + reader.readBitsLe(bitLen - 1) + 1;
      if (dist > output.length) break;
      for (let n = 0; n < length && output.length < uncompLen; n++) {
        output.push(output[output.length - dist]!);
      }
    } else {
      break;
    }
  }
  return Uint8Array.from(output);
}

class ArithmeticModel {
  frequencies: number[];
  totalFrequency: number;

  constructor(
    readonly firstSymbol: number,
    readonly numSymbols: number,
    readonly increment: number,
    readonly limit: number,
  ) {
    this.frequencies = new Array(numSymbols).fill(increment);
    this.totalFrequency = numSymbols * increment;
  }

  reset(): void {
    this.totalFrequency = this.numSymbols * this.increment;
    this.frequencies.fill(this.increment);
  }

  update(symIdx: number): void {
    this.frequencies[symIdx]! += this.increment;
    this.totalFrequency += this.increment;
    if (this.totalFrequency > this.limit) {
      this.totalFrequency = 0;
      for (let i = 0; i < this.frequencies.length; i++) {
        this.frequencies[i] = (this.frequencies[i]! + 1) >>> 1;
        this.totalFrequency += this.frequencies[i]!;
      }
    }
  }
}

class ArithmeticDecoder {
  range = ARITH_ONE;
  code = 0;

  constructor(private readonly reader: BitReader) {
    let code = 0;
    for (let i = 0; i < ARITH_BITS; i++) {
      code = (code << 1) | (reader.readBitBe() ? 1 : 0);
    }
    this.code = code >>> 0;
  }

  nextSymbol(model: ArithmeticModel): number {
    const freq = Math.floor(this.code / Math.floor(this.range / model.totalFrequency));
    let cumulative = 0;
    let n = 0;
    while (n < model.numSymbols - 1) {
      if (cumulative + model.frequencies[n]! > freq) break;
      cumulative += model.frequencies[n]!;
      n++;
    }
    const symSize = model.frequencies[n]!;
    const symTot = model.totalFrequency;
    const renorm = Math.floor(this.range / symTot);
    const lowIncr = renorm * cumulative;
    this.code = (this.code - lowIncr) >>> 0;
    if (cumulative + symSize === symTot) this.range = (this.range - lowIncr) >>> 0;
    else this.range = (symSize * renorm) >>> 0;
    while (this.range <= ARITH_HALF) {
      this.range = (this.range << 1) >>> 0;
      this.code = ((this.code << 1) | (this.reader.readBitBe() ? 1 : 0)) >>> 0;
    }
    const res = model.firstSymbol + n;
    model.update(n);
    return res;
  }

  readBitString(model: ArithmeticModel, n: number): number {
    let res = 0;
    for (let i = 0; i < n; i++) {
      if (this.nextSymbol(model) !== 0) res |= 1 << i;
    }
    return res >>> 0;
  }
}

function decompressArsenic(data: Uint8Array, uncompLen: number): Uint8Array {
  const decoder = new ArithmeticDecoder(new BitReader(data));
  const initial = new ArithmeticModel(0, 2, 1, 256);
  if (decoder.readBitString(initial, 8) !== 0x41) throw new SitError('Invalid Arsenic signature (A)');
  if (decoder.readBitString(initial, 8) !== 0x73) throw new SitError('Invalid Arsenic signature (s)');
  const blockBits = decoder.readBitString(initial, 4) + 9;
  const selector = new ArithmeticModel(0, 11, 8, 1024);
  const mtfModels = [
    new ArithmeticModel(2, 2, 8, 1024),
    new ArithmeticModel(4, 4, 4, 1024),
    new ArithmeticModel(8, 8, 4, 1024),
    new ArithmeticModel(16, 16, 4, 1024),
    new ArithmeticModel(32, 32, 2, 1024),
    new ArithmeticModel(64, 64, 2, 1024),
    new ArithmeticModel(128, 128, 1, 1024),
  ];
  const output: number[] = [];
  while (output.length < uncompLen) {
    if (decoder.nextSymbol(initial) !== 0) break;
    const randomized = decoder.nextSymbol(initial) !== 0;
    const transformIndexStart = decoder.readBitString(initial, blockBits);
    const block: number[] = [];
    const mtf: number[] = [];
    for (let i = 0; i <= 255; i++) mtf.push(i);
    for (;;) {
      const sel = decoder.nextSymbol(selector);
      if (sel <= 1) {
        let zeroState = 1;
        let zeroCount = 0;
        let currentSel = sel;
        while (currentSel < 2) {
          zeroCount += currentSel === 0 ? zeroState : 2 * zeroState;
          zeroState *= 2;
          currentSel = decoder.nextSymbol(selector);
        }
        const sym = mtf[0]!;
        for (let z = 0; z < zeroCount; z++) block.push(sym);
        if (currentSel === 10) break;
        const symbol =
          currentSel === 2 ? 1 : decoder.nextSymbol(mtfModels[currentSel - 3]!);
        const val = mtf.splice(symbol, 1)[0]!;
        mtf.unshift(val);
        block.push(val);
      } else if (sel === 10) {
        break;
      } else {
        const symbol = sel === 2 ? 1 : decoder.nextSymbol(mtfModels[sel - 3]!);
        const val = mtf.splice(symbol, 1)[0]!;
        mtf.unshift(val);
        block.push(val);
      }
    }
    if (transformIndexStart >= block.length) break;
    selector.reset();
    for (const m of mtfModels) m.reset();
    const counts = new Array<number>(256).fill(0);
    for (const b of block) counts[b]!++;
    const startPos = new Array<number>(256).fill(0);
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      startPos[i] = sum;
      sum += counts[i]!;
    }
    const transform = new Array<number>(block.length);
    const cur = startPos.slice();
    for (let i = 0; i < block.length; i++) {
      const b = block[i]!;
      transform[cur[b]!] = i;
      cur[b]!++;
    }
    let byteCount = 0;
    let idx = transformIndexStart;
    let count = 0;
    let last = 0;
    let repeat = 0;
    let randIdx = 0;
    let randVal = RANDOMIZATION_TABLE[0]!;
    while ((byteCount < block.length || repeat > 0) && output.length < uncompLen) {
      if (repeat > 0) {
        output.push(last);
        repeat--;
        continue;
      }
      idx = transform[idx]!;
      let b = block[idx]!;
      if (randomized && randVal === byteCount) {
        b ^= 1;
        randIdx = (randIdx + 1) & 255;
        randVal += RANDOMIZATION_TABLE[randIdx]!;
      }
      byteCount++;
      if (count === 4) {
        count = 0;
        if (b === 0) continue;
        repeat = b - 1;
        output.push(last);
      } else {
        if (b === last) count++;
        else {
          count = 1;
          last = b;
        }
        output.push(b);
      }
    }
  }
  return Uint8Array.from(output);
}

/**
 * Classic method 14 ("Installer") from Unarchiver XADStuffItOldHandles SIT_14.
 * Used by STxx installer archives (ST42, ST46, …).
 */
function decompressSit14(data: Uint8Array, uncompLen: number): Uint8Array {
  const reader = new BitReader(data);
  const bits = (n: number): number => reader.readBitsLe(n) >>> 0;
  const code = new Uint8Array(308);
  const codecopy = new Uint8Array(308);
  const freq = new Uint16Array(308);
  const buff = new Uint32Array(308);
  const var1 = new Uint8Array(52);
  const var2 = new Uint16Array(52);
  const var3 = new Uint16Array(75 * 2);
  const var4 = new Uint8Array(76);
  const var5 = new Uint32Array(75);
  const var7 = new Uint16Array(308 * 2);
  const window = new Uint8Array(0x40000);

  const update = (first0: number, last0: number): void => {
    let first = first0;
    let last = last0;
    while (last - first > 1) {
      let i = first;
      let j = last;
      do {
        while (++i < last && codecopy[first]! > codecopy[i]!) {}
        while (--j > first && codecopy[first]! < codecopy[j]!) {}
        if (j > i) {
          const tc = codecopy[i]!;
          codecopy[i] = codecopy[j]!;
          codecopy[j] = tc;
          const tf = freq[i]!;
          freq[i] = freq[j]!;
          freq[j] = tf;
        }
      } while (j > i);
      if (first !== j) {
        const tc = codecopy[first]!;
        codecopy[first] = codecopy[j]!;
        codecopy[j] = tc;
        const tf = freq[first]!;
        freq[first] = freq[j]!;
        freq[j] = tf;
        i = j + 1;
        if (last - i <= j - first) {
          update(i, last);
          last = j;
        } else {
          update(first, j);
          first = i;
        }
      } else {
        ++first;
      }
    }
  };

  const readTree = (codesize: number, result: Uint16Array): void => {
    let k = bits(1);
    const jBits = bits(2) + 2;
    const o = bits(3) + 1;
    const size = 1 << jBits;
    const m = size - 1;
    k = k ? m - 1 : 0xffffffff;
    if (bits(2) & 1) {
      readTree(size, freq);
      for (let i = 0; i < codesize; ) {
        let l = 0;
        let n: number;
        do {
          l = freq[l + bits(1)]!;
          n = size << 1;
        } while (n > l);
        l -= n;
        if (k !== l) {
          if (l === m) {
            l = 0;
            do {
              l = freq[l + bits(1)]!;
              n = size << 1;
            } while (n > l);
            l += 3 - n;
            while (l--) {
              if (i === 0 || i >= codesize) break;
              code[i] = code[i - 1]!;
              ++i;
            }
          } else {
            code[i++] = (l + o) & 0xff;
          }
        } else {
          code[i++] = 0;
        }
      }
    } else {
      for (let i = 0; i < codesize; ) {
        let l = bits(jBits);
        if (k !== l) {
          if (l === m) {
            l = bits(jBits) + 3;
            while (l--) {
              if (i === 0 || i >= codesize) break;
              code[i] = code[i - 1]!;
              ++i;
            }
          } else {
            code[i++] = (l + o) & 0xff;
          }
        } else {
          code[i++] = 0;
        }
      }
    }

    for (let i = 0; i < codesize; i++) {
      codecopy[i] = code[i]!;
      freq[i] = i;
    }
    update(0, codesize);

    let i = 0;
    while (i < codesize && !codecopy[i]) i++;
    for (let j = 0; i < codesize; i++, j++) {
      if (i) j <<= codecopy[i]! - codecopy[i - 1]!;
      let kk = codecopy[i]!;
      let mm = 0;
      for (let l = j; kk--; l >>= 1) mm = (mm << 1) | (l & 1);
      buff[freq[i]!] = mm >>> 0;
    }

    result.fill(0, 0, codesize * 2);
    let node = 2;
    for (let si = 0; si < codesize; si++) {
      let l = 0;
      let mm = buff[si]!;
      for (let kk = 0; kk < code[si]!; kk++) {
        l += mm & 1;
        if (code[si]! - 1 <= kk) result[l] = codesize * 2 + si;
        else {
          if (!result[l]) {
            result[l] = node;
            node += 2;
          }
          l = result[l]!;
        }
        mm >>= 1;
      }
    }
    reader.byteAlign();
  };

  let acc = 0;
  for (let i = 0; i < 52; i++) {
    var2[i] = acc;
    var1[i] = i >= 4 ? (i - 4) >> 2 : 0;
    acc += 1 << var1[i]!;
  }
  acc = 1;
  for (let i = 0; i < 75; i++) {
    var5[i] = acc;
    var4[i] = i >= 3 ? (i - 3) >> 2 : 0;
    acc += 1 << var4[i]!;
  }

  const output: number[] = [];
  let blocks = bits(16);
  let wp = 0;
  while (blocks-- && output.length < uncompLen) {
    bits(16);
    bits(16);
    let remain = bits(16) | (bits(16) << 16);
    readTree(308, var7);
    readTree(75, var3);
    while (remain && output.length < uncompLen) {
      let i = 0;
      while (i < 616) i = var7[i + bits(1)]!;
      i -= 616;
      if (i < 0x100) {
        window[wp++] = i;
        wp &= 0x3ffff;
        output.push(i);
        remain--;
      } else {
        i -= 0x100;
        let matchLen = var2[i]! + 4;
        const extra = var1[i]!;
        if (extra) matchLen += bits(extra);
        i = 0;
        while (i < 150) i = var3[i + bits(1)]!;
        i -= 150;
        let dist = var5[i]!;
        const dExtra = var4[i]!;
        if (dExtra) dist += bits(dExtra);
        remain -= matchLen;
        dist = wp + 0x40000 - dist;
        while (matchLen-- && output.length < uncompLen) {
          dist &= 0x3ffff;
          const b = window[dist++]!;
          window[wp++] = b;
          wp &= 0x3ffff;
          output.push(b);
        }
      }
    }
    reader.byteAlign();
  }
  return Uint8Array.from(output.length > uncompLen ? output.slice(0, uncompLen) : output);
}

function decompressDeflate(data: Uint8Array, uncompLen: number): Uint8Array {
  try {
    const out = inflateSync(data, { out: new Uint8Array(Math.max(uncompLen, 1)) });
    return uncompLen > 0 && out.length > uncompLen ? out.subarray(0, uncompLen) : out;
  } catch (err) {
    throw new SitError(`Deflate: ${err instanceof Error ? err.message : err}`);
  }
}

export function decompressSit5(data: Uint8Array, method: number, uncompLen: number): Uint8Array {
  if (data.length === 0 || uncompLen === 0) return new Uint8Array();
  switch (method) {
    case 0:
      return data.slice(0, uncompLen);
    case 13:
      return decompressSit13(data, uncompLen);
    case 14:
      return decompressDeflate(data, uncompLen);
    case 15:
      return decompressArsenic(data, uncompLen);
    default:
      throw new SitError(`Unsupported type ${method}`, 'unsupported');
  }
}

export function decompressClassic(data: Uint8Array, method: number, uncompLen: number): Uint8Array {
  if (data.length === 0 || uncompLen === 0) return new Uint8Array();
  switch (method & 0x0f) {
    case 0:
      return data.slice(0, uncompLen);
    case 1:
      return decompressRle(data, uncompLen);
    case 2:
      return decompressLzw(data, uncompLen);
    case 3:
      return decompressHuffman(data, uncompLen);
    case 13:
      return decompressSit13(data, uncompLen);
    case 14:
      return decompressSit14(data, uncompLen);
    default:
      throw new SitError(`Unsupported type ${method & 0x0f}`, 'unsupported');
  }
}
