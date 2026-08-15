import {
  transferActivity,
  type TransferJob,
} from '../util/transfer-activity';
import { formatBytes, formatBytesPerSec } from './format-bytes';
import { uiIcons } from './lucide-icon';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function rowHtml(j: TransferJob, nested = false): string {
  const pct =
    j.bytesTotal > 0
      ? Math.min(100, Math.round((j.bytesDone / j.bytesTotal) * 100))
      : j.status === 'done' && j.bytesDone > 0
        ? 100
        : 0;
  const rate =
    j.status === 'running' && j.rate > 0
      ? formatBytesPerSec(j.rate)
      : j.status === 'error'
        ? 'Failed'
        : j.status === 'done'
          ? 'Done'
          : j.status === 'running' && j.detail
            ? j.detail
            : '…';
  const size =
    j.bytesTotal > 0
      ? `${formatBytes(j.bytesDone)} of ${formatBytes(j.bytesTotal)}`
      : j.bytesDone > 0
        ? formatBytes(j.bytesDone)
        : '0 bytes';
  const err = j.error ? `<div class="file-transfer__error">${escapeHtml(j.error)}</div>` : '';
  const icon =
    j.kind === 'folder'
      ? `<span class="file-transfer__icon">${uiIcons.folder}</span>`
      : `<img class="file-transfer__icon" src="${escapeHtml(j.iconSrc)}" alt="" width="16" height="16" />`;
  const nestClass = nested ? ' file-transfer--sub' : '';
  return `<div class="file-transfer${nestClass}${j.status === 'error' ? ' file-transfer--error' : ''}" data-id="${escapeHtml(j.id)}">
      ${icon}
      <div class="file-transfer__main">
        <div class="file-transfer__top">
          <span class="file-transfer__name" title="${escapeHtml(j.name)}" aria-label="${escapeHtml(j.name)}">${escapeHtml(j.name)}</span>
          <span class="file-transfer__rate">${escapeHtml(rate)}</span>
        </div>
        <div class="file-transfer__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
          <div class="file-transfer__bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="file-transfer__meta">${escapeHtml(size)}</div>
        ${err}
      </div>
    </div>`;
}

/** Job list markup shared by the transfer callout (and leftover window). */
export function transferListHtml(jobs: TransferJob[] = transferActivity.list()): string {
  if (!jobs.length) return `<p class="file-activity-window__empty">No transfers</p>`;
  const kids = new Map<string, TransferJob[]>();
  const roots: TransferJob[] = [];
  const ids = new Set(jobs.map((j) => j.id));
  for (const j of jobs) {
    if (j.parentId && ids.has(j.parentId)) {
      const list = kids.get(j.parentId) ?? [];
      list.push(j);
      kids.set(j.parentId, list);
    } else {
      roots.push(j);
    }
  }
  return roots
    .map((j) => {
      const nested = kids.get(j.id) ?? [];
      if (!nested.length) return rowHtml(j);
      return `<div class="file-transfer-group">${rowHtml(j)}${nested.map((c) => rowHtml(c, true)).join('')}</div>`;
    })
    .join('');
}
