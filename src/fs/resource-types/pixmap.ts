/** Minimal PixMap parser for cicn resources (LibHfs.ResourceForks.PixMap). */

import { be16, be32 } from '../../protocol/binary';

function be16s(b: Uint8Array, o: number): number {
  return (be16(b, o) << 16) >> 16;
}

export interface PixMap {
  baseAddrPtr: number;
  rowBytes: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  pmVersion: number;
  packType: number;
  packSize: number;
  hRes: number;
  vRes: number;
  pixelType: number;
  pixelSize: number;
  cmpCount: number;
  cmpSize: number;
  planeBytes: number;
  pmTablePtr: number;
  pmReserved: number;
  width: number;
  height: number;
}

export function parsePixMap(data: Uint8Array, off: { o: number }): PixMap {
  if (off.o + 50 > data.length) throw new Error('Not enough data for PixMap');
  const baseAddrPtr = be32(data, off.o) | 0;
  off.o += 4;
  const rowBytes = be16(data, off.o);
  off.o += 2;
  const top = be16s(data, off.o);
  off.o += 2;
  const left = be16s(data, off.o);
  off.o += 2;
  const bottom = be16s(data, off.o);
  off.o += 2;
  const right = be16s(data, off.o);
  off.o += 2;
  const pmVersion = be16(data, off.o);
  off.o += 2;
  const packType = be16(data, off.o);
  off.o += 2;
  const packSize = be32(data, off.o);
  off.o += 4;
  const hRes = be32(data, off.o);
  off.o += 4;
  const vRes = be32(data, off.o);
  off.o += 4;
  const pixelType = be16(data, off.o);
  off.o += 2;
  const pixelSize = be16(data, off.o);
  off.o += 2;
  const cmpCount = be16(data, off.o);
  off.o += 2;
  const cmpSize = be16(data, off.o);
  off.o += 2;
  const planeBytes = be32(data, off.o);
  off.o += 4;
  const pmTablePtr = be32(data, off.o);
  off.o += 4;
  const pmReserved = be32(data, off.o);
  off.o += 4;
  return {
    baseAddrPtr,
    rowBytes,
    top,
    left,
    bottom,
    right,
    pmVersion,
    packType,
    packSize,
    hRes,
    vRes,
    pixelType,
    pixelSize,
    cmpCount,
    cmpSize,
    planeBytes,
    pmTablePtr,
    pmReserved,
    width: right - left,
    height: bottom - top,
  };
}
