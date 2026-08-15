import { describe, expect, it } from 'vitest';
import { LINKTYPE_LTALK, PcapCapture } from './pcap';

describe('PcapCapture', () => {
  it('writes a classic pcap with LINKTYPE_LTALK', () => {
    const cap = new PcapCapture();
    cap.start();
    cap.record(new Uint8Array([0xff, 0x01, 0x01, 0xaa, 0xbb]), 'rx');
    cap.record(new Uint8Array([0x02, 0x01, 0x02, 0x11]), 'tx');
    const buf = cap.build();
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    expect(view.getUint32(0, true)).toBe(0xa1b2c3d4);
    expect(view.getUint16(4, true)).toBe(2);
    expect(view.getUint16(6, true)).toBe(4);
    expect(view.getUint32(20, true)).toBe(LINKTYPE_LTALK);
    expect(view.getUint32(24 + 8, true)).toBe(5);
    expect([...buf.subarray(24 + 16, 24 + 16 + 5)]).toEqual([0xff, 0x01, 0x01, 0xaa, 0xbb]);
    expect(cap.packetCount).toBe(2);
  });

  it('ignores packets while stopped', () => {
    const cap = new PcapCapture();
    cap.record(new Uint8Array([1, 2, 3]), 'rx');
    expect(cap.packetCount).toBe(0);
    expect(cap.build().length).toBe(24);
  });
});
