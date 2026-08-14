/** NBP registry + lookup over LocalTalkStack. */

import * as nbp from '../protocol/nbp';
import { encodeMacRoman, decodeMacRoman } from '../protocol/macroman';
import type { LocalTalkStack } from '../net/stack';
import type { Datagram } from '../protocol/ddp';

export interface RegisteredName {
  object: string;
  type: string;
  zone: string;
  socket: number;
  /** Match any object of this type and echo the querier's object in the reply. */
  anyObject?: boolean;
}

export interface LookupResult {
  object: string;
  type: string;
  zone: string;
  network: number;
  node: number;
  socket: number;
}

export class NbpService {
  private stack: LocalTalkStack;
  private registry: RegisteredName[] = [];
  private nbpId = 1;
  private pending = new Map<
    number,
    { results: LookupResult[]; resolve: (r: LookupResult[]) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(stack: LocalTalkStack) {
    this.stack = stack;
    stack.onDatagram(nbp.SASSocket, (dg) => this.onPacket(dg));
  }

  register(object: string, type: string, socket: number, zone = '*'): void {
    this.registry.push({ object, type, zone, socket });
  }

  /**
   * Register a name that answers lookups for ANY object of the given type,
   * echoing the requested object (needed for BootServer / PRAM serverNum).
   */
  registerAnyObject(object: string, type: string, socket: number, zone = '*'): void {
    const existing = this.registry.find(
      (r) => r.object.toLowerCase() === object.toLowerCase() && r.type.toLowerCase() === type.toLowerCase(),
    );
    if (existing) {
      existing.socket = socket;
      existing.zone = zone;
      existing.anyObject = true;
      return;
    }
    this.registry.push({ object, type, zone, socket, anyObject: true });
  }

  unregister(object: string, type: string): void {
    this.registry = this.registry.filter((r) => !(r.object === object && r.type === type));
  }

  async lookup(object = '=', type = 'AFPServer', zone = '*', timeoutMs = 2000): Promise<LookupResult[]> {
    const id = this.nbpId++ & 0xff;
    if (id === 0) this.nbpId = 1;
    const ent = {
      object: object === '=' ? new Uint8Array([nbp.NameWildcard]) : encodeMacRoman(object),
      type: type === '=' ? new Uint8Array([nbp.NameWildcard]) : encodeMacRoman(type),
      zone: encodeMacRoman(zone),
    };
    const pkt = nbp.buildLkUp(
      nbp.CtrlBrRq,
      id,
      this.stack.network,
      this.stack.node,
      nbp.SASSocket,
      ent.object,
      ent.type,
      ent.zone,
    );

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        resolve(dedupe(p?.results ?? []));
      }, timeoutMs);
      this.pending.set(id, { results: [], resolve, timer });
      void this.stack.broadcast(nbp.SASSocket, nbp.DDPType, pkt, nbp.SASSocket);
    });
  }

  private onPacket(dg: Datagram): void {
    let pkt: nbp.Packet;
    try {
      pkt = nbp.parsePacket(dg.data);
    } catch {
      return;
    }

    if (pkt.function === nbp.CtrlLkUpRply) {
      const pend = this.pending.get(pkt.nbpId);
      if (!pend) return;
      for (const t of pkt.tuples) {
        pend.results.push({
          object: decodeMacRoman(t.object),
          type: decodeMacRoman(t.type),
          zone: decodeMacRoman(t.zone),
          network: t.network || dg.srcNetwork,
          node: t.node,
          socket: t.socket,
        });
      }
      return;
    }

    if (pkt.function === nbp.CtrlLkUp || pkt.function === nbp.CtrlBrRq) {
      const t = pkt.tuples[0];
      if (!t) return;
      for (const reg of this.registry) {
        const typ = encodeMacRoman(reg.type);
        const zone = encodeMacRoman(reg.zone);
        if (!nbp.matches(t.type, typ)) continue;
        let replyObj = encodeMacRoman(reg.object);
        if (reg.anyObject) {
          const wildcard = t.object.length === 1 && t.object[0] === nbp.NameWildcard;
          if (!wildcard && t.object.length > 0) replyObj = t.object;
        } else if (!nbp.matches(t.object, replyObj)) {
          continue;
        }
        const reply = nbp.buildLkUpRply(
          pkt.nbpId,
          this.stack.network,
          this.stack.node,
          reg.socket,
          replyObj,
          typ,
          zone,
        );
        void this.stack.send({
          hops: 0,
          destNetwork: dg.srcNetwork,
          srcNetwork: this.stack.network,
          destNode: dg.srcNode,
          srcNode: this.stack.node,
          destSocket: dg.srcSocket || nbp.SASSocket,
          srcSocket: nbp.SASSocket,
          ddpType: nbp.DDPType,
          data: reply,
        });
      }
    }
  }
}

function dedupe(results: LookupResult[]): LookupResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = `${r.network}.${r.node}.${r.socket}:${r.object}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
