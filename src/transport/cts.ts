/**
 * Software CTS gate for TashTalk host→device writes.
 *
 * Matches ClassicStack `hardware/pico/cts.go`: the MCU accepts USB bytes at 1 Mbit/s
 * but clocks LocalTalk at 230.4 kbaud, and deasserts serial CTS when its 128-byte
 * UART queue is half-full. Chrome `flowControl: 'hardware'` is supposed to pause
 * `writer.write()` on that signal; in practice an 8-packet ATP TResp still lands
 * on the MCU in ~14ms (see localtalk-2026-08-28 capture), so we also poll
 * `SerialPort.getSignals().clearToSend` and write in chunks under half the UART.
 *
 * This is USB-serial CTS, not LLAP RTS/CTS (those stay in the TashTalk firmware).
 */

/** Pico `ctsPollInterval` is 100µs; 1ms is the cheapest interval `setTimeout` honours. */
export const CtsPollMs = 1;

/**
 * Pico `ctsMaxWait`. One max-size LocalTalk frame is ~22ms on the wire, so 50ms
 * covers MCU TX-complete CTS without stalling forever on an unwired line.
 */
export const CtsMaxWaitMs = 50;

/**
 * Pico `ctsChunk` is 1 byte (GPIO poll is free). Web Serial `getSignals()` is IPC,
 * so we write 32 bytes — under TashTalk's 64-byte half-full mark — then re-check.
 */
export const CtsChunk = 32;

/** `true` = send, `false` = wait, `null` = CTS not readable (skip wait). */
export type CtsProbe = () => Promise<boolean | null>;

export async function waitClearToSend(
  probe: CtsProbe,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const deadline = now() + CtsMaxWaitMs;
  for (;;) {
    const cts = await probe();
    // Unsupported (`null`) or asserted (`true`) — write. Only `false` stalls.
    if (cts !== false) return;
    if (now() >= deadline) return;
    await sleep(CtsPollMs);
  }
}

export function chunkBytes(data: Uint8Array, size: number = CtsChunk): Uint8Array[] {
  if (data.length === 0) return [data];
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) {
    out.push(data.subarray(i, Math.min(i + size, data.length)));
  }
  return out;
}
