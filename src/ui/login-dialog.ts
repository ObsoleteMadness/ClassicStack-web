import { log } from '../util/logger';

export type LoginCredentials =
  | { kind: 'guest' }
  | { kind: 'password'; username: string; password: string };

export interface LoginPromptOptions {
  serverName: string;
  uams: string[];
  error?: string;
  allowGuest: boolean;
}

/** Modal AFP login (guest or username/password). */
export class LoginDialog extends HTMLElement {
  private opts: LoginPromptOptions | null = null;
  private pending: ((v: LoginCredentials | null) => void) | null = null;
  private username = '';
  private password = '';

  connectedCallback(): void {
    this.classList.add('login-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('submit', (e) => this.onSubmit(e));
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.hidden) {
        e.preventDefault();
        this.finish(null);
      }
    });
  }

  prompt(opts: LoginPromptOptions): Promise<LoginCredentials | null> {
    if (this.pending) this.pending(null);
    this.opts = opts;
    this.hidden = false;
    this.render();
    log.info(`Login dialog for “${opts.serverName}” UAMs=[${opts.uams.join(', ')}]`, 'afp');
    queueMicrotask(() => {
      const user = this.querySelector<HTMLInputElement>('[data-field="user"]');
      user?.focus();
    });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  private finish(value: LoginCredentials | null): void {
    const done = this.pending;
    this.pending = null;
    this.hidden = true;
    this.opts = null;
    this.password = '';
    done?.(value);
  }

  private render(): void {
    const opts = this.opts;
    if (!opts) {
      this.innerHTML = '';
      return;
    }
    const name = escapeHtml(opts.serverName || 'AFP server');
    const uams = opts.uams.length ? escapeHtml(opts.uams.join(', ')) : 'none advertised';
    const err = opts.error ? `<div class="login-dialog__error">${escapeHtml(opts.error)}</div>` : '';
    const guest = opts.allowGuest
      ? `<button type="button" class="btn" data-act="guest">Guest</button>`
      : '';
    this.innerHTML = `
      <div class="login-dialog__backdrop" data-act="cancel"></div>
      <form class="login-dialog__card" role="dialog" aria-labelledby="login-title" autocomplete="on">
        <header class="login-dialog__header">
          <h2 id="login-title">Connect to ${name}</h2>
          <button type="button" class="btn" data-act="cancel" aria-label="Cancel">✕</button>
        </header>
        <p class="login-dialog__lead">Sign in to browse volumes. UAMs: <code>${uams}</code></p>
        ${err}
        <div class="login-dialog__field">
          <label for="afp-user">Name</label>
          <input id="afp-user" data-field="user" name="username" type="text" spellcheck="false" value="${escapeHtml(this.username)}" />
        </div>
        <div class="login-dialog__field">
          <label for="afp-pass">Password</label>
          <input id="afp-pass" data-field="pass" name="password" type="password" maxlength="8" value="${escapeHtml(this.password)}" />
        </div>
        <footer class="login-dialog__footer">
          ${guest}
          <div class="spacer"></div>
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary" data-act="login">Connect</button>
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
      log.info('AFP login cancelled', 'afp');
      this.finish(null);
      return;
    }
    if (act === 'guest') {
      log.info('AFP login as Guest', 'afp');
      this.finish({ kind: 'guest' });
    }
  }

  private onSubmit(e: Event): void {
    e.preventDefault();
    this.readFields();
    if (!this.username.trim()) {
      if (this.opts) this.opts = { ...this.opts, error: 'Enter a user name, or choose Guest.' };
      this.render();
      return;
    }
    log.info(`AFP login as “${this.username.trim()}”`, 'afp');
    this.finish({ kind: 'password', username: this.username.trim(), password: this.password });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('login-dialog', LoginDialog);
