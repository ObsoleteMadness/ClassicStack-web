import { log } from '../util/logger';

/** Bundled ABP ChainLoader (ClassicStack patched build). */
export const BUNDLED_PAYLOAD_URL = '/netboot/ChainLoader.bin';
/** Client enabler floppy (XPRAM netboot) — download only, not served on the wire. */
export const BOOTSTRAP_FLOPPY_URL = '/netboot/BootstrapFloppy.dsk';
/** ChainLoader is served with 256-byte ABP blocks. */
export const BUNDLED_BLOCK_SIZE = 256;

export interface NetbootState {
  enabled: boolean;
  /** ChainBoot HFS System volume (required when enabled). */
  diskImage: File | null;
  paceMs: number;
  chainPaceMs: number;
}

/** Netboot configuration dialog (ABP + ChainBoot). */
export class NetbootDialog extends HTMLElement {
  private state: NetbootState = {
    enabled: false,
    diskImage: null,
    paceMs: 2,
    chainPaceMs: 10,
  };
  private onChange: ((s: NetbootState) => void) | null = null;

  connectedCallback(): void {
    this.classList.add('netboot-dialog');
    this.hidden = true;
    this.render();
    this.addEventListener('click', (e) => void this.onClick(e));
    this.addEventListener('change', (e) => this.onFieldChange(e));
  }

  bind(onChange: (s: NetbootState) => void): void {
    this.onChange = onChange;
  }

  getState(): NetbootState {
    return { ...this.state };
  }

  open(): void {
    this.hidden = false;
    this.render();
    log.info('Opened Netboot configuration dialog', 'netboot');
  }

  close(): void {
    this.hidden = true;
  }

  private emit(): void {
    this.onChange?.(this.getState());
  }

  private render(): void {
    const diskHint = this.state.diskImage
      ? `${this.state.diskImage.name} (${this.state.diskImage.size.toLocaleString()} bytes)`
      : 'No System volume selected';

    this.innerHTML = `
      <div class="netboot-dialog__backdrop" data-act="close"></div>
      <div class="netboot-dialog__card" role="dialog" aria-labelledby="netboot-title">
        <header class="netboot-dialog__header">
          <h2 id="netboot-title">Netboot</h2>
          <button type="button" class="btn" data-act="close" aria-label="Close">✕</button>
        </header>
        <p class="netboot-dialog__lead">AppleTalk Boot Protocol + ChainBoot. Ships with <code>ChainLoader.bin</code>; advertises as <code>BootServer</code> when enabled and connected.</p>
        <div class="netboot-dialog__row">
          <div>
            <div class="netboot-dialog__label">Bootstrap floppy</div>
            <div class="netboot-dialog__hint">Download <code>BootstrapFloppy.dsk</code> to enable netboot XPRAM on the client Mac.</div>
          </div>
          <a class="btn" href="${BOOTSTRAP_FLOPPY_URL}" download="BootstrapFloppy.dsk" data-act="download-floppy">Download</a>
        </div>
        <div class="netboot-dialog__row">
          <div>
            <div class="netboot-dialog__label">Payload</div>
            <div class="netboot-dialog__hint">Bundled ChainLoader.bin (256-byte ABP blocks).</div>
          </div>
          <span class="netboot-dialog__badge">built-in</span>
        </div>
        <div class="netboot-dialog__row">
          <div>
            <div class="netboot-dialog__label">ChainBoot HFS disk</div>
            <div class="netboot-dialog__hint">${escapeHtml(diskHint)}. Writable System volume streamed over EBP.</div>
          </div>
          <label class="btn netboot-dialog__file-btn">
            Select HFS…
            <input type="file" accept=".img,.hfs,.dsk,.iso,.toast,application/octet-stream" data-act="pick-hfs" hidden />
          </label>
        </div>
        <div class="netboot-dialog__row">
          <div>
            <div class="netboot-dialog__label">Netboot support</div>
            <div class="netboot-dialog__hint">Advertises BootServer and serves ABP/EBP when serial is connected.</div>
          </div>
          <button type="button" class="btn${this.state.enabled ? ' active' : ''}" data-act="toggle">
            ${this.state.enabled ? 'On' : 'Off'}
          </button>
        </div>
        <footer class="netboot-dialog__footer">
          <button type="button" class="btn primary" data-act="close">Done</button>
        </footer>
      </div>
    `;
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') {
      this.close();
      return;
    }
    if (act === 'download-floppy') {
      log.info('Downloading BootstrapFloppy.dsk', 'netboot');
      return;
    }
    if (act === 'toggle') {
      if (!this.state.enabled && !this.state.diskImage) {
        log.warn('Select a ChainBoot HFS disk before enabling Netboot', 'netboot');
        return;
      }
      this.state.enabled = !this.state.enabled;
      log.info(`Netboot support ${this.state.enabled ? 'enabled' : 'disabled'}`, 'netboot');
      this.emit();
      this.render();
    }
  }

  private onFieldChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.dataset.act !== 'pick-hfs') return;
    this.state.diskImage = input.files?.[0] ?? null;
    if (this.state.diskImage) {
      log.info(
        `Selected ChainBoot HFS image: ${this.state.diskImage.name} (${this.state.diskImage.size} bytes)`,
        'netboot',
      );
    }
    this.emit();
    this.render();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('netboot-dialog', NetbootDialog);
