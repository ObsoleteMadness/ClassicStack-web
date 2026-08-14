/** Simple modal for AFP server messages and disconnect notices. */

export class AlertDialog extends HTMLElement {
  connectedCallback(): void {
    this.classList.add('alert-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.hidden) this.close();
    });
  }

  show(title: string, text: string): void {
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

  close(): void {
    this.hidden = true;
    this.innerHTML = '';
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (t?.dataset.act === 'close') this.close();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('alert-dialog', AlertDialog);
