/**
 * Apple compressed-resource decompressors ('dcmp' 0/1/2).
 * Port of https://github.com/dgelessus/python-rsrcfork/tree/master/src/rsrcfork/compress
 */

import { be16, be32s, concat } from '../protocol/binary';

/** Resource attribute bit: data is compressed (KSFL / ResEdit extended header). */
export const RES_COMPRESSED = 1 << 0;

const SIGNATURE = new Uint8Array([0xa8, 0x9f, 0x65, 0x72]);
const TYPE_8 = 0x0801;
const TYPE_9 = 0x0901;
const HEADER_SIZE = 18;

const DCMP0_TABLE = tablePairs(
  '00004eba00084e75000c4ead20532f0b6100001070002f00486e2050206e2f2efffc48e73f3c0004fff82f0c20064eed4e5620684e5e0001588f4fef000200186000ffff508f4e900006266e0014fff44cee000a000e41ee4cdf48c0fff02d400012302e70012f28205467000020001c205f1800266f4878001641fa303c28407200286e200c6600206b2f07558f0028fffeffec22d8200b000f598f2f3cff00011881e14a004eb0ffe848c7000300220007001a670667084ef90024207808006604002a4ed03028265f6704003043ee3f00201f001efff6202e42a72007fffa60023d400c40660600262d482f0170ff600418804a400040002c2f080011ffe421402640fff2426e4eb93d7c0038000d6006422e203c670c2d6866084a2e4aae002e4840225f2200670a30074267003220280009487a02002f2b0005226e6602e580670e660a00503e00660c2e00ffee206d2040ffe053406008048000680b7c440041e84841',
);
const DCMP1_TABLE = tablePairs(
  '00000001000200032e013e0101011e01ffff0e0131001112010733321239ed1001272322013707060117012300ff002f070efd3c0135011501020007003e05d50201060707083001013300101716373e3637',
);
const DCMP2_TABLE = tablePairs(
  '000000084eba206e4e75000c0004700000100002486efffc6000000148e72f2e4e5600064e5e2f006100fff82f0bffff0014000a0018205f000e20503f3cfff44cee302e67004cdf266e0012001c4267fff0303c2f0c00034ed00020700100162d4048c020787200588f66004fef42a76706fffa558f286e3f00fffe2f3c6704598f206b0024201f41fa81e166046708001a4eb9508f202e00074eb0fff23d40001e20686606fff64ef908000c403d7cffec0005203cffe8defc4a2e003000282f08200b6002426e2d48205320401800600441ee2f282f01670a48402007660801182f0730283f2e302b226e2f2b002c670c225f600600ff3007ffee53400040ffe44a40660a000f4ead70ff22d8486b0022204b670e4aae4e90ffe0ffc0002a2740670251c802b6487a2278b06effe60009322e3e004841ffea43ee4e7174002f2c206c003c002600501880301f2200660cffda00386602302c200c2d6e4240ffe2a9f0ff00377ce580ffdc4868594f00343e1f60082f06ffde600a70020032ffcc00802251101f317ca029ffd8524001006710a023ffceffd420064878002e504f43fa6712760041e84a6e20d9005a7fff51ca005c2e00024048c767140c802e9fffd68000100048424a6bffd200484a474ed1206f0041600c2a78422e3200657467160044486d2008486c0b7c264004000068206d000d2a40000b003e0220',
);

export class DecompressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecompressError';
  }
}

export function looksCompressed(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === SIGNATURE[0] &&
    data[1] === SIGNATURE[1] &&
    data[2] === SIGNATURE[2] &&
    data[3] === SIGNATURE[3]
  );
}

export function isCompressedResource(data: Uint8Array, attributes: number): boolean {
  return (attributes & RES_COMPRESSED) !== 0 || looksCompressed(data) || signaturePrefix(data);
}

function signaturePrefix(data: Uint8Array): boolean {
  if (data.length === 0 || data.length >= 4) return false;
  for (let i = 0; i < data.length; i++) if (data[i] !== SIGNATURE[i]) return false;
  return true;
}

/** Decompress if this looks like a compressed resource; otherwise return `data`. */
export function maybeDecompressResource(data: Uint8Array, attributes = 0): Uint8Array {
  if (!isCompressedResource(data, attributes)) return data;
  try {
    return decompressResource(data);
  } catch {
    return data;
  }
}

export function decompressResource(data: Uint8Array): Uint8Array {
  const header = parseHeader(data);
  const body = data.subarray(header.headerLength || HEADER_SIZE);
  let out: Uint8Array;
  if (header.dcmpId === 0) out = decompressDcmp0(header, body);
  else if (header.dcmpId === 1) out = decompressDcmp1(header, body);
  else if (header.dcmpId === 2) out = decompressDcmp2(header, body);
  else throw new DecompressError(`Unsupported 'dcmp' ID: ${header.dcmpId}`);
  if (out.length !== header.decompressedLength) {
    throw new DecompressError(
      `Decompressed length ${out.length} does not match header ${header.decompressedLength}`,
    );
  }
  return out;
}

interface HeaderInfo {
  headerLength: number;
  compressionType: number;
  decompressedLength: number;
  dcmpId: number;
  workingBufferFractionalSize: number;
  expansionBufferSize: number;
  parameters: Uint8Array;
}

function be16s(b: Uint8Array, o: number): number {
  return (be16(b, o) << 16) >> 16;
}

function parseHeader(data: Uint8Array): HeaderInfo {
  if (data.length < HEADER_SIZE) throw new DecompressError('Invalid header');
  if (!looksCompressed(data)) throw new DecompressError('Invalid signature');
  const headerLength = be16(data, 4);
  if (headerLength !== 0 && headerLength !== 0x12) {
    throw new DecompressError(`Unsupported header length: 0x${headerLength.toString(16)}`);
  }
  const compressionType = be16(data, 6);
  const decompressedLength = be32s(data, 8) >>> 0;
  const remainder = data.subarray(12, 18);
  if (compressionType === TYPE_8) {
    const dcmpId = be16s(remainder, 2);
    const reserved = be16(remainder, 4);
    if (reserved !== 0) throw new DecompressError(`Reserved field should be 0, not 0x${reserved.toString(16)}`);
    return {
      headerLength,
      compressionType,
      decompressedLength,
      dcmpId,
      workingBufferFractionalSize: remainder[0]!,
      expansionBufferSize: remainder[1]!,
      parameters: new Uint8Array(),
    };
  }
  if (compressionType === TYPE_9) {
    return {
      headerLength,
      compressionType,
      decompressedLength,
      dcmpId: be16s(remainder, 0),
      workingBufferFractionalSize: 0,
      expansionBufferSize: 0,
      parameters: remainder.subarray(2, 6),
    };
  }
  throw new DecompressError(`Unsupported compression type: 0x${compressionType.toString(16)}`);
}

class Cursor {
  i = 0;
  constructor(readonly d: Uint8Array) {}
  remaining(): number {
    return this.d.length - this.i;
  }
  u8(): number {
    if (this.i >= this.d.length) throw new DecompressError('truncated compressed data');
    return this.d[this.i++]!;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.i + n > this.d.length) throw new DecompressError('truncated compressed data');
    const s = this.d.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }
}

function readVarInt(c: Cursor): number {
  const head = c.u8();
  if (head === 0xff) return be32s(c.bytes(4), 0);
  if (head >= 0x80) {
    const hi = (head - 0xc0) & 0xff;
    return ((hi << 8) | c.u8()) << 16 >> 16;
  }
  return (head << 24) >> 24;
}

function uBytes(value: number, n: number): Uint8Array {
  if (value < 0 || value >= 2 ** (8 * n)) {
    throw new DecompressError(`Value out of range for ${n}-byte unsigned: ${value}`);
  }
  const out = new Uint8Array(n);
  let v = value >>> 0;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v >>>= 8;
  }
  return out;
}

function iBytes(value: number, n: number): Uint8Array {
  const bits = 8 * n;
  const min = -(2 ** (bits - 1));
  const max = 2 ** (bits - 1) - 1;
  if (value < min || value > max) {
    throw new DecompressError(`Value out of range for ${n}-byte signed: ${value}`);
  }
  return uBytes(value < 0 ? value + 2 ** bits : value, n);
}

function collect(expected: number, run: (emit: (chunk: Uint8Array) => void) => void, oddTrim = false): Uint8Array {
  const chunks: Uint8Array[] = [];
  let n = 0;
  run((chunk) => {
    if (oddTrim && expected % 2 !== 0 && n + chunk.length === expected + 1) {
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    chunks.push(chunk);
    n += chunk.length;
  });
  return n === 0 ? new Uint8Array() : concat(...chunks);
}

function prevLiteral(prev: Uint8Array[], index: number): Uint8Array {
  const lit = prev[index];
  if (!lit) throw new DecompressError(`Invalid literal backreference: 0x${index.toString(16)}`);
  return lit;
}

function decompressDcmp0(header: HeaderInfo, body: Uint8Array): Uint8Array {
  if (header.compressionType !== TYPE_8) throw new DecompressError('Incorrect header type for dcmp 0');
  const c = new Cursor(body);
  const prev: Uint8Array[] = [];
  return collect(
    header.decompressedLength,
    (emit) => {
      for (;;) {
        const byte = c.u8();
        if (byte < 0x20) {
          const countDiv2 = byte === 0x00 || byte === 0x10 ? c.u8() : byte & 0xf;
          const literal = new Uint8Array(c.bytes(2 * countDiv2));
          if (byte >= 0x10) prev.push(literal);
          emit(literal);
        } else if (byte === 0x20 || byte === 0x21) {
          emit(prevLiteral(prev, 0x28 + ((byte - 0x20) << 8 | c.u8())));
        } else if (byte === 0x22) {
          emit(prevLiteral(prev, 0x28 + be16(c.bytes(2), 0)));
        } else if (byte < 0x4b) {
          emit(prevLiteral(prev, byte - 0x23));
        } else if (byte < 0xfe) {
          emit(DCMP0_TABLE[byte - 0x4b]!);
        } else if (byte === 0xfe) {
          emitExtended0(c, emit);
        } else if (byte === 0xff) {
          if (c.remaining()) throw new DecompressError('Extra data after end marker');
          break;
        } else {
          throw new DecompressError(`Unknown tag byte: 0x${byte.toString(16)}`);
        }
      }
    },
    true,
  );
}

function emitExtended0(c: Cursor, emit: (chunk: Uint8Array) => void): void {
  const kind = c.u8();
  if (kind === 0x00) {
    const segment = readVarInt(c);
    const tail = concat(new Uint8Array([0x3f, 0x3c]), uBytes(segment, 2), new Uint8Array([0xa9, 0xf0]));
    emit(tail);
    const count = readVarInt(c);
    if (count <= 0) throw new DecompressError(`Jump table entry count must be greater than 0, not ${count}`);
    let current = readVarInt(c);
    emit(concat(uBytes(current, 2), tail));
    for (let i = 1; i < count; i++) {
      current = (current + readVarInt(c) - 6) & 0xffff;
      emit(concat(uBytes(current, 2), tail));
    }
    return;
  }
  if (kind === 0x02 || kind === 0x03) {
    const byteCount = kind === 0x02 ? 1 : 2;
    const toRepeat = uBytes(readVarInt(c), byteCount);
    const count = readVarInt(c) + 1;
    if (count <= 0) throw new DecompressError(`Repeat count must be positive: ${count}`);
    const out = new Uint8Array(byteCount * count);
    for (let i = 0; i < count; i++) out.set(toRepeat, i * byteCount);
    emit(out);
    return;
  }
  if (kind === 0x04) {
    const initial = readVarInt(c);
    emit(iBytes(initial, 2));
    const count = readVarInt(c);
    if (count < 0) throw new DecompressError(`Count cannot be negative: ${count}`);
    let current = initial & 0xffff;
    for (let i = 0; i < count; i++) {
      current = (current + ((c.u8() << 24) >> 24)) & 0xffff;
      emit(uBytes(current, 2));
    }
    return;
  }
  if (kind === 0x06) {
    const initial = readVarInt(c);
    emit(iBytes(initial, 4));
    const count = readVarInt(c);
    if (count < 0) throw new DecompressError(`Count cannot be negative: ${count}`);
    let current = initial >>> 0;
    for (let i = 0; i < count; i++) {
      current = (current + readVarInt(c)) >>> 0;
      emit(uBytes(current, 4));
    }
    return;
  }
  throw new DecompressError(`Unknown extended code: 0x${kind.toString(16)}`);
}

function decompressDcmp1(header: HeaderInfo, body: Uint8Array): Uint8Array {
  if (header.compressionType !== TYPE_8) throw new DecompressError('Incorrect header type for dcmp 1');
  const c = new Cursor(body);
  const prev: Uint8Array[] = [];
  return collect(header.decompressedLength, (emit) => {
    for (;;) {
      const byte = c.u8();
      if (byte < 0x20) {
        const literal = new Uint8Array(c.bytes((byte & 0xf) + 1));
        if (byte >= 0x10) prev.push(literal);
        emit(literal);
      } else if (byte < 0xd0) {
        emit(prevLiteral(prev, byte - 0x20));
      } else if (byte === 0xd0 || byte === 0xd1) {
        const literal = new Uint8Array(c.bytes(c.u8()));
        if (byte === 0xd1) prev.push(literal);
        emit(literal);
      } else if (byte === 0xd2) {
        emit(prevLiteral(prev, c.u8() + 0xb0));
      } else if (byte >= 0xd5 && byte < 0xfe) {
        emit(DCMP1_TABLE[byte - 0xd5]!);
      } else if (byte === 0xfe) {
        const kind = c.u8();
        if (kind !== 0x02) throw new DecompressError(`Unknown extended code: 0x${kind.toString(16)}`);
        const toRepeat = uBytes(readVarInt(c), 1);
        const count = readVarInt(c) + 1;
        if (count <= 0) throw new DecompressError(`Repeat count must be positive: ${count}`);
        const out = new Uint8Array(count);
        out.fill(toRepeat[0]!);
        emit(out);
      } else if (byte === 0xff) {
        if (c.remaining()) throw new DecompressError('Extra data after end marker');
        break;
      } else {
        throw new DecompressError(`Unknown tag byte: 0x${byte.toString(16)}`);
      }
    }
  });
}

function decompressDcmp2(header: HeaderInfo, body: Uint8Array): Uint8Array {
  if (header.compressionType !== TYPE_9) throw new DecompressError('Incorrect header type for dcmp 2');
  if (header.parameters.length < 4) throw new DecompressError('Missing dcmp 2 parameters');
  const tableCountM1 = header.parameters[2]!;
  const flags = header.parameters[3]!;
  if (flags & ~0x03) throw new DecompressError(`Unsupported flags: 0b${flags.toString(2)}`);
  const tagged = (flags & 2) !== 0;
  const custom = (flags & 1) !== 0;
  const c = new Cursor(body);
  let table: Uint8Array[];
  if (custom) {
    table = [];
    for (let i = 0; i < tableCountM1 + 1; i++) table.push(new Uint8Array(c.bytes(2)));
  } else {
    if (tableCountM1 !== 0) {
      throw new DecompressError(`table_count_m1 is ${tableCountM1}, but must be 0 for the default table`);
    }
    table = DCMP2_TABLE;
  }
  const expected = header.decompressedLength;
  return collect(expected, (emit) => {
    if (tagged) decompressTagged2(c, expected, table, emit);
    else decompressUntagged2(c, expected, table, emit);
  });
}

function lastOddLiteral(c: Cursor, expected: number, first: number, emit: (chunk: Uint8Array) => void): boolean {
  if (c.remaining() === 0 && expected % 2 !== 0) {
    emit(Uint8Array.of(first));
    return true;
  }
  return false;
}

function decompressUntagged2(
  c: Cursor,
  expected: number,
  table: Uint8Array[],
  emit: (chunk: Uint8Array) => void,
): void {
  for (;;) {
    if (c.remaining() === 0) break;
    const idx = c.u8();
    if (lastOddLiteral(c, expected, idx, emit)) break;
    const row = table[idx];
    if (!row) throw new DecompressError(`Invalid table index: ${idx}`);
    emit(row);
  }
}

function decompressTagged2(
  c: Cursor,
  expected: number,
  table: Uint8Array[],
  emit: (chunk: Uint8Array) => void,
): void {
  for (;;) {
    if (c.remaining() === 0) break;
    const tag = c.u8();
    if (lastOddLiteral(c, expected, tag, emit)) break;
    for (let bit = 7; bit >= 0; bit--) {
      if (c.remaining() === 0) return;
      if (tag & (1 << bit)) {
        const idx = c.u8();
        const row = table[idx];
        if (!row) throw new DecompressError(`Invalid table index: ${idx}`);
        emit(row);
      } else {
        const lit = c.bytes(Math.min(2, c.remaining()));
        if (!lit.length) return;
        emit(new Uint8Array(lit));
      }
    }
  }
}

function tablePairs(hex: string): Uint8Array[] {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 2) out.push(bytes.subarray(i, i + 2));
  return out;
}
