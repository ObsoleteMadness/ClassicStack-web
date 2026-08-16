/** Simple modal for AFP notices and confirmation prompts. */

export type ConfirmResult = { confirmed: boolean; checked: boolean };

export interface ConfirmOptions {
  title: string;
  text: string;
  confirmLabel?: string;
  cancelLabel?: string;
  checkboxLabel?: string;
  danger?: boolean;
}

export class AlertDialog extends HTMLElement {
  private pending: ((v: ConfirmResult) => void) | null = null;

  connectedCallback(): void {
    this.classList.add('alert-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.hidden) return;
      e.preventDefault();
      if (this.pending) this.finish({ confirmed: false, checked: this.checkboxChecked() });
      else this.close();
    });
  }

  show(title: string, text: string): void {
    if (this.pending) this.finish({ confirmed: false, checked: false });
    this.hidden = false;
    this.innerHTML = `
      <div class="netboot-dialog__backdrop" data-act="close"></div>
      <div class="netboot-dialog__card" role="dialog" aria-labelledby="alert-title" aria-modal="true">
        <header class="netboot-dialog__header">
          <h2 id="alert-title">${escapeHtml(title)}</h2>
          <button type="button" class="btn" data-act="close" aria-label="Close">✕</button>
        </header>
        <p class="alert-dialog__body">${escapeHtml(text)}</p>
        <footer class="netboot-dialog__footer">
          <button type="button" class="btn primary" data-act="close">OK</button>
        </footer>
      </div>
    `;
    this.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
  }

  confirm(opts: ConfirmOptions): Promise<ConfirmResult> {
    if (this.pending) this.finish({ confirmed: false, checked: false });
    this.hidden = false;
    const confirmLabel = opts.confirmLabel ?? 'OK';
    const cancelLabel = opts.cancelLabel ?? 'Cancel';
    const check = opts.checkboxLabel
      ? `<label class="alert-dialog__check"><input type="checkbox" data-confirm-check /> ${escapeHtml(opts.checkboxLabel)}</label>`
      : '';
    this.innerHTML = `
      <div class="netboot-dialog__backdrop" data-act="cancel"></div>
      <div class="netboot-dialog__card" role="dialog" aria-labelledby="alert-title" aria-modal="true">
        <header class="netboot-dialog__header">
          <h2 id="alert-title">${escapeHtml(opts.title)}</h2>
          <button type="button" class="btn" data-act="cancel" aria-label="Close">✕</button>
        </header>
        <p class="alert-dialog__body">${escapeHtml(opts.text)}</p>
        ${check}
        <footer class="netboot-dialog__footer">
          <button type="button" class="btn" data-act="cancel">${escapeHtml(cancelLabel)}</button>
          <div class="spacer"></div>
          <button type="button" class="btn ${opts.danger ? 'danger' : 'primary'}" data-act="confirm">${escapeHtml(confirmLabel)}</button>
        </footer>
      </div>
    `;
    queueMicrotask(() => {
      this.querySelector<HTMLButtonElement>('[data-act="confirm"]')?.focus();
    });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  close(): void {
    this.hidden = true;
    this.innerHTML = '';
  }

  private checkboxChecked(): boolean {
    return this.querySelector<HTMLInputElement>('[data-confirm-check]')?.checked === true;
  }

  private finish(result: ConfirmResult): void {
    const done = this.pending;
    this.pending = null;
    this.close();
    done?.(result);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') {
      this.close();
      return;
    }
    if (act === 'cancel') {
      if (this.pending) this.finish({ confirmed: false, checked: this.checkboxChecked() });
      else this.close();
      return;
    }
    if (act === 'confirm' && this.pending) {
      this.finish({ confirmed: true, checked: this.checkboxChecked() });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('alert-dialog', AlertDialog);
