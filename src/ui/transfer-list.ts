import {
  transferActivity,
  type TransferJob,
} from '../util/transfer-activity';
import { formatBytes, formatBytesPerSec } from './format-bytes';
import { DEFAULT_FOLDER_ICONS } from '../fs/icon-cache';

const STRUCTURE_ATTR = 'data-transfer-key';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function jobPct(j: TransferJob): number {
  if (j.status === 'queued') return 0;
  if (j.bytesTotal > 0) return Math.min(100, Math.round((j.bytesDone / j.bytesTotal) * 100));
  if (j.status === 'done' && j.bytesDone > 0) return 100;
  return 0;
}

function jobRate(j: TransferJob): string {
  if (j.status === 'queued') return 'Queued';
  if (j.status === 'cancelled') return 'Cancelled';
  if (j.status === 'running' && j.rate > 0) return formatBytesPerSec(j.rate);
  if (j.status === 'error') return 'Failed';
  if (j.status === 'done') return 'Done';
  if (j.status === 'running' && j.detail) return j.detail;
  return '…';
}

function jobSize(j: TransferJob): string {
  if (j.status === 'queued' && j.bytesTotal > 0) return formatBytes(j.bytesTotal);
  if (j.bytesTotal > 0) return `${formatBytes(j.bytesDone)} of ${formatBytes(j.bytesTotal)}`;
  if (j.bytesDone > 0) return formatBytes(j.bytesDone);
  return '0 bytes';
}

function structureKey(jobs: TransferJob[]): string {
  return jobs.map((j) => `${j.id}:${j.parentId ?? ''}`).join(',');
}

function canCancel(j: TransferJob): boolean {
  return j.status === 'running' || j.status === 'queued';
}

function cancelBtnHtml(j: TransferJob): string {
  if (!canCancel(j)) return '';
  return `<button type="button" class="file-transfer__cancel" data-act="cancel-transfer" data-job="${escapeHtml(j.id)}" aria-label="Cancel ${escapeHtml(j.name)}" title="Cancel">✕</button>`;
}

function rowHtml(j: TransferJob, nested = false): string {
  const pct = jobPct(j);
  const err = j.error ? `<div class="file-transfer__error">${escapeHtml(j.error)}</div>` : '';
  const icon =
    j.kind === 'folder'
      ? `<img class="file-transfer__icon" src="${DEFAULT_FOLDER_ICONS.small}" alt="" width="16" height="16" />`
      : `<img class="file-transfer__icon" src="${escapeHtml(j.iconSrc)}" alt="" width="16" height="16" />`;
  const nestClass = nested ? ' file-transfer--sub' : '';
  const statusClass =
    j.status === 'error'
      ? ' file-transfer--error'
      : j.status === 'queued'
        ? ' file-transfer--queued'
        : j.status === 'cancelled'
          ? ' file-transfer--cancelled'
          : '';
  return `<div class="file-transfer${nestClass}${statusClass}" data-id="${escapeHtml(j.id)}">
      ${icon}
      <div class="file-transfer__main">
        <div class="file-transfer__top">
          <span class="file-transfer__name" title="${escapeHtml(j.name)}" aria-label="${escapeHtml(j.name)}">${escapeHtml(j.name)}</span>
          <span class="file-transfer__rate">${escapeHtml(jobRate(j))}</span>
          ${cancelBtnHtml(j)}
        </div>
        <div class="file-transfer__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
          <div class="file-transfer__bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="file-transfer__meta">${escapeHtml(jobSize(j))}</div>
        ${err}
      </div>
    </div>`;
}

function paintRow(row: HTMLElement, j: TransferJob): void {
  const pct = jobPct(j);
  const bar = row.querySelector('.file-transfer__bar');
  const fill = row.querySelector('.file-transfer__bar-fill') as HTMLElement | null;
  if (bar) bar.setAttribute('aria-valuenow', String(pct));
  if (fill) fill.style.width = `${pct}%`;
  const rate = row.querySelector('.file-transfer__rate');
  if (rate) rate.textContent = jobRate(j);
  const meta = row.querySelector('.file-transfer__meta');
  if (meta) meta.textContent = jobSize(j);
  row.classList.toggle('file-transfer--error', j.status === 'error');
  row.classList.toggle('file-transfer--queued', j.status === 'queued');
  row.classList.toggle('file-transfer--cancelled', j.status === 'cancelled');
  const top = row.querySelector('.file-transfer__top');
  let cancel = row.querySelector('.file-transfer__cancel');
  if (canCancel(j)) {
    if (!cancel && top) top.insertAdjacentHTML('beforeend', cancelBtnHtml(j));
  } else {
    cancel?.remove();
  }
  let err = row.querySelector('.file-transfer__error');
  if (j.error) {
    if (!err) {
      err = document.createElement('div');
      err.className = 'file-transfer__error';
      row.querySelector('.file-transfer__main')?.appendChild(err);
    }
    err.textContent = j.error;
  } else {
    err?.remove();
  }
  const img = row.querySelector('img.file-transfer__icon');
  if (img instanceof HTMLImageElement && j.iconSrc && img.getAttribute('src') !== j.iconSrc) {
    img.src = j.iconSrc;
  }
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

/**
 * Paint jobs into `root`. Rebuilds only when the job set changes; otherwise
 * patches bars/labels so an open panel does not flicker.
 * @returns true when the list structure was rebuilt
 */
export function paintTransferList(root: Element, jobs: TransferJob[] = transferActivity.list()): boolean {
  const key = structureKey(jobs);
  if (root.getAttribute(STRUCTURE_ATTR) !== key) {
    root.setAttribute(STRUCTURE_ATTR, key);
    root.innerHTML = transferListHtml(jobs);
    return true;
  }
  for (const j of jobs) {
    const row = root.querySelector(`[data-id="${j.id}"]`);
    if (row instanceof HTMLElement) paintRow(row, j);
  }
  return false;
}
