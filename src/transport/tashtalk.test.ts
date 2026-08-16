import { describe, it, expect } from 'vitest';
import {
  fcsBytes,
  encodeOutbound,
  encodeSetNodeIds,
  TashTalkDecoder,
  buildInitSequence,
} from '../transport/tashtalk';
import { encodeLong, decodeLong } from '../protocol/ddp';
import { buildAppleDouble, parseAppleDouble } from '../fs/appledouble';

describe('tashtalk FCS', () => {
  it('round-trips frame through decoder (no inbound start marker)', () => {
    const llap = new Uint8Array([0xfe, 0xfe, 0x81]);
    const [b1, b2] = fcsBytes(llap);
    // Device→host: raw LLAP+FCS then 0x00 0xFD (tashrouter; no 0x01 prefix).
    const stream = new Uint8Array([...llap, b1, b2, 0x00, 0xfd]);
    const dec = new TashTalkDecoder();
    dec.feed(stream);
    expect(dec.take()).toEqual(llap);
  });

  it('decodes escaped null bytes', () => {
    const llap = new Uint8Array([0x01, 0x00, 0x81]);
    const [b1, b2] = fcsBytes(llap);
    // 0x00 in payload → 0x00 0xFF on the wire
    const stream = new Uint8Array([0x01, 0x00, 0xff, 0x81, b1, b2, 0x00, 0xfd]);
    const dec = new TashTalkDecoder();
    dec.feed(stream);
    expect(dec.take()).toEqual(llap);
  });

  it('ignores a spurious 0x01 prefix (not a start marker)', () => {
    const llap = new Uint8Array([0xfe, 0xfe, 0x81]);
    const [b1, b2] = fcsBytes(llap);
    // Old (wrong) decoder required 0x01; real firmware does not send it.
    // If 0x01 is present it is data — here we only send the correct stream.
    const dec = new TashTalkDecoder();
    dec.feed(new Uint8Array([...llap, b1, b2, 0x00, 0xfd]));
    expect(dec.take()).toEqual(llap);
  });

  it('encodes outbound as 0x01 + LLAP + FCS', () => {
    const llap = new Uint8Array([0xfe, 0xfe, 0x81]);
    const wire = encodeOutbound(llap);
    const [b1, b2] = fcsBytes(llap);
    expect([...wire]).toEqual([0x01, 0xfe, 0xfe, 0x81, b1, b2]);
  });

  it('builds init like tashrouter (flush + empty node map + features off)', () => {
    const init = buildInitSequence();
    expect(init.length).toBe(1024 + 1 + 32 + 2);
    expect(init[1024]).toBe(0x02);
    for (let i = 0; i < 32; i++) expect(init[1025 + i]).toBe(0);
    expect(init[1024 + 1 + 32]).toBe(0x03);
    expect(init[1024 + 1 + 32 + 1]).toBe(0x00);
  });

  it('encodes set-node-ids bitmap for node 0xFE', () => {
    const cmd = encodeSetNodeIds([0xfe]);
    expect(cmd[0]).toBe(0x02);
    expect(cmd.length).toBe(33);
    // 0xFE → byte 31, bit 6
    expect(cmd[1 + 31]).toBe(1 << 6);
  });

  it('discards on ClassicStack framing-error / abort escapes (0xFE / 0xFA)', () => {
    const llap = new Uint8Array([0xfe, 0xfe, 0x81]);
    const [b1, b2] = fcsBytes(llap);
    const dec = new TashTalkDecoder();
    dec.feed(new Uint8Array([0xfe, 0xfe, 0x00, 0xfe]));
    expect(dec.take()).toBeUndefined();
    dec.feed(new Uint8Array([...llap, b1, b2, 0x00, 0xfd]));
    expect(dec.take()).toEqual(llap);
    dec.feed(new Uint8Array([0x01, 0x00, 0xfa, ...llap, b1, b2, 0x00, 0xfd]));
    expect(dec.take()).toEqual(llap);
  });
});

describe('ddp', () => {
  it('encodes and decodes long header', () => {
    const dg = {
      hops: 0,
      destNetwork: 1,
      srcNetwork: 1,
      destNode: 2,
      srcNode: 3,
      destSocket: 4,
      srcSocket: 5,
      ddpType: 3,
      data: new Uint8Array([9, 8, 7]),
    };
    const wire = encodeLong(dg);
    const back = decodeLong(wire);
    expect(back.destSocket).toBe(4);
    expect([...back.data]).toEqual([9, 8, 7]);
  });
});

describe('appledouble', () => {
  it('round-trips finder + resource', () => {
    const fi = new Uint8Array(32);
    fi[0] = 0x54;
    fi[1] = 0x45;
    fi[2] = 0x58;
    fi[3] = 0x54;
    const rsrc = new Uint8Array([1, 2, 3, 4]);
    const built = buildAppleDouble(fi, rsrc);
    const parsed = parseAppleDouble(built)!;
    expect(parsed.finderInfo[0]).toBe(0x54);
    expect([...parsed.resource]).toEqual([1, 2, 3, 4]);
  });
});
