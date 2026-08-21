/** Format a count of files/folders, e.g. "1 item" or "12 items". */
export function formatItems(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const count = Math.round(n);
  return count === 1 ? '1 item' : `${count} items`;
}

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

function unitPhrase(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

/** Remaining time from seconds, e.g. "38 seconds" or "3 minutes, 38 seconds". */
export function formatRemainingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 1) return 'less than a second';
  if (s < 60) return unitPhrase(s, 'second', 'seconds');
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(unitPhrase(hours, 'hour', 'hours'));
  if (minutes > 0) parts.push(unitPhrase(minutes, 'minute', 'minutes'));
  if (hours === 0 && rem > 0) parts.push(unitPhrase(rem, 'second', 'seconds'));
  return parts.join(', ');
}
