import { log } from '../util/logger';
import type { CredentialPromptOptions, Credentials, ShareKind } from './finder-host';

export type LoginCredentials = Credentials;
export type LoginPromptOptions = CredentialPromptOptions;

/** Modal login (guest or username/password) for AFP, SMB, and NCP. */
export class LoginDialog extends HTMLElement {
  private opts: LoginPromptOptions | null = null;
  private pending: ((v: LoginCredentials | null) => void) | null = null;
  private username = '';
  private password = '';
  private busy = false;

  connectedCallback(): void {
    this.classList.add('login-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('submit', (e) => this.onSubmit(e));
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.hidden && !this.busy) {
        e.preventDefault();
        this.finish(null);
      }
    });
  }

  prompt(opts: LoginPromptOptions): Promise<LoginCredentials | null> {
    if (this.pending && !this.busy) this.pending(null);
    this.busy = false;
    this.opts = opts;
    this.hidden = false;
    this.render();
    log.info(`Login dialog for “${opts.serverName}” ${authLabel(opts.kind)}=[${opts.uams.join(', ')}]`, opts.kind || 'afp');
    queueMicrotask(() => {
      const user = this.querySelector<HTMLInputElement>('[data-field="user"]');
      user?.focus();
    });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  close(): void {
    const done = this.pending;
    this.busy = false;
    this.pending = null;
    this.hidden = true;
    this.opts = null;
    this.password = '';
    done?.(null);
  }

  private finish(value: LoginCredentials | null): void {
    const done = this.pending;
    this.pending = null;
    this.busy = false;
    this.hidden = true;
    this.opts = null;
    this.password = '';
    done?.(value);
  }

  private accept(value: LoginCredentials): void {
    this.busy = true;
    this.render();
    const done = this.pending;
    this.pending = null;
    done?.(value);
  }

  private render(): void {
    const opts = this.opts;
    if (!opts) {
      this.innerHTML = '';
      return;
    }
    const name = escapeHtml(opts.serverName || serverNoun(opts.kind));
    const methods = opts.uams.length ? escapeHtml(opts.uams.join(', ')) : 'none advertised';
    const err =
      opts.error && !this.busy ? `<div class="login-dialog__error">${escapeHtml(opts.error)}</div>` : '';
    const guest = opts.allowGuest
      ? `<button type="button" class="btn" data-act="guest" ${this.busy ? 'disabled' : ''}>Guest</button>`
      : '';
    const connectLabel = this.busy
      ? `<span class="status-spinner" aria-hidden="true"></span> Signing in…`
      : 'Connect';
    const passMax = opts.kind === 'afp' || !opts.kind ? 'maxlength="8" ' : '';
    this.innerHTML = `
      <div class="login-dialog__backdrop" data-act="${this.busy ? '' : 'cancel'}"></div>
      <form class="login-dialog__card" role="dialog" aria-labelledby="login-title" aria-busy="${this.busy}" autocomplete="on">
        <header class="login-dialog__header">
          <h2 id="login-title">Connect to ${name}</h2>
          <button type="button" class="btn" data-act="cancel" aria-label="Cancel" ${this.busy ? 'disabled' : ''}>✕</button>
        </header>
        <p class="login-dialog__lead">${authLead(opts.kind, methods)}</p>
        ${err}
        <div class="login-dialog__field">
          <label for="afp-user">Name</label>
          <input id="afp-user" data-field="user" name="username" type="text" spellcheck="false" value="${escapeHtml(this.username)}" ${this.busy ? 'disabled' : ''} />
        </div>
        <div class="login-dialog__field">
          <label for="afp-pass">Password</label>
          <input id="afp-pass" data-field="pass" name="password" type="password" ${passMax}value="${escapeHtml(this.password)}" ${this.busy ? 'disabled' : ''} />
        </div>
        <footer class="login-dialog__footer">
          ${guest}
          <div class="spacer"></div>
          <button type="button" class="btn" data-act="cancel" ${this.busy ? 'disabled' : ''}>Cancel</button>
          <button type="submit" class="btn primary login-dialog__submit" data-act="login" ${this.busy ? 'disabled' : ''}>${connectLabel}</button>
        </footer>
      </form>
    `;
  }

  private readFields(): void {
    this.username = this.querySelector<HTMLInputElement>('[data-field="user"]')?.value ?? '';
    this.password = this.querySelector<HTMLInputElement>('[data-field="pass"]')?.value ?? '';
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'cancel') {
      if (this.busy) return;
      log.info('Login cancelled', this.opts?.kind || 'afp');
      this.finish(null);
      return;
    }
    if (act === 'guest') {
      if (this.busy) return;
      log.info('Login as Guest', this.opts?.kind || 'afp');
      this.accept({ kind: 'guest' });
    }
  }

  private onSubmit(e: Event): void {
    e.preventDefault();
    if (this.busy) return;
    this.readFields();
    if (!this.username.trim()) {
      if (this.opts) this.opts = { ...this.opts, error: 'Enter a user name, or choose Guest.' };
      this.render();
      return;
    }
    log.info(`Login as “${this.username.trim()}”`, this.opts?.kind || 'afp');
    this.accept({ kind: 'password', username: this.username.trim(), password: this.password });
  }
}

function authLabel(kind?: ShareKind): string {
  switch (kind) {
    case 'smb':
      return 'Capabilities';
    case 'ncp':
      return 'Login';
    default:
      return 'UAMs';
  }
}

function serverNoun(kind?: ShareKind): string {
  switch (kind) {
    case 'smb':
      return 'SMB server';
    case 'ncp':
      return 'NetWare server';
    case 'etherdfs':
      return 'EtherDFS server';
    default:
      return 'AFP server';
  }
}

function authLead(kind: ShareKind | undefined, methods: string): string {
  switch (kind) {
    case 'smb':
      return `Sign in to browse shares. Capabilities: <code>${methods}</code>`;
    case 'ncp':
      return `Sign in to browse volumes. Login: <code>${methods}</code>`;
    default:
      return `Sign in to browse volumes. UAMs: <code>${methods}</code>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('login-dialog', LoginDialog);
