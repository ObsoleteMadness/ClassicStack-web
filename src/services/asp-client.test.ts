import { describe, it, expect } from 'vitest';
import { AspSession } from './asp-client';
import type { AtpClient, AtpRequest, AtpResponse } from './atp-client';
import { unpackUserData } from '../protocol/asp';

class FakeAtp {
  inflight = 0;
  maxInflight = 0;
  seqs: number[] = [];

  async request(req: AtpRequest): Promise<AtpResponse> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    this.seqs.push(unpackUserData(req.userData).word);
    await new Promise((r) => setTimeout(r, 25));
    this.inflight--;
    return { userData: 0, data: new Uint8Array(), transId: 1 };
  }

  onTReq(): void {}
  async replyTReq(): Promise<void> {}
  ensureListen(): void {}
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
});
