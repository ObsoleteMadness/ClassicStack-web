/** ATP client requester over LocalTalkStack. */

import * as atp from '../protocol/atp';
import type { LocalTalkStack } from '../net/stack';
import type { Datagram } from '../protocol/ddp';
import { log } from '../util/logger';

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
  /** ATP TReq bitmap of wanted response slots. Default 0xff; OpenSess / small AFP cmds use 0x01. */
  bitmap?: number;
  /** Skip the error log on timeout (ASP tickle). */
  quietTimeout?: boolean;
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

type AtpPending = {
  parts: Map<number, Uint8Array>;
  userData: number;
  resolve: (r: AtpResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  eomSeq: number | null;
  maxResp: number;
  xo: boolean;
  reqUserData: number;
  destNetwork: number;
  destNode: number;
  destSocket: number;
  srcSocket: number;
};

export class AtpClient {
  private stack: LocalTalkStack;
  private nextTid = 1;
  private pending = new Map<number, AtpPending>();
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
    // OmniTalk: 2s interval, 5 retries (6 attempts). ASP Command/OpenSess leave this default.
    const timeoutMs = req.timeoutMs ?? 2000;
    const retries = req.retries ?? 5;
    const bitmap = req.bitmap ?? 0xff;
    const maxResp = atp.maxRespFromBitmap(bitmap);
    const xo = !!req.xo;
    const quietTimeout = !!req.quietTimeout;
    const body = req.data ?? new Uint8Array();

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = retries + 1;

      const send = (bm: number) => {
        attempts++;
        let control = atp.TREQ | (xo ? atp.XO : 0);
        if (xo) control = atp.setTRelTimeout(control, atp.TRel30s);
        const payload = atp.encodePacket(
          { control, bitmap: bm, transId: tid, userData: req.userData },
          body,
        );
        log.trace(
          `ATP TReq tid=${tid} ${req.destNetwork}.${req.destNode}:${req.destSocket} xo=${xo} bm=0x${bm.toString(16)} try=${attempts}/${maxAttempts}`,
          'atp',
        );
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

      const armTimer = () => {
        const p = this.pending.get(tid);
        if (!p) return;
        p.timer = setTimeout(() => {
          const cur = this.pending.get(tid);
          if (!cur) return;
          if (atp.responseComplete(cur.maxResp, cur.parts, cur.eomSeq)) {
            this.tryFinish(tid, cur);
            return;
          }
          if (attempts < maxAttempts) {
            send(atp.missingBitmap(cur.maxResp, cur.parts, cur.eomSeq));
            armTimer();
          } else {
            this.pending.delete(tid);
            const msg = `ATP timeout tid=${tid} ${req.destNetwork}.${req.destNode}:${req.destSocket} xo=${xo} bm=0x${bitmap.toString(16)} after ${attempts} tries`;
            if (!quietTimeout) log.error(msg, 'atp');
            else log.trace(msg, 'atp');
            reject(new Error('atp: timeout'));
          }
        }, timeoutMs);
      };

      this.pending.set(tid, {
        parts: new Map(),
        userData: 0,
        resolve,
        reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        eomSeq: null,
        maxResp,
        xo,
        reqUserData: req.userData,
        destNetwork: req.destNetwork,
        destNode: req.destNode,
        destSocket: req.destSocket,
        srcSocket: req.srcSocket,
      });
      send(bitmap);
      armTimer();
    });
  }

  private tryFinish(tid: number, pend: AtpPending): void {
    if (!atp.responseComplete(pend.maxResp, pend.parts, pend.eomSeq)) return;
    let last = pend.eomSeq;
    if (last == null || last < 0) {
      last = 0;
      while (last + 1 < pend.maxResp && pend.parts.has(last + 1)) last++;
      if (!pend.parts.has(0)) return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i <= last; i++) {
      const part = pend.parts.get(i);
      if (!part) return;
      chunks.push(part);
      total += part.length;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.finishPending(tid, pend, out);
  }

  private finishPending(tid: number, pend: AtpPending, out: Uint8Array): void {
    clearTimeout(pend.timer);
    this.pending.delete(tid);
    if (pend.xo) {
      const trel = atp.encodePacket({
        control: atp.TREL,
        bitmap: 0,
        transId: tid,
        userData: pend.reqUserData,
      });
      void this.stack
        .send({
          hops: 0,
          destNetwork: pend.destNetwork,
          srcNetwork: this.stack.network,
          destNode: pend.destNode,
          srcSocket: pend.srcSocket,
          destSocket: pend.destSocket,
          srcNode: this.stack.node,
          ddpType: atp.DDPType,
          data: trel,
        })
        .catch(() => undefined);
    }
    pend.resolve({ userData: pend.userData, data: out, transId: tid });
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

    // STS is a bitmap of received packets, not a data sequence number.
    if (atp.hasSTS(header)) {
      log.trace(`ATP STS tid=${header.transId} bm=0x${header.bitmap.toString(16)}`, 'atp');
      return;
    }

    const seq = header.bitmap & 0x07;
    // Zero-length TResp still counts (OpenSess payload lives in UserData).
    if (!pend.parts.has(seq)) pend.parts.set(seq, data);
    if (seq === 0) pend.userData = header.userData;
    if (atp.hasEOM(header)) pend.eomSeq = seq;
    this.tryFinish(header.transId, pend);
  }
}
