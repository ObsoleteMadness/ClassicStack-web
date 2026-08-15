import type { AfpServer } from '../services/afp-server/server';
import type { TrafficStats } from '../util/traffic-stats';
import { formatBytes, formatBytesPerSec } from './format-bytes';
import { positionCallout } from './callout';

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

/** AFP / LocalTalk activity monitor shown as a callout from Advanced. */
export class ActivityWindow extends HTMLElement {
  private host: ActivityHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchor: HTMLElement | null = null;

  connectedCallback(): void {
    this.classList.add('activity-window', 'is-callout');
    this.renderShell();
    this.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('pointerdown', this.onDocPointer, true);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onReposition);
  }

  disconnectedCallback(): void {
    this.stopTimer();
    window.removeEventListener('pointerdown', this.onDocPointer, true);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onReposition);
  }

  bind(host: ActivityHost): void {
    this.host = host;
    this.refresh();
  }

  show(): void {
    this.showCallout(this.anchor);
  }

  showCallout(anchor: HTMLElement | null): void {
    this.anchor = anchor;
    this.hidden = false;
    this.refresh();
    this.startTimer();
    this.reposition();
  }

  hide(): void {
    this.hidden = true;
    this.stopTimer();
  }

  toggleCallout(anchor: HTMLElement | null): void {
    if (!this.hidden) this.hide();
    else this.showCallout(anchor);
  }

  private reposition = (): void => {
    if (this.hidden || !this.anchor) return;
    positionCallout(this, this.anchor);
  };

  private onReposition = (): void => this.reposition();

  private onDocPointer = (e: PointerEvent): void => {
    if (this.hidden) return;
    const t = e.target as Node;
    if (this.contains(t)) return;
    if (this.anchor?.contains(t)) return;
    this.hide();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.hidden) this.hide();
  };

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
}

customElements.define('activity-window', ActivityWindow);
