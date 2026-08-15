/** CRC-16-CCITT (XMODEM): poly 0x1021, init 0, no xorout. Used by MacBinary. */

export function crc16Ccitt(data: Uint8Array, init = 0): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]! << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * BinHex 4.0 CRC (Peter Lewis / JBinHex): same poly, but each data bit is shifted
 * into the LSB. Callers then feed two extra 0x00 bytes before comparing.
 */
export function crc16BinHex(data: Uint8Array, init = 0): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) {
    let v = data[i]!;
    for (let b = 0; b < 8; b++) {
      const high = (crc & 0x8000) !== 0;
      crc = ((crc << 1) | (v >> 7)) & 0xffff;
      if (high) crc ^= 0x1021;
      v = (v << 1) & 0xff;
    }
  }
  return crc;
}

/**
 * CRC-16/IBM (ARC/ANSI): reflected poly 0xA001, init 0, no xorout.
 * StuffIt classic headers/forks and StuffIt 5 headers/forks (not method 15).
 * The Unarchiver uses `XADCRCTable_a001` for the same algorithm.
 */
export function crc16Ibm(data: Uint8Array, init = 0): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}
