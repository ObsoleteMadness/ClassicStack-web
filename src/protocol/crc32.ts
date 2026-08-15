/** CRC-32/ISO-HDLC (PKZIP): reflected poly 0xEDB88320, init/xorout 0xFFFFFFFF. */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, init = 0): number {
  let crc = (init ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
