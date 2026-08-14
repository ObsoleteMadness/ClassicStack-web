/** ATP client requester over LocalTalkStack. */

import * as atp from '../protocol/atp';
import type { LocalTalkStack } from '../net/stack';
import type { Datagram } from '../protocol/ddp';

export interface AtpRequest {
  destNetwork: number;
  destNode: number;
  destSocket: number;
  srcSocket: number;
  userData: number;
  data?: Uint8Array;
  xo?: boolean;
  timeoutMs?: number;
  retries?: number;
}

export interface AtpResponse {
  userData: number;
  data: Uint8Array;
  transId: number;
}

export type AtpInboundTReq = {
  dg: Datagram;
  header: atp.Header;
  data: Uint8Array;
};

export class AtpClient {
  private stack: LocalTalkStack;
  private nextTid = 1;
  private pending = new Map<
    number,
    {
      parts: Map<number, Uint8Array>;
      userData: number;
      resolve: (r: AtpResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      eomSeen: boolean;
    }
  >();
  private listening = new Set<number>();
  /** Server-initiated TReq handlers (ASP WriteContinue / Tickle / Attention on WSS). */
  private tReqHandlers = new Map<number, (req: AtpInboundTReq) => void | Promise<void>>();

  constructor(stack: LocalTalkStack) {
    this.stack = stack;
  }

  private ensureListen(socket: number): void {
    if (this.listening.has(socket)) return;
    this.listening.add(socket);
    this.stack.onDatagram(socket, (dg) => this.onDdp(dg));
  }

  /** Register a handler for inbound ATP TReq on `socket` (workstation WSS). */
  onTReq(socket: number, handler: (req: AtpInboundTReq) => void | Promise<void>): void {
    this.ensureListen(socket);
    this.tReqHandlers.set(socket, handler);
  }

  /** Reply to an inbound TReq (chunked ATP TResp, same framing as AtpServer). */
  async replyTReq(dg: Datagram, header: atp.Header, userData: number, data: Uint8Array): Promise<void> {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < data.length || chunks.length === 0; i += atp.MaxATPData) {
      chunks.push(data.subarray(i, Math.min(i + atp.MaxATPData, data.length)));
      if (i + atp.MaxATPData >= data.length && data.length > 0) break;
      if (data.length === 0) break;
    }
    if (chunks.length === 0) chunks.push(new Uint8Array());

    for (let seq = 0; seq < chunks.length; seq++) {
      const eom = seq === chunks.length - 1 ? atp.EOM : 0;
      const pkt = atp.encodePacket(
        {
          control: atp.TRESP | eom,
          bitmap: seq,
          transId: header.transId,
          userData: seq === 0 ? userData : 0,
        },
        chunks[seq]!,
      );
      await this.stack.send({
        hops: 0,
        destNetwork: dg.srcNetwork,
        srcNetwork: this.stack.network,
        destNode: dg.srcNode,
        srcNode: this.stack.node,
        destSocket: dg.srcSocket,
        srcSocket: dg.destSocket,
        ddpType: atp.DDPType,
        data: pkt,
      });
    }
  }

  async request(req: AtpRequest): Promise<AtpResponse> {
    this.ensureListen(req.srcSocket);
    const tid = this.nextTid++ & 0xffff;
    if (tid === 0) this.nextTid = 1;
    const timeoutMs = req.timeoutMs ?? 3000;
    const retries = req.retries ?? 3;
    const bitmap = 0xff; // request all 8 response slots

    const control = atp.TREQ | (req.xo ? atp.XO : 0);
    const payload = atp.encodePacket(
      { control, bitmap, transId: tid, userData: req.userData },
      req.data ?? new Uint8Array(),
    );

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const send = () => {
        attempts++;
        void this.stack.send({
          hops: 0,
          destNetwork: req.destNetwork,
          srcNetwork: this.stack.network,
          destNode: req.destNode,
          srcNode: this.stack.node,
          destSocket: req.destSocket,
          srcSocket: req.srcSocket,
          ddpType: atp.DDPType,
          data: payload,
        });
      };

      const timer = setTimeout(() => {
        if (attempts < retries) {
          send();
          // reset timer
          const p = this.pending.get(tid);
          if (p) {
            clearTimeout(p.timer);
            p.timer = setTimeout(() => {
              this.pending.delete(tid);
              reject(new Error('atp: timeout'));
            }, timeoutMs);
          }
        } else {
          this.pending.delete(tid);
          reject(new Error('atp: timeout'));
        }
      }, timeoutMs);

      this.pending.set(tid, {
        parts: new Map(),
        userData: 0,
        resolve,
        reject,
        timer,
        eomSeen: false,
      });
      send();
    });
  }

  private onDdp(dg: Datagram): void {
    if (dg.ddpType !== atp.DDPType) return;
    let decoded: { header: atp.Header; data: Uint8Array };
    try {
      decoded = atp.decodePacket(dg.data);
    } catch {
      return;
    }
    const { header, data } = decoded;
    const fn = atp.funcCode(header);

    if (fn === atp.TREQ) {
      const handler = this.tReqHandlers.get(dg.destSocket);
      if (handler) void handler({ dg, header, data });
      return;
    }

    if (fn !== atp.TRESP) return;
    const pend = this.pending.get(header.transId);
    if (!pend) return;

    const seq = header.bitmap & 0x07;
    pend.parts.set(seq, data);
    if (seq === 0) pend.userData = header.userData;
    if (atp.hasEOM(header)) pend.eomSeen = true;

    // Reassemble in order until EOM and contiguous from 0.
    if (!pend.eomSeen) return;
    let max = -1;
    for (const k of pend.parts.keys()) if (k > max) max = k;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i <= max; i++) {
      const part = pend.parts.get(i);
      if (!part) return; // gap
      chunks.push(part);
      total += part.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    clearTimeout(pend.timer);
    this.pending.delete(header.transId);

    // Send TRel for XO if needed — omitted for ALO default.
    pend.resolve({ userData: pend.userData, data: out, transId: header.transId });
  }
}
