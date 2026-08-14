/** LLAP frame helpers (OmniTalk core/protocol/llap). */

export const HeaderLen = 3;
export const BroadcastNode = 0xff;
export const TypeShortDDP = 0x01;
export const TypeLongDDP = 0x02;
export const TypeENQ = 0x81;
export const TypeACK = 0x82;
export const NodeUnclaimed = 0x00;
export const MinNode = 0x01;
export const MaxNode = 0xfe;
export const DefaultDesiredNode = 0xfe;

export interface LlapHeader {
  dst: number;
  src: number;
  type: number;
}

export function parseHeader(frame: Uint8Array): LlapHeader | null {
  if (frame.length < HeaderLen) return null;
  return { dst: frame[0]!, src: frame[1]!, type: frame[2]! };
}

export function isControl(type: number): boolean {
  return type === TypeENQ || type === TypeACK;
}

export function encodeControl(dst: number, src: number, type: number): Uint8Array {
  return new Uint8Array([dst, src, type]);
}

export function enq(candidate: number): Uint8Array {
  return encodeControl(candidate, candidate, TypeENQ);
}

export function ack(node: number): Uint8Array {
  return encodeControl(node, node, TypeACK);
}
