/** Non-blocking notice that a newer app build is waiting (reload would drop serial). */

export class UpdateBanner extends HTMLElement {
  private reload: (() => void) | null = null;

  connectedCallback(): void {
    this.classList.add('update-banner');
    this.hidden = true;
    this.setAttribute('role', 'status');
    this.addEventListener('click', (e) => this.onClick(e));
  }

  show(reload: () => void): void {
    this.reload = reload;
    this.hidden = false;
    this.innerHTML = `
      <p class="update-banner__text">ClassicStack has been updated. Reload to use the new version.</p>
      <div class="update-banner__actions">
        <button type="button" class="btn" data-act="later">Later</button>
        <button type="button" class="btn primary" data-act="reload">Reload</button>
      </div>
    `;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (t?.dataset.act === 'later') {
      this.hidden = true;
      return;
    }
    if (t?.dataset.act === 'reload') this.reload?.();
  }
}

customElements.define('update-banner', UpdateBanner);
