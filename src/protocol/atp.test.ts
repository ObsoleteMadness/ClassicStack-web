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

  it('detects STS separately from EOM', () => {
    const h = atp.decodeHeader(atp.encodeHeader({ control: atp.TRESP | atp.STS, bitmap: 1, transId: 1, userData: 0 }));
    expect(atp.hasSTS(h)).toBe(true);
    expect(atp.hasEOM(h)).toBe(false);
  });
});
