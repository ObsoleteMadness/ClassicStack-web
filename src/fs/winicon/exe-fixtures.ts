/** Test-only PE/NE builders wrapping an ICO in a resource section. */

import { le16, le32, writeLe16, writeLe32 } from '../../protocol/binary';

function align(n: number, a: number): number {
  return (n + a - 1) & ~(a - 1);
}

function icoImages(ico: Uint8Array): Uint8Array[] {
  const count = le16(ico, 4);
  const images: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    images.push(ico.subarray(le32(ico, o + 12), le32(ico, o + 12) + le32(ico, o + 8)));
  }
  return images;
}

function icoGroup(ico: Uint8Array): Uint8Array {
  const count = le16(ico, 4);
  const group = new Uint8Array(6 + count * 14);
  writeLe16(group, 2, 1);
  writeLe16(group, 4, count);
  for (let i = 0; i < count; i++) {
    group.set(ico.subarray(6 + i * 16, 6 + i * 16 + 12), 6 + i * 14);
    writeLe16(group, 6 + i * 14 + 12, i + 1);
  }
  return group;
}

/** Minimal PE32 with .rsrc holding RT_GROUP_ICON + RT_ICON from an ICO. */
export function buildPeWithIco(ico: Uint8Array): Uint8Array {
  const images = icoImages(ico);
  const group = icoGroup(ico);
  const n = images.length;
  let o = 0;
  const root = o;
  o += 32;
  const typeIcon = o;
  o += 16 + 8 * n;
  const typeGroup = o;
  o += 24;
  const nameIcons: number[] = [];
  for (let i = 0; i < n; i++) {
    nameIcons.push(o);
    o += 24;
  }
  const nameGroup = o;
  o += 24;
  const dataIcons: number[] = [];
  for (let i = 0; i < n; i++) {
    dataIcons.push(o);
    o += 16;
  }
  const dataGroup = o;
  o += 16;
  const payIcons: number[] = [];
  for (const im of images) {
    payIcons.push(o);
    o += im.length;
  }
  const payGroup = o;
  o += group.length;
  const rsrc = new Uint8Array(o);
  const RES_RVA = 0x1000;
  const DIR = 0x80000000;
  const writeDir = (off: number, nId: number) => writeLe16(rsrc, off + 14, nId);
  const writeId = (off: number, idx: number, id: number, child: number, isDir: boolean) => {
    const p = off + 16 + idx * 8;
    writeLe32(rsrc, p, id);
    writeLe32(rsrc, p + 4, child | (isDir ? DIR : 0));
  };

  writeDir(root, 2);
  writeId(root, 0, 3, typeIcon, true);
  writeId(root, 1, 14, typeGroup, true);
  writeDir(typeIcon, n);
  for (let i = 0; i < n; i++) writeId(typeIcon, i, i + 1, nameIcons[i]!, true);
  writeDir(typeGroup, 1);
  writeId(typeGroup, 0, 1, nameGroup, true);
  for (let i = 0; i < n; i++) {
    writeDir(nameIcons[i]!, 1);
    writeId(nameIcons[i]!, 0, 0x0409, dataIcons[i]!, false);
    writeLe32(rsrc, dataIcons[i]!, RES_RVA + payIcons[i]!);
    writeLe32(rsrc, dataIcons[i]! + 4, images[i]!.length);
    rsrc.set(images[i]!, payIcons[i]!);
  }
  writeDir(nameGroup, 1);
  writeId(nameGroup, 0, 0x0409, dataGroup, false);
  writeLe32(rsrc, dataGroup, RES_RVA + payGroup);
  writeLe32(rsrc, dataGroup + 4, group.length);
  rsrc.set(group, payGroup);

  const rawOff = 0x200;
  const rawSize = align(rsrc.length, 0x200);
  const file = new Uint8Array(rawOff + rawSize);
  writeLe16(file, 0, 0x5a4d);
  writeLe32(file, 0x3c, 0x40);
  writeLe32(file, 0x40, 0x4550);
  writeLe16(file, 0x44, 0x14c);
  writeLe16(file, 0x46, 1);
  writeLe16(file, 0x54, 224);
  writeLe16(file, 0x56, 0x0102);
  writeLe16(file, 0x58, 0x10b);
  writeLe32(file, 0x58 + 32, 0x1000);
  writeLe32(file, 0x58 + 36, 0x200);
  writeLe32(file, 0x58 + 56, 0x2000);
  writeLe32(file, 0x58 + 60, 0x200);
  writeLe16(file, 0x58 + 68, 2);
  writeLe32(file, 0x58 + 92, 16);
  writeLe32(file, 0x58 + 96 + 16, RES_RVA);
  writeLe32(file, 0x58 + 96 + 20, rsrc.length);
  const sec = 0x58 + 224;
  file.set([0x2e, 0x72, 0x73, 0x72, 0x63], sec);
  writeLe32(file, sec + 8, rsrc.length);
  writeLe32(file, sec + 12, RES_RVA);
  writeLe32(file, sec + 16, rawSize);
  writeLe32(file, sec + 20, rawOff);
  file.set(rsrc, rawOff);
  return file;
}

/** Minimal NE with a resource table holding group + icon images from an ICO. */
export function buildNeWithIco(ico: Uint8Array): Uint8Array {
  const images = icoImages(ico);
  const group = icoGroup(ico);
  const shift = 1;
  const unit = 1 << shift;
  const tableOff = 0x80;
  const tableSize = 2 + 8 + 12 + 8 + 12 * images.length + 2;
  let dataOff = Math.ceil((tableOff + tableSize) / unit) * unit;
  const payloads: { off: number; bytes: Uint8Array; type: number; id: number }[] = [];
  const place = (bytes: Uint8Array, type: number, id: number) => {
    const off = dataOff;
    payloads.push({ off, bytes, type, id });
    dataOff += Math.ceil(bytes.length / unit) * unit;
  };
  place(group, 14, 1);
  for (let i = 0; i < images.length; i++) place(images[i]!, 3, i + 1);

  const file = new Uint8Array(dataOff);
  writeLe16(file, 0, 0x5a4d);
  writeLe32(file, 0x3c, 0x40);
  writeLe16(file, 0x40, 0x454e);
  writeLe16(file, 0x40 + 0x24, 0x40);
  let p = tableOff;
  writeLe16(file, p, shift);
  p += 2;
  const writeType = (type: number, items: { off: number; bytes: Uint8Array; id: number }[]) => {
    writeLe16(file, p, type | 0x8000);
    writeLe16(file, p + 2, items.length);
    p += 8;
    for (const it of items) {
      writeLe16(file, p, it.off / unit);
      writeLe16(file, p + 2, Math.ceil(it.bytes.length / unit));
      writeLe16(file, p + 4, 0x1c30);
      writeLe16(file, p + 6, it.id | 0x8000);
      p += 12;
    }
  };
  writeType(14, payloads.filter((x) => x.type === 14));
  writeType(3, payloads.filter((x) => x.type === 3));
  writeLe16(file, p, 0);
  for (const it of payloads) file.set(it.bytes, it.off);
  return file;
}
