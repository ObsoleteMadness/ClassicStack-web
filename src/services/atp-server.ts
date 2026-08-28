/** ATP server: demux TReq (and optional TResp) on a DDP socket. */

import * as atp from '../protocol/atp';
import type { LocalTalkStack } from '../net/stack';
import type { Datagram } from '../protocol/ddp';

export interface AtpIncoming {
  dg: Datagram;
  header: atp.Header;
  data: Uint8Array;
  reply: (userData: number, data: Uint8Array) => Promise<void>;
}

export interface AtpResponse {
  dg: Datagram;
  header: atp.Header;
  data: Uint8Array;
  eom: boolean;
}

export type AtpServerHandler = (req: AtpIncoming) => void | Promise<void>;
export type AtpResponseHandler = (resp: AtpResponse) => void | Promise<void>;

export class AtpServer {
  private stack: LocalTalkStack;
  private socket: number;
  private handler: AtpServerHandler;
  private onResponse: AtpResponseHandler | null = null;
  /** In-flight TResp send per TID — a retry must not overlap the first blast. */
  private tRespByTid = new Map<number, Promise<void>>();

  constructor(stack: LocalTalkStack, socket: number, handler: AtpServerHandler) {
    this.stack = stack;
    this.socket = socket;
    this.handler = handler;
    stack.onDatagram(socket, (dg) => void this.onDdp(dg));
  }

  /** Observe TResp packets (needed for ASP WriteContinue data responses). */
  setResponseHandler(handler: AtpResponseHandler | null): void {
    this.onResponse = handler;
  }

  getSocket(): number {
    return this.socket;
  }

  /** Send a server-initiated ATP packet to a workstation. */
  async sendTo(
    destNetwork: number,
    destNode: number,
    destSocket: number,
    packet: Uint8Array,
  ): Promise<void> {
    await this.stack.send({
      hops: 0,
      destNetwork,
      srcNetwork: this.stack.network,
      destNode,
      srcNode: this.stack.node,
      destSocket,
      srcSocket: this.socket,
      ddpType: atp.DDPType,
      data: packet,
    });
  }

  private async onDdp(dg: Datagram): Promise<void> {
    if (dg.ddpType !== atp.DDPType) return;
    let decoded: { header: atp.Header; data: Uint8Array };
    try {
      decoded = atp.decodePacket(dg.data);
    } catch {
      return;
    }
    const fn = atp.funcCode(decoded.header);
    if (fn === atp.TRESP) {
      if (this.onResponse) {
        await this.onResponse({
          dg,
          header: decoded.header,
          data: decoded.data,
          eom: atp.hasEOM(decoded.header),
        });
      }
      return;
    }
    if (fn !== atp.TREQ) return;

    const reply = async (userData: number, data: Uint8Array) => {
      const tid = decoded.header.transId;
      const run = () => this.sendTRespPackets(dg, decoded.header, userData, data);
      const prev = this.tRespByTid.get(tid) ?? Promise.resolve();
      const next = prev.then(run, run);
      this.tRespByTid.set(tid, next);
      try {
        await next;
      } finally {
        if (this.tRespByTid.get(tid) === next) this.tRespByTid.delete(tid);
      }
    };

    await this.handler({ dg, header: decoded.header, data: decoded.data, reply });
  }

  private async sendTRespPackets(
    dg: Datagram,
    header: atp.Header,
    userData: number,
    data: Uint8Array,
  ): Promise<void> {
    const packets = atp.encodeTRespPackets(header.transId, userData, data, header.bitmap);
    for (const pkt of packets) {
      await this.stack.send({
        hops: 0,
        destNetwork: dg.srcNetwork,
        srcNetwork: this.stack.network,
        destNode: dg.srcNode,
        srcNode: this.stack.node,
        destSocket: dg.srcSocket,
        srcSocket: this.socket,
        ddpType: atp.DDPType,
        data: pkt,
      });
    }
  }
}
