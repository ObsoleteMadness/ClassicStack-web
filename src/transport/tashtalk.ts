/**
 * TashTalk host↔device framing.
 * Matches lampmerchant/tashrouter tashtalk.py and lampmerchant/tashtalk protocol.md.
 */

const TX_CMD = 0x01;
const SET_NODE_IDS = 0x02;
const SET_FEATURES = 0x03;
const ESCAPE = 0x00;
const ESC_NULL = 0xff;
const ESC_END = 0xfd;
const FCS_LEN = 2;
const MIN_FRAME_WITH_FCS = 5; // 3-byte LLAP + 2-byte FCS
const NODE_BITMAP_LEN = 32;

/** Flush to known state, clear node bitmap, disable optional features (tashrouter start). */
export function buildInitSequence(): Uint8Array {
  const out = new Uint8Array(1024 + 1 + NODE_BITMAP_LEN + 2);
  // 1024×0x00 — return firmware to “awaiting command”
  out[1024] = SET_NODE_IDS;
  // 32 zero bytes — respond to no node IDs yet
  out[1024 + 1 + NODE_BITMAP_LEN] = SET_FEATURES;
  out[1024 + 1 + NODE_BITMAP_LEN + 1] = 0x00;
  return out;
}

/** 0x02 + 32-byte bitmap: defend the given node ID (1..254). Empty → clear all. */
export function encodeSetNodeIds(nodes: number[]): Uint8Array {
  const out = new Uint8Array(1 + NODE_BITMAP_LEN);
  out[0] = SET_NODE_IDS;
  for (const id of nodes) {
    if (id < 1 || id > 254) continue;
    const byte = Math.floor(id / 8);
    const bit = id % 8;
    out[1 + byte]! |= 1 << bit;
  }
  return out;
}

/** CRC-16/X-25 reflected poly 0x8408, init 0xFFFF, final XOR 0xFFFF. */
export function fcsBytes(frame: Uint8Array): [number, number] {
  let crc = 0xffff;
  for (let i = 0; i < frame.length; i++) {
    crc ^= frame[i]!;
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  crc = (~crc) & 0xffff;
  return [crc & 0xff, (crc >>> 8) & 0xff];
}

/** Host→device: 0x01 + raw LLAP + FCS (no escape encoding). */
export function encodeOutbound(llapFrame: Uint8Array): Uint8Array {
  const [b1, b2] = fcsBytes(llapFrame);
  const out = new Uint8Array(1 + llapFrame.length + FCS_LEN);
  out[0] = TX_CMD;
  out.set(llapFrame, 1);
  out[1 + llapFrame.length] = b1;
  out[2 + llapFrame.length] = b2;
  return out;
}

/**
 * Incremental inbound decoder (device→host).
 * No start marker — accumulate until 0x00 0xFD (tashrouter / tashtalkd).
 */
export class TashTalkDecoder {
  private rdBuf: number[] = [];
  private escaped = false;
  private pending: Uint8Array[] = [];

  feed(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      let b = data[i]!;
      if (!this.escaped && b === ESCAPE) {
        this.escaped = true;
        continue;
      }
      if (this.escaped) {
        this.escaped = false;
        if (b === ESC_NULL) {
          b = 0x00;
        } else {
          // ClassicStack: 0xFD end-of-frame; 0xFE/0xFA/0xFC (and anything else)
          // abort the accumulated frame. Firmware does not send a start marker.
          if (b === ESC_END) this.completeFrame();
          this.rdBuf = [];
          continue;
        }
      }
      this.rdBuf.push(b);
    }
  }

  take(): Uint8Array | undefined {
    return this.pending.shift();
  }

  private completeFrame(): void {
    const frame = new Uint8Array(this.rdBuf);
    if (frame.length < MIN_FRAME_WITH_FCS) return;
    const body = frame.subarray(0, frame.length - FCS_LEN);
    const [e1, e2] = fcsBytes(body);
    if (frame[frame.length - 2] !== e1 || frame[frame.length - 1] !== e2) return;
    this.pending.push(body.slice());
  }
}
