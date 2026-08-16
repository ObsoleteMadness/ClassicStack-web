import { transferActivity } from '../util/transfer-activity';
import { paintTransferList } from './transfer-list';

/**
 * Optional expanded File Transfers surface. The Finder toolbar callout is the
 * primary UI; this window no longer auto-opens.
 */
export class FileActivityWindow extends HTMLElement {
  private unsub: (() => void) | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;

  connectedCallback(): void {
    this.classList.add('file-activity-window');
    this.renderShell();
    this.addEventListener('click', (e) => this.onClick(e));
    this.unsub = transferActivity.subscribe(() => this.onJobs());
    this.onJobs();
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  show(): void {
    this.hidden = false;
    this.refresh();
  }

  hide(): void {
    this.hidden = true;
    if (!transferActivity.hasRunning()) transferActivity.clearFinished();
  }

  private onJobs(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.syncVisibility();
      if (!this.hidden) this.refresh();
    });
  }

  private syncVisibility(): void {
    if (this.hidden) return;
    if (transferActivity.hasRunning()) {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      return;
    }
    if (this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, 1800);
  }

  private renderShell(): void {
    this.innerHTML = `
      <div class="file-activity-window__chrome">
        <div class="file-activity-window__title">File Transfers</div>
        <button type="button" class="btn log-panel__btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="file-activity-window__body" data-role="rows"></div>
    `;
  }

  private refresh(): void {
    const root = this.querySelector('[data-role="rows"]');
    if (root) paintTransferList(root);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (t?.dataset.act === 'close') this.hide();
    if (t?.dataset.act === 'cancel-transfer' && t.dataset.job) {
      e.preventDefault();
      transferActivity.cancel(t.dataset.job);
    }
  }
}

customElements.define('file-activity-window', FileActivityWindow);
