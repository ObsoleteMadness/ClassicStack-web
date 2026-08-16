/**
 * Classic Mac AppleTalk Netboot server (ABP + ChainBoot EBP).
 * Port of ClassicStack core/service/netboot (Elliot Nunn / Apple SuperMario).
 */

import * as abp from '../protocol/abp';
import type { Datagram } from '../protocol/ddp';
import type { LocalTalkStack } from '../net/stack';
import { appendTrailer, hasValidTrailer } from '../hash/snefru/snefru';
import { log } from '../util/logger';
import { decodeMacRoman } from '../protocol/macroman';

export const Socket = 10;
export const ChainSocket = Socket + 1;
export const NBPType = 'BootServer';
export const DefaultPaceMs = 2;
export const DefaultChainPaceMs = 10;

export interface BootDisk {
  size(): number;
  readAt(buf: Uint8Array, offset: number): number;
  writeAt(buf: Uint8Array, offset: number): number;
}

/** In-memory mutable HFS image for ChainBoot. */
export class MemoryDisk implements BootDisk {
  private data: Uint8Array;

  constructor(initial: Uint8Array) {
    this.data = new Uint8Array(initial);
  }

  size(): number {
    return this.data.length;
  }

  bytes(): Uint8Array {
    return this.data;
  }

  readAt(buf: Uint8Array, offset: number): number {
    if (offset >= this.data.length) {
      buf.fill(0);
      return buf.length;
    }
    const n = Math.min(buf.length, this.data.length - offset);
    buf.set(this.data.subarray(offset, offset + n), 0);
    if (n < buf.length) buf.fill(0, n);
    return buf.length;
  }

  writeAt(buf: Uint8Array, offset: number): number {
    const end = offset + buf.length;
    if (end > this.data.length) {
      const next = new Uint8Array(end);
      next.set(this.data);
      this.data = next;
    }
    this.data.set(buf, offset);
    return buf.length;
  }
}

export interface NameRegistrar {
  registerAnyObject(object: string, type: string, socket: number, zone?: string): void;
  unregister(object: string, type: string): void;
}

export interface NetbootConfig {
  payload: Uint8Array;
  blockSize: number;
  disk?: BootDisk | null;
  paceMs?: number;
  chainPaceMs?: number;
  nbpObject?: string;
  zone?: string;
}

interface Queued {
  dg: Datagram;
}

interface WriteWindow {
  seq: number;
  hunk: number;
  got: number;
  buf: Uint8Array;
}

interface ChainReadState {
  offset: number;
  count: number;
  retries: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const t = setTimeout(() => resolve(true), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve(false);
      },
      { once: true },
    );
  });
}

/** Escalate EBP reply pace on consecutive chunk retries (ClassicStack chainBackoffPace). */
export function chainBackoffPace(baseMs: number, retries: number, count: number): number {
  if (retries <= 0) return baseMs;
  let pace = baseMs * (1 << Math.min(retries, 4));
  const lim = 800 / (count + 1);
  if (pace > lim) pace = lim;
  return Math.max(pace, baseMs);
}

function wantedBlocks(bitmap: Uint8Array, blocks: number): number[] {
  const out: number[] = [];
  for (let blk = 0; blk < blocks; blk++) {
    if (blk / 8 < bitmap.length && ((bitmap[Math.floor(blk / 8)]! >> (blk % 8)) & 1) === 1) {
      out.push(blk);
    }
  }
  return out;
}

/**
 * Assemble an ABP boot payload with Snefru trailer (ClassicStack loadPayload).
 * imageBytes: optional RAM-disk contents concatenated onto the stub.
 */
export function assemblePayload(
  payload: Uint8Array,
  blockSize: number,
  imageBytes?: Uint8Array | null,
): Uint8Array {
  let data: Uint8Array;
  if (imageBytes && imageBytes.length > 0) {
    const combined = new Uint8Array(payload.length + imageBytes.length);
    combined.set(payload);
    combined.set(imageBytes, payload.length);
    data = appendTrailer(combined, blockSize);
  } else if (hasValidTrailer(payload) && payload.length % blockSize === 0) {
    data = payload;
  } else {
    data = appendTrailer(payload, blockSize);
  }
  const blocks = data.length / blockSize;
  if (blocks > abp.MaxImageBlocks) {
    throw new Error(
      `netboot: payload exceeds client bitmap (${blocks} blocks of ${blockSize}); use ChainLoader + disk`,
    );
  }
  return data;
}

export class NetbootService {
  private stack: LocalTalkStack;
  private names: NameRegistrar | null;
  private payload: Uint8Array;
  private blockSize: number;
  private disk: BootDisk | null;
  private paceMs: number;
  private chainPaceMs: number;
  private nbpObject: string;
  private zone: string;

  private queue: Queued[] = [];
  private pumping = false;
  private running = false;
  private abort: AbortController | null = null;
  private readonly onBoot: (dg: Datagram) => void;
  private readonly onChain: (dg: Datagram) => void;

  private windows = new Map<number, WriteWindow>();
  private chainRetry = new Map<number, ChainReadState>();
  private sendRound = 0;

  constructor(stack: LocalTalkStack, cfg: NetbootConfig, names: NameRegistrar | null = null) {
    this.stack = stack;
    this.names = names;
    this.payload = cfg.payload;
    this.blockSize = cfg.blockSize > 0 ? cfg.blockSize : abp.DiskSector;
    this.disk = cfg.disk ?? null;
    this.paceMs = cfg.paceMs && cfg.paceMs > 0 ? cfg.paceMs : DefaultPaceMs;
    this.chainPaceMs = cfg.chainPaceMs && cfg.chainPaceMs > 0 ? cfg.chainPaceMs : DefaultChainPaceMs;
    this.nbpObject = cfg.nbpObject || '0000';
    this.zone = cfg.zone || '*';
    this.onBoot = (dg) => this.enqueue(dg);
    this.onChain = (dg) => this.enqueue(dg);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.stack.onDatagram(Socket, this.onBoot);
    this.stack.onDatagram(ChainSocket, this.onChain);
    this.names?.registerAnyObject(this.nbpObject, NBPType, Socket, this.zone);
    log.info(
      `Netboot started: ${this.payload.length / this.blockSize} payload blocks × ${this.blockSize}, chainboot=${!!this.disk}`,
      'netboot',
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.stack.offDatagram(Socket, this.onBoot);
    this.stack.offDatagram(ChainSocket, this.onChain);
    this.names?.unregister(this.nbpObject, NBPType);
    this.queue = [];
    log.info('Netboot stopped', 'netboot');
  }

  private enqueue(dg: Datagram): void {
    if (!this.running || dg.ddpType !== abp.DDPType) return;
    if (this.queue.length >= 256) return;
    this.queue.push({ dg });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running && this.queue.length) {
        const item = this.queue.shift()!;
        await this.handlePacket(item.dg);
      }
    } finally {
      this.pumping = false;
      if (this.running && this.queue.length) void this.pump();
    }
  }

  private async reply(dg: Datagram, data: Uint8Array): Promise<void> {
    await this.stack.send({
      hops: 0,
      destNetwork: dg.srcNetwork,
      srcNetwork: this.stack.network,
      destNode: dg.srcNode,
      srcNode: this.stack.node,
      destSocket: dg.srcSocket,
      srcSocket: dg.destSocket,
      ddpType: abp.DDPType,
      data,
    });
  }

  private async handlePacket(dg: Datagram): Promise<void> {
    const cmd = abp.command(dg.data);
    switch (cmd) {
      case abp.CmdUserRecordRequest:
        await this.handleMapUser(dg);
        break;
      case abp.CmdBootImageRequest:
        await this.handleImageRequest(dg);
        break;
      case abp.CmdChainRead:
        await this.handleChainRead(dg);
        break;
      case abp.CmdChainWrite:
        await this.handleChainWrite(dg);
        break;
      default:
        break;
    }
  }

  private async handleMapUser(dg: Datagram): Promise<void> {
    if (!this.payload.length) {
      log.warn('Boot request ignored — no payload', 'netboot');
      return;
    }
    let req: ReturnType<typeof abp.unmarshalUserRecordRequest>;
    try {
      req = abp.unmarshalUserRecordRequest(dg.data);
    } catch {
      return;
    }
    const user = decodeMacRoman(req.userName);
    log.info(
      `Boot request (rbMapUser) from node ${dg.srcNode}: user=${user || '(none)'} machineID=${req.machineID}`,
      'netboot',
    );
    const reply = abp.marshalBootPktRply({
      osID: abp.MachineMac,
      userData: req.timestamp,
      blockSize: this.blockSize,
      imageID: 0,
      result: 0,
      imageSize: this.payload.length / this.blockSize,
    });
    await this.reply(dg, reply);
  }

  private async handleImageRequest(dg: Datagram): Promise<void> {
    if (!this.payload.length) return;
    let req: ReturnType<typeof abp.unmarshalBootImageRequest>;
    try {
      req = abp.unmarshalBootImageRequest(dg.data);
    } catch {
      return;
    }

    // Coalesce fresher rbImageRequest packets from the same client.
    for (let i = 0; i < this.queue.length; ) {
      const q = this.queue[i]!;
      const same =
        q.dg.srcNetwork === dg.srcNetwork &&
        q.dg.srcNode === dg.srcNode &&
        q.dg.srcSocket === dg.srcSocket &&
        abp.command(q.dg.data) === abp.CmdBootImageRequest;
      if (same) {
        try {
          req = abp.unmarshalBootImageRequest(q.dg.data);
          dg = q.dg;
        } catch {
          /* keep previous */
        }
        this.queue.splice(i, 1);
      } else {
        i++;
      }
    }

    const blocks = this.payload.length / this.blockSize;
    let wanted = wantedBlocks(req.bitmap, blocks);
    let mode = 'bitmap';
    if (!wanted.length) {
      wanted = Array.from({ length: blocks }, (_, i) => i);
      mode = 'flood';
    }
    const start = this.sendRound % wanted.length;
    this.sendRound++;
    log.info(
      `Payload requested (${mode}): ${wanted.length}/${blocks} blocks, rotate=${start}, node=${dg.srcNode}`,
      'netboot',
    );

    const signal = this.abort?.signal;
    for (let i = 0; i < wanted.length; i++) {
      if (!this.running) return;
      const blk = wanted[(start + i) % wanted.length]!;
      const pkt = abp.marshalBootBlock({
        imageID: req.imageID,
        blockNo: blk,
        data: this.payload.subarray(blk * this.blockSize, (blk + 1) * this.blockSize),
      });
      await this.reply(dg, pkt);
      if (!(await sleep(this.paceMs, signal))) return;
    }
  }

  private clientKey(dg: Datagram): number {
    return ((dg.srcNetwork & 0xffff) << 16) | ((dg.srcNode & 0xff) << 8) | (dg.srcSocket & 0xff);
  }

  private async handleChainRead(dg: Datagram): Promise<void> {
    if (!this.disk) {
      log.warn('Chain read ignored — no disk image', 'netboot');
      return;
    }
    let req: ReturnType<typeof abp.unmarshalChainReadRequest>;
    try {
      req = abp.unmarshalChainReadRequest(dg.data);
    } catch {
      return;
    }
    if (req.blockOffset * abp.ChainBlockSize >= this.disk.size()) {
      log.warn(`Chain read beyond EOF (offset=${req.blockOffset}) — ignored`, 'netboot');
      return;
    }
    const count = Math.min(req.blockCount, abp.ChunkBlocks);
    if (count === 0) return;

    const key = this.clientKey(dg);
    let st = this.chainRetry.get(key);
    if (st && st.offset === req.blockOffset && st.count === count) {
      st.retries++;
    } else {
      st = { offset: req.blockOffset, count, retries: 0 };
      this.chainRetry.set(key, st);
    }
    const pace = chainBackoffPace(this.chainPaceMs, st.retries, count);
    const signal = this.abort?.signal;

    // Hold one pace before first reply (client arms filter asynchronously).
    if (!(await sleep(pace, signal))) return;

    for (let i = 0; i < count; i++) {
      if (!this.running) return;
      const buf = new Uint8Array(abp.ChainBlockSize);
      const off = (req.blockOffset + i) * abp.ChainBlockSize;
      this.disk.readAt(buf, off);
      await this.reply(
        dg,
        abp.marshalChainReadData({ blkIndex: i, seq: req.seq, data: buf }),
      );
      if (!(await sleep(pace, signal))) return;
    }
  }

  private async handleChainWrite(dg: Datagram): Promise<void> {
    if (!this.disk) {
      log.warn('Chain write ignored — no disk image', 'netboot');
      return;
    }
    let req: ReturnType<typeof abp.unmarshalChainWriteBlock>;
    try {
      req = abp.unmarshalChainWriteBlock(dg.data);
    } catch {
      return;
    }

    const key = this.clientKey(dg);
    let w = this.windows.get(key);
    if (!w || w.seq !== req.seq) {
      if (w && w.got !== 0) this.evictWindow(w, dg.srcNode);
      w = {
        seq: req.seq,
        hunk: req.hunkStart,
        got: 0,
        buf: new Uint8Array(abp.ChunkBlocks * abp.ChainBlockSize),
      };
      this.windows.set(key, w);
    }

    const idx = (req.blkIndex & ~abp.ChainLastFlag) % abp.ChunkBlocks;
    w.got |= 1 << idx;
    let data = req.data;
    if (data.length > abp.ChainBlockSize) data = data.subarray(0, abp.ChainBlockSize);
    w.buf.set(data, idx * abp.ChainBlockSize);

    if ((req.blkIndex & abp.ChainLastFlag) === 0) return;

    const commit = w.buf.subarray(0, (idx + 1) * abp.ChainBlockSize);
    const off = req.hunkStart * abp.ChainBlockSize;
    if (req.hunkStart <= 1) {
      log.warn(`Chain write targets boot blocks (hunkStart=${req.hunkStart})`, 'netboot');
    }
    this.disk.writeAt(commit, off);
    this.windows.delete(key);

    if (!(await sleep(this.chainPaceMs, this.abort?.signal))) return;
    await this.reply(dg, abp.marshalChainWriteAck({ seq: req.seq }));
  }

  private evictWindow(w: WriteWindow, node: number): void {
    if (!this.disk) return;
    let n = 0;
    while (n < abp.ChunkBlocks && (w.got & (1 << n)) !== 0) n++;
    if (n === 0) return;
    this.disk.writeAt(w.buf.subarray(0, n * abp.ChainBlockSize), w.hunk * abp.ChainBlockSize);
    log.warn(
      `Chain write chunk had no last flag — committed ${n} blocks on eviction (node ${node})`,
      'netboot',
    );
  }
}
