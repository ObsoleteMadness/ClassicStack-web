import { describe, it, expect } from 'vitest';
import { AtpClient } from './atp-client';
import type { LocalTalkStack } from '../net/stack';
import type { Datagram } from '../protocol/ddp';
import * as atp from '../protocol/atp';

class FakeStack {
  network = 0;
  node = 254;
  sent: Uint8Array[] = [];
  sendDelay = 20;
  inflight = 0;
  maxInflight = 0;

  async send(dg: { data: Uint8Array }): Promise<void> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    await new Promise((r) => setTimeout(r, this.sendDelay));
    this.sent.push(dg.data);
    this.inflight--;
  }

  onDatagram(): void {}
}

function dg(): Datagram {
  return {
    hops: 0,
    destNetwork: 0,
    srcNetwork: 0,
    destNode: 254,
    srcNode: 2,
    destSocket: 128,
    srcSocket: 251,
    ddpType: 3,
    data: new Uint8Array(),
  };
}

describe('AtpClient.replyTReq', () => {
  const body = new Uint8Array(atp.MaxATPData * 8);

  it('sends only the requested bitmap slots', async () => {
    const stack = new FakeStack();
    stack.sendDelay = 0;
    const client = new AtpClient(stack as unknown as LocalTalkStack);
    await client.replyTReq(dg(), { control: atp.TREQ | atp.XO, bitmap: 0x01, transId: 949, userData: 1 }, 1, body);
    expect(stack.sent).toHaveLength(1);
    expect(atp.decodePacket(stack.sent[0]!).header.bitmap).toBe(0);
    expect(atp.decodePacket(stack.sent[0]!).header.control & atp.EOM).toBe(0);
  });

  it('does not overlap a WriteContinue retry on the same TID', async () => {
    const stack = new FakeStack();
    const client = new AtpClient(stack as unknown as LocalTalkStack);
    const d = dg();
    const first = client.replyTReq(
      d,
      { control: atp.TREQ | atp.XO, bitmap: 0xff, transId: 955, userData: 1 },
      1,
      body,
    );
    const retry = client.replyTReq(
      d,
      { control: atp.TREQ | atp.XO, bitmap: 0x01, transId: 955, userData: 1 },
      1,
      body,
    );
    await Promise.all([first, retry]);
    expect(stack.maxInflight).toBe(1);
    expect(stack.sent).toHaveLength(9);
    const seqs = stack.sent.map((p) => atp.decodePacket(p).header.bitmap);
    expect(seqs.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(seqs[8]).toBe(0);
  });
});
