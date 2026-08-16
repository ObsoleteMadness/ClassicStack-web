/**
 * LocalTalk node + DDP demux over WebSerial/TashTalk.
 * respondToEnq=false — TashTalk MCU owns ENQ/RTS defence on the physical segment.
 *
 * Claim path mirrors ClassicStack adapter/link/framing/localtalk.go:
 * arm the hardware node filter (setNodeIds) BEFORE announcing OnClaimed, and treat
 * inbound ENQ/ACK for the candidate as a collision that rerolls the probe burst.
 */

import * as llap from '../protocol/llap';
import * as ddp from '../protocol/ddp';
import type { Datagram } from '../protocol/ddp';
import type { WebSerialPort } from '../transport/webserial';
import { log } from '../util/logger';

export type DdpHandler = (dg: Datagram) => void;

/** Spec default: ~2s of ENQs at 250ms (ClassicStack llap.DefaultProbeCount). */
const DefaultProbeCount = 8;
const ProbeIntervalMs = 250;

export class LocalTalkStack {
  network = 0;
  node = llap.NodeUnclaimed;
  private desiredNode = llap.DefaultDesiredNode;
  private handlers = new Map<number, DdpHandler[]>();
  private anyHandlers: DdpHandler[] = [];
  private serial: WebSerialPort;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private claimed = false;
  private claiming = false;
  private probesLeft = 0;
  private onClaimedCbs: Array<(net: number, node: number) => void> = [];

  constructor(serial: WebSerialPort) {
    this.serial = serial;
    serial.onLlap((frame) => this.onLlap(frame));
  }

  onClaimed(cb: (net: number, node: number) => void): void {
    this.onClaimedCbs.push(cb);
  }

  onDatagram(socket: number, handler: DdpHandler): void {
    const list = this.handlers.get(socket) ?? [];
    list.push(handler);
    this.handlers.set(socket, list);
  }

  offDatagram(socket: number, handler: DdpHandler): void {
    const list = this.handlers.get(socket);
    if (!list) return;
    const next = list.filter((h) => h !== handler);
    if (next.length) this.handlers.set(socket, next);
    else this.handlers.delete(socket);
  }

  onAny(handler: DdpHandler): void {
    this.anyHandlers.push(handler);
  }

  async startClaim(desired = llap.DefaultDesiredNode): Promise<void> {
    this.desiredNode = desired || llap.DefaultDesiredNode;
    this.claimed = false;
    this.claiming = true;
    this.node = llap.NodeUnclaimed;
    this.beginProbeBurst();
    await this.sendProbe();
    this.clearClaimTimer();
    this.claimTimer = setInterval(() => {
      void this.onProbeTick();
    }, ProbeIntervalMs);
  }

  private beginProbeBurst(): void {
    this.probesLeft = DefaultProbeCount;
  }

  private async sendProbe(): Promise<void> {
    if (!this.claiming || this.claimed) return;
    log.trace(`LLAP ENQ probe for node ${this.desiredNode}`, 'stack');
    await this.serial.writeLlap(llap.enq(this.desiredNode));
    this.probesLeft--;
  }

  private async onProbeTick(): Promise<void> {
    if (this.claimed || !this.claiming) {
      this.clearClaimTimer();
      return;
    }
    if (this.probesLeft <= 0) {
      // Burst complete with no collision → claim.
      await this.finishClaim(this.desiredNode);
      return;
    }
    await this.sendProbe();
  }

  /**
   * Publish the claimed node: arm TashTalk's receive filter FIRST (ClassicStack gap),
   * then notify listeners. Without the filter the MCU drops every inbound frame.
   */
  private async finishClaim(node: number): Promise<void> {
    if (this.claimed) return;
    this.clearClaimTimer();
    this.claiming = false;
    try {
      await this.serial.setNodeIds([node]);
      log.info(`Armed TashTalk node filter for ${node}`, 'stack');
    } catch (err) {
      log.error(
        `Failed to arm TashTalk node filter: ${err instanceof Error ? err.message : String(err)}`,
        'stack',
      );
      // Still mark claimed so TX can proceed; RX will stay silent until filter works.
    }
    this.node = node;
    this.claimed = true;
    for (const cb of this.onClaimedCbs) cb(this.network, this.node);
  }

  private clearClaimTimer(): void {
    if (this.claimTimer) {
      clearInterval(this.claimTimer);
      this.claimTimer = null;
    }
  }

  /** Collision on our candidate: pick another node and restart the ENQ burst. */
  private rerollCandidate(): void {
    const prev = this.desiredNode;
    let next = prev - 1;
    if (next < llap.MinNode) next = llap.MaxNode;
    this.desiredNode = next;
    this.beginProbeBurst();
    log.info(`LLAP claim collision on ${prev}; rerolling to ${next}`, 'stack');
  }

  private onLlap(frame: Uint8Array): void {
    const hdr = llap.parseHeader(frame);
    if (!hdr) return;

    if (llap.isControl(hdr.type)) {
      this.onControl(hdr);
      return;
    }

    const payload = frame.subarray(llap.HeaderLen);
    let dg: Datagram;
    try {
      if (hdr.type === llap.TypeShortDDP) {
        dg = ddp.decodeShort(payload, this.network, hdr.dst, hdr.src);
      } else if (hdr.type === llap.TypeLongDDP) {
        dg = ddp.decodeLong(payload);
      } else {
        // RTS/CTS (0x84/0x85) and other non-DDP — TashTalk MCU owns CSMA.
        return;
      }
    } catch {
      return;
    }

    // Learn network from long-header inbound when still 0.
    if (this.network === 0 && dg.destNetwork !== 0) {
      this.network = dg.destNetwork;
    }

    for (const h of this.anyHandlers) h(dg);
    const list = this.handlers.get(dg.destSocket);
    if (list) for (const h of list) h(dg);
  }

  private onControl(hdr: llap.LlapHeader): void {
    // respondToEnq=false: once claimed, hardware defends; we never ACK.
    if (this.claimed || !this.claiming) return;

    // Spec collision detection: ENQ or ACK for our candidate → peer owns/probes it.
    const hitsCandidate =
      (hdr.type === llap.TypeENQ || hdr.type === llap.TypeACK) && hdr.dst === this.desiredNode;
    if (!hitsCandidate) return;
    this.rerollCandidate();
  }

  async send(dg: Datagram, broadcast = false): Promise<void> {
    if (!this.claimed || this.node === llap.NodeUnclaimed) {
      throw new Error('node not claimed');
    }
    const srcNode = this.node;
    const dstNode = broadcast ? llap.BroadcastNode : dg.destNode;
    const sameNet =
      (dg.destNetwork === 0 || dg.destNetwork === this.network) &&
      (dg.srcNetwork === 0 || dg.srcNetwork === this.network);
    const useShort = sameNet || this.network === 0;

    let payload: Uint8Array;
    if (useShort) {
      payload = ddp.encodeShort(dg.destSocket, dg.srcSocket, dg.ddpType, dg.data);
    } else {
      payload = ddp.encodeLong({
        ...dg,
        srcNode,
        srcNetwork: dg.srcNetwork || this.network,
      });
    }
    const frame = ddp.wrapLlap(dstNode, srcNode, !useShort, payload);
    await this.serial.writeLlap(frame);
  }

  async broadcast(srcSocket: number, ddpType: number, data: Uint8Array, destSocket: number): Promise<void> {
    await this.send(
      {
        hops: 0,
        destNetwork: this.network,
        srcNetwork: this.network,
        destNode: llap.BroadcastNode,
        srcNode: this.node,
        destSocket,
        srcSocket,
        ddpType,
        data,
      },
      true,
    );
  }

  stop(): void {
    this.clearClaimTimer();
    this.claiming = false;
  }
}
