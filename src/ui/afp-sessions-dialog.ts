/** Operator UI to push AFP server messages / disconnect Macintosh clients (ClassicStack AFP sessions). */

import type { AfpSessionInfo } from '../services/afp-server/server';
import { log } from '../util/logger';

export interface AfpSessionsHost {
  listSessions(): AfpSessionInfo[];
  sendMessage(sessionId: number, text: string): Promise<void>;
  disconnectSession(sessionId: number, text: string, minutes: number): Promise<void>;
}

export class AfpSessionsDialog extends HTMLElement {
  private host: AfpSessionsHost | null = null;
  private compose: { mode: 'message' | 'disconnect'; sessionId: number; who: string } | null = null;
  private error = '';

  connectedCallback(): void {
    this.classList.add('afp-sessions-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => void this.onClick(e));
    this.addEventListener('submit', (e) => void this.onSubmit(e));
  }

  bind(host: AfpSessionsHost): void {
    this.host = host;
  }

  open(): void {
    this.compose = null;
    this.error = '';
    this.hidden = false;
    this.render();
    log.info('Opened AFP Macintosh sessions dialog', 'afp');
  }

  close(): void {
    this.hidden = true;
    this.compose = null;
  }

  private rows(): AfpSessionInfo[] {
    return this.host?.listSessions() ?? [];
  }

  private render(): void {
    const rows = this.rows();
    const compose = this.compose;

    let body: string;
    if (compose) {
      const title = compose.mode === 'message' ? `Message ${compose.who}` : `Disconnect ${compose.who}`;
      body = `
        <form class="afp-sessions-dialog__form" data-form="compose">
          <p class="netboot-dialog__lead">${escapeHtml(title)}</p>
          <label class="afp-sessions-dialog__field">
            <span>Message</span>
            <textarea name="text" rows="3" maxlength="199" placeholder="${compose.mode === 'disconnect' ? 'Optional warning shown on the Mac' : 'Shown in a dialog on the Macintosh'}"></textarea>
          </label>
          ${
            compose.mode === 'disconnect'
              ? `<label class="afp-sessions-dialog__field">
            <span>Minutes until disconnect (0 = now)</span>
            <input class="netboot-dialog__num" name="minutes" type="number" min="0" max="4095" value="0" />
          </label>`
              : ''
          }
          ${this.error ? `<p class="afp-sessions-dialog__err">${escapeHtml(this.error)}</p>` : ''}
          <footer class="netboot-dialog__footer">
            <button type="button" class="btn" data-act="back">Back</button>
            <button type="submit" class="btn primary">${compose.mode === 'message' ? 'Send' : 'Disconnect'}</button>
          </footer>
        </form>
      `;
    } else if (!rows.length) {
      body = `<p class="netboot-dialog__lead">No Macintosh AFP sessions. Connect a Mac to this share first.</p>
        <footer class="netboot-dialog__footer">
          <button type="button" class="btn" data-act="refresh">Refresh</button>
          <button type="button" class="btn primary" data-act="close">Close</button>
        </footer>`;
    } else {
      const trs = rows
        .map(
          (r) => `
        <tr>
          <td>${r.id}</td>
          <td>${r.network}.${r.node}</td>
          <td>${escapeHtml(r.userName || (r.loggedIn ? 'guest' : '(not logged in)'))}</td>
          <td>${new Date(r.lastSeen).toLocaleTimeString()}</td>
          <td class="afp-sessions-dialog__acts">
            <button type="button" class="btn" data-act="msg" data-id="${r.id}">Message…</button>
            <button type="button" class="btn" data-act="disc" data-id="${r.id}">Disconnect…</button>
          </td>
        </tr>`,
        )
        .join('');
      body = `
        <div class="afp-sessions-dialog__table-wrap">
          <table class="afp-sessions-dialog__table">
            <thead>
              <tr><th>Session</th><th>AppleTalk</th><th>User</th><th>Last seen</th><th></th></tr>
            </thead>
            <tbody>${trs}</tbody>
          </table>
        </div>
        ${this.error ? `<p class="afp-sessions-dialog__err">${escapeHtml(this.error)}</p>` : ''}
        <footer class="netboot-dialog__footer">
          <button type="button" class="btn" data-act="msg-all">Message all…</button>
          <button type="button" class="btn" data-act="refresh">Refresh</button>
          <button type="button" class="btn primary" data-act="close">Close</button>
        </footer>
      `;
    }

    this.innerHTML = `
      <div class="netboot-dialog__backdrop" data-act="close"></div>
      <div class="netboot-dialog__card afp-sessions-dialog__card" role="dialog" aria-labelledby="afp-sess-title">
        <header class="netboot-dialog__header">
          <h2 id="afp-sess-title">Macintosh clients</h2>
          <button type="button" class="btn" data-act="close" aria-label="Close">✕</button>
        </header>
        ${body}
      </div>
    `;
  }

  private whoFor(id: number): string {
    return id === 0 ? 'all sessions' : `session ${id}`;
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') {
      this.close();
      return;
    }
    if (act === 'back') {
      this.compose = null;
      this.error = '';
      this.render();
      return;
    }
    if (act === 'refresh') {
      this.error = '';
      this.render();
      return;
    }
    if (act === 'msg-all') {
      this.compose = { mode: 'message', sessionId: 0, who: this.whoFor(0) };
      this.error = '';
      this.render();
      return;
    }
    const id = Number(t.dataset.id);
    if (act === 'msg') {
      this.compose = { mode: 'message', sessionId: id, who: this.whoFor(id) };
      this.error = '';
      this.render();
      return;
    }
    if (act === 'disc') {
      this.compose = { mode: 'disconnect', sessionId: id, who: this.whoFor(id) };
      this.error = '';
      this.render();
    }
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.host || !this.compose) return;
    const form = e.target as HTMLFormElement;
    const text = String(new FormData(form).get('text') ?? '').trim();
    const minutes = Number(new FormData(form).get('minutes') ?? 0);
    try {
      if (this.compose.mode === 'message') {
        if (!text) {
          this.error = 'Enter a message.';
          this.render();
          return;
        }
        await this.host.sendMessage(this.compose.sessionId, text);
        log.info(`Sent AFP message to ${this.compose.who}`, 'afp');
      } else {
        await this.host.disconnectSession(this.compose.sessionId, text, Number.isFinite(minutes) ? minutes : 0);
        log.info(`Disconnecting ${this.compose.who}`, 'afp');
      }
      this.compose = null;
      this.error = '';
      this.render();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.render();
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('afp-sessions-dialog', AfpSessionsDialog);
