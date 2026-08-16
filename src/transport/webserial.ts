/** WebSerial transport for TashTalk at 1 Mbaud 8N1 with RTS/CTS. */

import {
  buildInitSequence,
  encodeOutbound,
  encodeSetNodeIds,
  TashTalkDecoder,
} from './tashtalk';

export type FrameHandler = (llap: Uint8Array) => void;
export type FrameDirection = 'rx' | 'tx';
export type FrameTap = (llap: Uint8Array, direction: FrameDirection) => void;

export class WebSerialPort {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private decoder = new TashTalkDecoder();
  private abort: AbortController | null = null;
  private onFrame: FrameHandler | null = null;
  private taps: FrameTap[] = [];
  /** Serialize host→device writes so TX frames and set-node-ids commands never interleave. */
  private writeChain: Promise<void> = Promise.resolve();
  connected = false;

  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  onLlap(handler: FrameHandler): void {
    this.onFrame = handler;
  }

  /** Observe decoded LLAP frames in both directions (for pcap / diagnostics). */
  tapFrames(handler: FrameTap): () => void {
    this.taps.push(handler);
    return () => {
      this.taps = this.taps.filter((h) => h !== handler);
    };
  }

  async connect(filters: SerialPortFilter[] = []): Promise<void> {
    if (!WebSerialPort.supported()) {
      throw new Error('WebSerial is not available in this browser');
    }
    const port = await navigator.serial.requestPort({ filters });
    // rtscts=True in tashrouter; TashTalk deasserts CTS when its 128-byte UART queue is half-full.
    await port.open({
      baudRate: 1_000_000,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'hardware',
    });
    this.port = port;
    this.writer = port.writable!.getWriter();
    this.decoder = new TashTalkDecoder();
    this.writeChain = Promise.resolve();
    await this.writeRaw(buildInitSequence());
    this.abort = new AbortController();
    this.connected = true;
    void this.readLoop(this.abort.signal);
  }

  async disconnect(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    this.reader?.releaseLock();
    this.reader = null;
    try {
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    this.writer = null;
    await this.port?.close().catch(() => undefined);
    this.port = null;
    this.connected = false;
  }

  async writeLlap(frame: Uint8Array): Promise<void> {
    this.emitTap(frame, 'tx');
    await this.writeRaw(encodeOutbound(frame));
  }

  /**
   * Arm the TashTalk hardware receive filter for these node IDs (1..254).
   * Required for any inbound traffic — the MCU bitmap starts empty after init.
   * Mirrors ClassicStack SetNodeAddress; must complete before the stack goes live.
   */
  async setNodeIds(nodes: number[]): Promise<void> {
    await this.writeRaw(encodeSetNodeIds(nodes));
  }

  private writeRaw(data: Uint8Array): Promise<void> {
    if (!this.writer) return Promise.reject(new Error('serial not connected'));
    const writer = this.writer;
    const next = this.writeChain.then(() => writer.write(data));
    // Keep the chain alive across failures so a later write still runs.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private emitTap(frame: Uint8Array, direction: FrameDirection): void {
    for (const tap of this.taps) tap(frame, direction);
  }

  private async readLoop(signal: AbortSignal): Promise<void> {
    if (!this.port?.readable) return;
    this.reader = this.port.readable.getReader();
    try {
      while (!signal.aborted) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        this.decoder.feed(value);
        for (;;) {
          const frame = this.decoder.take();
          if (!frame) break;
          this.emitTap(frame, 'rx');
          this.onFrame?.(frame);
        }
      }
    } catch (e) {
      if (!signal.aborted) console.error('serial read error', e);
    } finally {
      try {
        this.reader.releaseLock();
      } catch {
        /* ignore */
      }
      this.reader = null;
    }
  }
}
