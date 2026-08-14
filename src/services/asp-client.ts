/** ASP client session over ATP. */

import * as asp from '../protocol/asp';
import { be16, u32ToI32 } from '../protocol/binary';
import type { AtpClient } from './atp-client';
import { log } from '../util/logger';

let nextWss = 128;

export class AspSession {
  private atp: AtpClient;
  private destNetwork: number;
  private destNode: number;
  private destSocket: number; // SSS after open, or SLS before
  private wssSocket: number;
  private sessionId = 0;
  private seq = 0;
  private seqInit = false;
  private tickleTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending ASP Write data keyed by sequence (answered by WriteContinue). */
  private pendingWrites = new Map<number, Uint8Array>();
  private wssReady = false;
  /**
   * System 7 ASP accepts one Command/Write at a time and silently drops any
   * other sequence (OmniTalk errata). Finder icon prefetch used to pipeline
   * Enumerate + GetFileDirParms; the Mac then answered none of them.
   */
  private cmdTail: Promise<unknown> = Promise.resolve();
  opened = false;
  /** Fired after an SPAttention TReq is acked (attention code in the ASP word). */
  onAttention: ((code: number) => void) | null = null;
  /** Fired after a server-initiated SPCloseSession is acked. */
  onServerClose: (() => void) | null = null;

  constructor(
    atp: AtpClient,
    destNetwork: number,
    destNode: number,
    slsSocket: number,
  ) {
    this.atp = atp;
    this.destNetwork = destNetwork;
    this.destNode = destNode;
    this.destSocket = slsSocket;
    this.wssSocket = nextWss++;
    if (nextWss > 250) nextWss = 128;
  }

  /** ASP GetStatus → FPGetSrvrInfo body (no session). */
  async getStatus(): Promise<Uint8Array> {
    log.info(
      `ASP GetStatus ${this.destNetwork}.${this.destNode}:${this.destSocket} wss=${this.wssSocket}`,
      'asp',
    );
    const resp = await this.atp.request({
      destNetwork: this.destNetwork,
      destNode: this.destNode,
      destSocket: this.destSocket,
      srcSocket: this.wssSocket,
      userData: asp.packGetStatus(),
      bitmap: 0xff,
    });
    return resp.data;
  }

  async open(): Promise<void> {
    log.info(
      `ASP OpenSess ${this.destNetwork}.${this.destNode}:${this.destSocket} wss=${this.wssSocket}`,
      'asp',
    );
    const resp = await this.atp.request({
      destNetwork: this.destNetwork,
      destNode: this.destNode,
      destSocket: this.destSocket,
      srcSocket: this.wssSocket,
      userData: asp.packOpenSess(this.wssSocket),
      xo: false,
      bitmap: 0x01,
    });
    const sss = (resp.userData >>> 24) & 0xff;
    const sid = (resp.userData >>> 16) & 0xff;
    const err = (resp.userData << 16) >> 16;
    if (err !== 0) throw new Error(`ASP OpenSess error ${err}`);
    log.info(`ASP session ${sid} SSS=${sss}`, 'asp');
    this.destSocket = sss;
    this.sessionId = sid;
    this.opened = true;
    this.seq = 0;
    this.seqInit = false;
    this.ensureWssHandler();
    this.tickleTimer = setInterval(() => {
      void this.atp
        .request({
          destNetwork: this.destNetwork,
          destNode: this.destNode,
          destSocket: this.destSocket,
          srcSocket: this.wssSocket,
          userData: asp.packTickle(this.sessionId),
          timeoutMs: 5000,
          retries: 1,
          bitmap: 0x01,
          quietTimeout: true,
        })
        .catch(() => undefined);
    }, asp.TickleIntervalMs);
  }

  /**
   * Answer server-initiated TReqs on the workstation session socket:
   * WriteContinue (data pull), Tickle, Attention, CloseSession (OmniTalk serveWSS).
   */
  private ensureWssHandler(): void {
    if (this.wssReady) return;
    this.wssReady = true;
    this.atp.onTReq(this.wssSocket, async (req) => {
      const { spFunc, word: seq } = asp.unpackUserData(req.header.userData);
      switch (spFunc) {
        case asp.SPFuncWriteContinue: {
          let data = this.pendingWrites.get(seq) ?? new Uint8Array();
          const bufSize = req.data.length >= 2 ? be16(req.data, 0) : 0;
          if (bufSize > 0 && bufSize < data.length) data = data.subarray(0, bufSize);
          await this.atp.replyTReq(req.dg, req.header, req.header.userData, data);
          break;
        }
        case asp.SPFuncTickle:
          await this.atp.replyTReq(req.dg, req.header, 0, new Uint8Array());
          break;
        case asp.SPFuncAttention: {
          const { word } = asp.unpackUserData(req.header.userData);
          // Observed AppleShare: TResp user bytes are four zeros.
          await this.atp.replyTReq(req.dg, req.header, 0, new Uint8Array());
          this.onAttention?.(word);
          break;
        }
        case asp.SPFuncCloseSess:
          await this.atp.replyTReq(req.dg, req.header, 0, new Uint8Array());
          this.stopTickle();
          this.opened = false;
          this.onServerClose?.();
          break;
        default:
          await this.atp.replyTReq(req.dg, req.header, req.header.userData, new Uint8Array());
          break;
      }
    });
  }

  /**
   * First Command/Write on a session MUST be sequence 0 (OmniTalk nextSeq).
   * System 7 ASP silently drops any other first sequence.
   */
  private nextSeq(): number {
    if (!this.seqInit) {
      this.seqInit = true;
      this.seq = 0;
      return 0;
    }
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** Run Command/Write strictly one-at-a-time (same seq space). */
  private enqueueCmd<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.cmdTail.then(fn, fn);
    this.cmdTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async command(
    block: Uint8Array,
    opts?: { bitmap?: number; timeoutMs?: number },
  ): Promise<{ result: number; data: Uint8Array }> {
    if (!this.opened) throw new Error('ASP session not open');
    return this.enqueueCmd(async () => {
      const seq = this.nextSeq();
      log.trace(
        `ASP Command sess=${this.sessionId} seq=${seq} ${block.length}b`,
        'asp',
      );
      const resp = await this.atp.request({
        destNetwork: this.destNetwork,
        destNode: this.destNode,
        destSocket: this.destSocket,
        srcSocket: this.wssSocket,
        userData: asp.packCommand(this.sessionId, seq),
        data: block,
        xo: true,
        bitmap: opts?.bitmap ?? 0x01,
        timeoutMs: opts?.timeoutMs,
      });
      return { result: u32ToI32(resp.userData), data: resp.data };
    });
  }

  /**
   * Two-phase ASP Write (OmniTalk client/asp Write):
   * 1. XO TReq to SSS with `cmdBlock` only (e.g. 12-byte FPWrite header naming reqCount).
   * 2. Server pulls `writeData` via WriteContinue TReq to our WSS (answered here).
   * 3. Server replies to phase-1 with AFP result + reply body.
   */
  async write(cmdBlock: Uint8Array, writeData: Uint8Array): Promise<{ result: number; data: Uint8Array }> {
    if (!this.opened) throw new Error('ASP session not open');
    this.ensureWssHandler();
    return this.enqueueCmd(async () => {
      const seq = this.nextSeq();
      this.pendingWrites.set(seq, writeData);
      try {
        const resp = await this.atp.request({
          destNetwork: this.destNetwork,
          destNode: this.destNode,
          destSocket: this.destSocket,
          srcSocket: this.wssSocket,
          userData: asp.packWrite(this.sessionId, seq),
          data: cmdBlock,
          xo: true,
          timeoutMs: 15000,
          bitmap: 0x01,
        });
        return { result: u32ToI32(resp.userData), data: resp.data };
      } finally {
        this.pendingWrites.delete(seq);
      }
    });
  }

  private stopTickle(): void {
    if (this.tickleTimer) clearInterval(this.tickleTimer);
    this.tickleTimer = null;
  }

  async close(): Promise<void> {
    this.stopTickle();
    if (!this.opened) return;
    try {
      await this.atp.request({
        destNetwork: this.destNetwork,
        destNode: this.destNode,
        destSocket: this.destSocket,
        srcSocket: this.wssSocket,
        userData: asp.packClose(this.sessionId),
        timeoutMs: 3000,
        retries: 1,
        bitmap: 0x01,
      });
    } catch {
      /* ignore */
    }
    this.opened = false;
  }
}
