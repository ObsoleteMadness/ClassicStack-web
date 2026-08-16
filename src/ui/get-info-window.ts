/**
 * Floating Get Info tool window for icon and list views.
 * Column view keeps its inline preview pane.
 */

import { enableWindowMove, enableWindowResize, onWindowGeometryChange, raiseFloatingWindow } from './window-resize';
import { defaultInfoFrame, fitWindowToContents, persistWindow, restoreWindow } from './window-layout';

export class GetInfoWindow extends HTMLElement {
  onAction: ((act: string) => void) | null = null;
  onClose: (() => void) | null = null;

  connectedCallback(): void {
    this.classList.add('get-info-window');
    this.hidden = true;
    this.renderShell();
    enableWindowResize(this, { minWidth: 260, minHeight: 160 });
    enableWindowMove(this, '.get-info-window__chrome');
    this.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', this.onKey);
    restoreWindow('info', this, defaultInfoFrame);
    onWindowGeometryChange(this, () => persistWindow('info', this));
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKey);
  }

  show(): void {
    this.hidden = false;
    raiseFloatingWindow(this);
    requestAnimationFrame(() => {
      fitWindowToContents(this, { panel: '[data-role="body"]', minHeight: 160 });
      persistWindow('info', this);
    });
  }

  hide(fromUser = false): void {
    this.hidden = true;
    persistWindow('info', this);
    if (fromUser) this.onClose?.();
  }

  setBody(html: string): void {
    const body = this.querySelector('[data-role="body"]');
    if (body) body.innerHTML = html;
    if (!this.hidden) this.fitToContents();
  }

  fitToContents(): void {
    requestAnimationFrame(() => {
      fitWindowToContents(this, { panel: '[data-role="body"]', minHeight: 160 });
    });
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.hidden) this.hide(true);
  };

  private renderShell(): void {
    this.innerHTML = `
      <div class="get-info-window__chrome">
        <div class="get-info-window__title">Get Info</div>
        <button type="button" class="btn log-panel__btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="get-info-window__body" data-role="body"></div>
    `;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (!act) return;
    if (act === 'close' || act === 'close-props') {
      this.hide(true);
      return;
    }
    this.onAction?.(act);
  }
}

customElements.define('get-info-window', GetInfoWindow);
