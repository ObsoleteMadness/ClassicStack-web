/** Classic pcap (LINKTYPE_LTALK) writer for LocalTalk / LLAP frames. */

/** LINKTYPE_LTALK — packets begin with an LLAP header. */
export const LINKTYPE_LTALK = 114;

export interface CapturedPacket {
  tsSec: number;
  tsUsec: number;
  data: Uint8Array;
  direction: 'rx' | 'tx';
}

export class PcapCapture {
  private enabled = false;
  private packets: CapturedPacket[] = [];

  get capturing(): boolean {
    return this.enabled;
  }

  get packetCount(): number {
    return this.packets.length;
  }

  start(): void {
    this.enabled = true;
  }

  stop(): void {
    this.enabled = false;
  }

  clear(): void {
    this.packets = [];
  }

  record(frame: Uint8Array, direction: 'rx' | 'tx' = 'rx'): void {
    if (!this.enabled) return;
    const ms = Date.now();
    this.packets.push({
      tsSec: Math.floor(ms / 1000),
      tsUsec: (ms % 1000) * 1000,
      data: frame.slice(),
      direction,
    });
  }

  /** Build a classic pcap file (little-endian, microsecond resolution). */
  build(): Uint8Array {
    let total = 24;
    for (const p of this.packets) total += 16 + p.data.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);

    // Global header
    view.setUint32(0, 0xa1b2c3d4, true);
    view.setUint16(4, 2, true);
    view.setUint16(6, 4, true);
    view.setInt32(8, 0, true);
    view.setUint32(12, 0, true);
    view.setUint32(16, 65535, true);
    view.setUint32(20, LINKTYPE_LTALK, true);

    let off = 24;
    for (const p of this.packets) {
      view.setUint32(off, p.tsSec, true);
      view.setUint32(off + 4, p.tsUsec, true);
      view.setUint32(off + 8, p.data.length, true);
      view.setUint32(off + 12, p.data.length, true);
      out.set(p.data, off + 16);
      off += 16 + p.data.length;
    }
    return out;
  }
}

export function downloadBytes(data: Uint8Array, filename: string, mime = 'application/octet-stream'): void {
  const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], {
    type: mime,
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
