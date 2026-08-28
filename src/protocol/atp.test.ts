import { describe, it, expect } from 'vitest';
import * as atp from './atp';
import * as asp from './asp';

describe('ATP / ASP OpenSess framing', () => {
  it('packs OpenSess as ALO TReq with a one-packet bitmap (ClassicStack)', () => {
    const wss = 128;
    const pkt = atp.encodePacket(
      {
        control: atp.TREQ,
        bitmap: 0x01,
        transId: 2,
        userData: asp.packOpenSess(wss),
      },
      new Uint8Array(),
    );
    expect(pkt.length).toBe(8);
    expect(pkt[0]).toBe(atp.TREQ);
    expect(pkt[1]).toBe(0x01);
    expect(pkt[4]).toBe(asp.SPFuncOpenSess);
    expect(pkt[5]).toBe(wss);
    expect(pkt[6]).toBe(0x01);
    expect(pkt[7]).toBe(0x00);
  });

  it('completes a one-slot reply without EOM', () => {
    const got = new Set([0]);
    expect(atp.responseComplete(1, got, null)).toBe(true);
    expect(atp.responseComplete(8, got, null)).toBe(false);
    expect(atp.responseComplete(8, got, 0)).toBe(true);
  });

  it('infers EOM at the last contiguous slot when the server omits the flag', () => {
    expect(atp.inferredEomSeq(8, new Set())).toBeNull();
    expect(atp.inferredEomSeq(8, new Set([0]))).toBe(0);
    expect(atp.inferredEomSeq(8, new Set([0, 1, 2]))).toBe(2);
    expect(atp.inferredEomSeq(8, new Set([0, 2]))).toBe(0);
  });

  it('sizes the TReq bitmap to the payload, not a fixed 8-packet window', () => {
    expect(atp.bitmapForPayload(16)).toBe(0x01);
    expect(atp.bitmapForPayload(578)).toBe(0x01);
    expect(atp.bitmapForPayload(579)).toBe(0x03);
    expect(atp.bitmapForPayload(asp.QuantumSize)).toBe(0xff);
  });

  it('detects STS separately from EOM', () => {
    const h = atp.decodeHeader(atp.encodeHeader({ control: atp.TRESP | atp.STS, bitmap: 1, transId: 1, userData: 0 }));
    expect(atp.hasSTS(h)).toBe(true);
    expect(atp.hasEOM(h)).toBe(false);
  });
});

describe('slotsFromBitmap', () => {
  it('lists set bits', () => {
    expect(atp.slotsFromBitmap(0xff)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(atp.slotsFromBitmap(0x01)).toEqual([0]);
    expect(atp.slotsFromBitmap(0x05)).toEqual([0, 2]);
  });

  it('treats a zero bitmap as slot 0 (ClassicStack respond)', () => {
    expect(atp.slotsFromBitmap(0)).toEqual([0]);
  });
});

describe('encodeTRespPackets', () => {
  const body = new Uint8Array(atp.MaxATPData * 8);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;

  it('sends all eight slots with EOM only on the last message slot', () => {
    const pkts = atp.encodeTRespPackets(949, 0x07030001, body, 0xff);
    expect(pkts).toHaveLength(8);
    const decoded = pkts.map((p) => atp.decodePacket(p));
    expect(decoded.map((d) => d.header.bitmap)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(decoded.map((d) => (d.header.control & atp.EOM) !== 0)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(decoded[0]!.header.control & atp.TRESP).toBe(atp.TRESP);
    expect(decoded[0]!.header.userData).toBe(0x07030001);
    expect(decoded[1]!.header.userData).toBe(0);
  });

  it('TID 949: a bitmap-0x01 retry sends only slot 0 without EOM', () => {
    const pkts = atp.encodeTRespPackets(949, 0x07030001, body, 0x01);
    expect(pkts).toHaveLength(1);
    const { header, data } = atp.decodePacket(pkts[0]!);
    expect(header.bitmap).toBe(0);
    expect(header.control & atp.EOM).toBe(0);
    expect(data.length).toBe(atp.MaxATPData);
  });

  it('empty payload is one empty slot with EOM', () => {
    const pkts = atp.encodeTRespPackets(1, 0, new Uint8Array(), 0x01);
    expect(pkts).toHaveLength(1);
    const { header, data } = atp.decodePacket(pkts[0]!);
    expect(header.control & atp.EOM).toBe(atp.EOM);
    expect(data.length).toBe(0);
  });

  it('empty buffer + retry bitmap 0xfc still emits slots 2–7 so the requester unblocks', () => {
    const pkts = atp.encodeTRespPackets(962, 0, new Uint8Array(), 0xfc);
    expect(pkts).toHaveLength(6);
    const decoded = pkts.map((p) => atp.decodePacket(p));
    expect(decoded.map((d) => d.header.bitmap)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(decoded[5]!.header.control & atp.EOM).toBe(atp.EOM);
    expect(decoded[0]!.header.control & atp.EOM).toBe(0);
  });
});

describe('splitPayload', () => {
  it('always returns at least one chunk', () => {
    expect(atp.splitPayload(new Uint8Array())).toHaveLength(1);
  });
});
