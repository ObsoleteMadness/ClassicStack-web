import type { NameConflictChoice } from '../fs/name-conflict';

export interface NameConflictPrompt {
  name: string;
  isDir: boolean;
  suggestedName: string;
}

/** Replace / rename / cancel when an incoming item already exists. */
export class NameConflictDialog extends HTMLElement {
  private pending: ((v: NameConflictChoice) => void) | null = null;
  private opts: NameConflictPrompt | null = null;

  connectedCallback(): void {
    this.classList.add('name-conflict-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.hidden) {
        e.preventDefault();
        this.finish('cancel');
      }
    });
  }

  prompt(opts: NameConflictPrompt): Promise<NameConflictChoice> {
    if (this.pending) this.pending('cancel');
    this.opts = opts;
    this.hidden = false;
    this.render();
    queueMicrotask(() => {
      this.querySelector<HTMLButtonElement>('[data-act="rename"]')?.focus();
    });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  close(): void {
    this.finish('cancel');
  }

  private finish(choice: NameConflictChoice): void {
    const done = this.pending;
    this.pending = null;
    this.opts = null;
    this.hidden = true;
    this.innerHTML = '';
    done?.(choice);
  }

  private render(): void {
    const opts = this.opts;
    if (!opts) {
      this.innerHTML = '';
      return;
    }
    const kind = opts.isDir ? 'folder' : 'item';
    this.innerHTML = `
      <div class="login-dialog__backdrop" data-act="cancel"></div>
      <div class="login-dialog__card" role="dialog" aria-labelledby="conflict-title" aria-modal="true">
        <header class="login-dialog__header">
          <h2 id="conflict-title">Item already exists</h2>
          <button type="button" class="btn" data-act="cancel" aria-label="Cancel">✕</button>
        </header>
        <p class="login-dialog__lead">
          A ${kind} named “${escapeHtml(opts.name)}” already exists in the destination.
          Replace it, keep both as “${escapeHtml(opts.suggestedName)}”, or cancel the transfer.
        </p>
        <footer class="login-dialog__footer">
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <div class="spacer"></div>
          <button type="button" class="btn" data-act="rename">Rename</button>
          <button type="button" class="btn primary" data-act="replace">Replace</button>
        </footer>
      </div>
    `;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    const act = t?.dataset.act;
    if (act === 'cancel' || act === 'rename' || act === 'replace') this.finish(act);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('name-conflict-dialog', NameConflictDialog);
