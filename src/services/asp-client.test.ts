import { describe, it, expect } from 'vitest';
import { AspSession } from './asp-client';
import type { AtpClient, AtpInboundTReq, AtpRequest, AtpResponse } from './atp-client';
import {
  packClose,
  packOpenReply,
  packWriteContinue,
  unpackUserData,
  writeContinuePayload,
  SPFuncOpenSess,
  SPFuncCommand,
  SPFuncTickle,
  SPFuncWrite,
} from '../protocol/asp';

class FakeAtp {
  inflight = 0;
  maxInflight = 0;
  seqs: number[] = [];
  srcSockets: number[] = [];
  destSockets: number[] = [];
  funcs: number[] = [];
  openSess: { wss: number; src: number } | null = null;
  wssHandler: ((req: AtpInboundTReq) => void | Promise<void>) | null = null;
  wssSocket = 0;
  replies: number[] = [];
  replyPayloads: Uint8Array[] = [];
  writeShouldTimeout = false;

  async request(req: AtpRequest): Promise<AtpResponse> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    this.srcSockets.push(req.srcSocket);
    this.destSockets.push(req.destSocket);
    const parsed = unpackUserData(req.userData);
    this.funcs.push(parsed.spFunc);
    if (parsed.spFunc === SPFuncOpenSess) {
      this.openSess = { wss: parsed.b1, src: req.srcSocket };
    }
    if (parsed.spFunc === SPFuncCommand) this.seqs.push(parsed.word);
    await new Promise((r) => setTimeout(r, 25));
    this.inflight--;
    if (parsed.spFunc === SPFuncOpenSess) {
      return { userData: packOpenReply(249, 9, 0), data: new Uint8Array(), transId: 1 };
    }
    if (parsed.spFunc === SPFuncWrite && this.writeShouldTimeout) {
      throw new Error('atp: timeout');
    }
    return { userData: 0, data: new Uint8Array(), transId: 1 };
  }

  onTReq(socket: number, handler: (req: AtpInboundTReq) => void | Promise<void>): void {
    this.wssSocket = socket;
    this.wssHandler = handler;
  }

  async replyTReq(_dg: unknown, _header: unknown, userData: number, data?: Uint8Array): Promise<void> {
    this.replies.push(userData);
    this.replyPayloads.push(data ?? new Uint8Array());
  }

  ensureListen(): void {}

  async injectClose(sessionId: number): Promise<void> {
    await this.wssHandler!({
      dg: {
        hops: 0,
        destNetwork: 0,
        srcNetwork: 0,
        destNode: 1,
        srcNode: 2,
        destSocket: this.wssSocket,
        srcSocket: 249,
        ddpType: 3,
        data: new Uint8Array(),
      },
      header: { control: 0x40, bitmap: 0x01, transId: 0, userData: packClose(sessionId) },
      data: new Uint8Array(),
    });
  }
}

describe('ASP Command serialization', () => {
  it('does not pipeline two Commands (System 7 drops overlapping seqs)', async () => {
    const atp = new FakeAtp();
    const sess = new AspSession(atp as unknown as AtpClient, 0, 1, 251);
    sess.opened = true;
    await Promise.all([
      sess.command(new Uint8Array([9])),
      sess.command(new Uint8Array([34])),
    ]);
    expect(atp.maxInflight).toBe(1);
    expect(atp.seqs).toEqual([0, 1]);
  });

  it('does not send a queued Command after its abort signal fires', async () => {
    const atp = new FakeAtp();
    const sess = new AspSession(atp as unknown as AtpClient, 0, 1, 251);
    sess.opened = true;
    const ac = new AbortController();
    const first = sess.command(new Uint8Array([9]));
    const second = sess.command(new Uint8Array([193]), { signal: ac.signal });
    ac.abort();
    await first;
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(atp.seqs).toEqual([0]);
  });
});

describe('ASP sockets vs ClassicStack client/asp', () => {
  it('advertises WSS in OpenSess but sends Command from a different socket', async () => {
    const atp = new FakeAtp();
    const sess = new AspSession(atp as unknown as AtpClient, 0, 1, 251);
    await sess.open();
    expect(atp.openSess).not.toBeNull();
    expect(atp.openSess!.src).not.toBe(atp.openSess!.wss);
    expect(atp.wssSocket).toBe(atp.openSess!.wss);

    await sess.command(new Uint8Array([9]));
    const cmdSrc = atp.srcSockets[atp.srcSockets.length - 1];
    expect(cmdSrc).toBe(atp.openSess!.src);
    expect(cmdSrc).not.toBe(atp.openSess!.wss);
    expect(atp.destSockets[atp.destSockets.length - 1]).toBe(249);
  });

  it('sends workstation tickles to the SLS, not the SSS', async () => {
    const atp = new FakeAtp();
    const sess = new AspSession(atp as unknown as AtpClient, 0, 1, 251);
    await sess.open();
    await sess.command(new Uint8Array([9]));
    const tickleAt = atp.funcs.indexOf(SPFuncTickle);
    expect(tickleAt).toBeGreaterThanOrEqual(0);
    expect(atp.destSockets[tickleAt]).toBe(251);
    expect(atp.destSockets[atp.funcs.indexOf(SPFuncCommand)]).toBe(249);
    await sess.close();
  });
});

describe('ASP server CloseSession', () => {
  it('closes only when the TReq session id matches', async () => {
    const atp = new FakeAtp();
    const sess = new AspSession(atp as unknown as AtpClient, 0, 1, 251);
    await sess.open();
    expect(sess.opened).toBe(true);

    await atp.injectClose(99);
    expect(sess.opened).toBe(true);

    await atp.injectClose(9);
    expect(sess.opened).toBe(false);
  });
});

describe('ASP WriteContinue after Write timeout', () => {
  it('still answers a shrunk-bitmap retry with the write payload', async () => {
    const atp = new FakeAtp();
    atp.writeShouldTimeout = true;
    const sess = new AspSession(atp as unknown as AtpClient, 0, 1, 251);
    await sess.open();
    const payload = new Uint8Array(4624).fill(0xab);
    await expect(sess.write(new Uint8Array(12), payload)).rejects.toThrow('atp: timeout');

    await atp.wssHandler!({
      dg: {
        hops: 0,
        destNetwork: 0,
        srcNetwork: 0,
        destNode: 1,
        srcNode: 2,
        destSocket: atp.wssSocket,
        srcSocket: 249,
        ddpType: 3,
        data: writeContinuePayload(4624),
      },
      header: { control: 0x60, bitmap: 0xfc, transId: 962, userData: packWriteContinue(9, 0) },
      data: writeContinuePayload(4624),
    });
    expect(atp.replyPayloads.at(-1)).toEqual(payload);
  });
});
