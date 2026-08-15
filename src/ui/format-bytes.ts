/** Format byte counts for display; sorting should use the raw number. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = n;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[u]}`;
}

/** Instantaneous rate as an integer bytes/sec count. */
export function formatBytesPerSec(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return `${Math.round(n).toLocaleString()} bytes/s`;
}
