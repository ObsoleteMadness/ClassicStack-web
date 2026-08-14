import type { AfpServer } from '../services/afp-server/server';
import type { TrafficStats } from '../util/traffic-stats';
import { formatBytes, formatBytesPerSec } from './format-bytes';

export interface ActivityHost {
  traffic: TrafficStats;
  getAfpServer(): AfpServer | null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function nodeAddr(network: number, node: number): string {
  return `${network}.${node}`;
}

function userLabel(userName: string, loggedIn: boolean): string {
  if (userName) return userName;
  return loggedIn ? 'Guest' : '(connecting)';
}

/** Floating AFP / LocalTalk activity monitor. */
export class ActivityWindow extends HTMLElement {
  private host: ActivityHost | null = null;
  private drag: { ox: number; oy: number; sx: number; sy: number } | null = null;
  private pos = { x: 56, y: 72 };
  private timer: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    this.classList.add('activity-window');
    this.renderShell();
    this.addEventListener('click', (e) => this.onClick(e));
    this.querySelector('.activity-window__chrome')?.addEventListener('pointerdown', (e) =>
      this.onDragStart(e as PointerEvent),
    );
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    this.applyPosition();
  }

  disconnectedCallback(): void {
    this.stopTimer();
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
  }

  bind(host: ActivityHost): void {
    this.host = host;
    this.refresh();
  }

  show(): void {
    this.hidden = false;
    this.refresh();
    this.startTimer();
  }

  hide(): void {
    this.hidden = true;
    this.stopTimer();
  }

  toggle(): void {
    if (this.hidden) this.show();
    else this.hide();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), 500);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private renderShell(): void {
    this.innerHTML = `
      <div class="activity-window__chrome">
        <div class="activity-window__title">Activity</div>
        <button type="button" class="btn log-panel__btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="activity-window__stats" data-role="stats"></div>
      <div class="activity-window__body">
        <section class="activity-window__section">
          <h3>Connected users</h3>
          <div class="activity-window__table-wrap" data-role="users"></div>
        </section>
        <section class="activity-window__section">
          <h3>Open files</h3>
          <div class="activity-window__table-wrap" data-role="files"></div>
        </section>
      </div>
    `;
  }

  private refresh(): void {
    if (!this.host) return;
    const traffic = this.host.traffic.sample();
    const stats = this.querySelector('[data-role="stats"]');
    if (stats) {
      stats.innerHTML = `
        <div class="activity-stat">
          <div class="activity-stat__label">Bytes in</div>
          <div class="activity-stat__value" title="${traffic.bytesIn.toLocaleString()} bytes">${escapeHtml(formatBytes(traffic.bytesIn))}</div>
        </div>
        <div class="activity-stat">
          <div class="activity-stat__label">Bytes out</div>
          <div class="activity-stat__value" title="${traffic.bytesOut.toLocaleString()} bytes">${escapeHtml(formatBytes(traffic.bytesOut))}</div>
        </div>
        <div class="activity-stat">
          <div class="activity-stat__label">Rate in</div>
          <div class="activity-stat__value">${escapeHtml(formatBytesPerSec(traffic.rateIn))}</div>
        </div>
        <div class="activity-stat">
          <div class="activity-stat__label">Rate out</div>
          <div class="activity-stat__value">${escapeHtml(formatBytesPerSec(traffic.rateOut))}</div>
        </div>
      `;
    }

    const server = this.host.getAfpServer();
    const sessions = server?.listSessions() ?? [];
    const files = server?.listOpenFiles() ?? [];

    const usersEl = this.querySelector('[data-role="users"]');
    if (usersEl) {
      if (!sessions.length) {
        usersEl.innerHTML = `<p class="activity-window__empty">No AFP sessions</p>`;
      } else {
        usersEl.innerHTML = `
          <table class="activity-table">
            <thead>
              <tr><th>User</th><th>Node</th><th>Session</th></tr>
            </thead>
            <tbody>
              ${sessions
                .map(
                  (s) => `<tr>
                    <td>${escapeHtml(userLabel(s.userName, s.loggedIn))}</td>
                    <td class="activity-table__mono">${escapeHtml(nodeAddr(s.network, s.node))}</td>
                    <td class="activity-table__mono">${s.id}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        `;
      }
    }

    const filesEl = this.querySelector('[data-role="files"]');
    if (filesEl) {
      if (!files.length) {
        filesEl.innerHTML = `<p class="activity-window__empty">No open forks</p>`;
      } else {
        filesEl.innerHTML = `
          <table class="activity-table">
            <thead>
              <tr><th>File</th><th>Fork</th><th>User</th></tr>
            </thead>
            <tbody>
              ${files
                .map(
                  (f) => `<tr>
                    <td>${escapeHtml(f.name || '(unnamed)')}</td>
                    <td>${f.resource ? 'Resource' : 'Data'}</td>
                    <td>${escapeHtml(userLabel(f.userName, true))}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        `;
      }
    }
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (t?.dataset.act === 'close') this.hide();
  }

  private applyPosition(): void {
    this.style.left = `${this.pos.x}px`;
    this.style.top = `${this.pos.y}px`;
  }

  private onDragStart(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('button')) return;
    this.drag = { ox: this.pos.x, oy: this.pos.y, sx: e.clientX, sy: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  private onDragMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    this.pos = {
      x: Math.max(8, this.drag.ox + (e.clientX - this.drag.sx)),
      y: Math.max(8, this.drag.oy + (e.clientY - this.drag.sy)),
    };
    this.applyPosition();
  };

  private onDragEnd = (): void => {
    this.drag = null;
  };
}

customElements.define('activity-window', ActivityWindow);
