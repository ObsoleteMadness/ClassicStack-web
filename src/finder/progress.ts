/** Helpers for Finder job progress streams. */

import type { OpProgress } from './types';

export async function consumeProgress(
  stream: AsyncIterable<OpProgress>,
  onProgress?: (p: OpProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  for await (const p of stream) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    onProgress?.(p);
    if (p.error) throw new Error(p.error);
    if (p.done) return;
  }
}

export async function* readSSEProgress(r: Response): AsyncIterable<OpProgress> {
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    yield { error: j?.error ?? `HTTP ${r.status}`, done: true };
    return;
  }
  const reader = r.body?.getReader();
  if (!reader) {
    yield { done: true };
    return;
  }
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf('\n\n');
      if (idx < 0) break;
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const p = JSON.parse(line.slice(6)) as OpProgress;
          yield p;
          if (p.done || p.error) return;
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
  yield { done: true };
}
