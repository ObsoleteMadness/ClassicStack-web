/** Error name used for cancelled AFP / icon work (`AbortController`). */
export const ABORT_ERROR_NAME = 'AbortError';

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === ABORT_ERROR_NAME;
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === ABORT_ERROR_NAME) return reason;
  const err = new Error(reason instanceof Error ? reason.message : 'Aborted');
  err.name = ABORT_ERROR_NAME;
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
