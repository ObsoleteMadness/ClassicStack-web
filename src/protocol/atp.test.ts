import { describe, it, expect } from 'vitest';
import * as atp from './atp';
import * as asp from './asp';

describe('ATP / ASP OpenSess framing', () => {
  it('packs OpenSess as XO TReq with a one-packet bitmap', () => {
    const wss = 128;
    const pkt = atp.encodePacket(
      {
        control: atp.TREQ | atp.XO,
        bitmap: 0x01,
        transId: 2,
        userData: asp.packOpenSess(wss),
      },
      new Uint8Array(),
    );
    expect(pkt.length).toBe(8);
    expect(pkt[0]).toBe(atp.TREQ | atp.XO);
    expect(pkt[1]).toBe(0x01);
    expect(pkt[4]).toBe(asp.SPFuncOpenSess);
    expect(pkt[5]).toBe(wss);
    expect(pkt[6]).toBe(0x01);
    expect(pkt[7]).toBe(0x00);
  });

  it('detects STS separately from EOM', () => {
    const h = atp.decodeHeader(atp.encodeHeader({ control: atp.TRESP | atp.STS, bitmap: 1, transId: 1, userData: 0 }));
    expect(atp.hasSTS(h)).toBe(true);
    expect(atp.hasEOM(h)).toBe(false);
  });
});
