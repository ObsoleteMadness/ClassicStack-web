import { downloadBytes, type PcapCapture } from '../util/pcap';
import { log } from '../util/logger';
import { applyPrefsBundle, parsePrefsBundle, stringifyPrefsBundle } from '../util/prefs-bundle';
import type { LogPanel } from './log-panel';
import type { ActivityWindow } from './activity-window';
import type { AfpSessionsDialog } from './afp-sessions-dialog';
import type { ResourceForkExplorer } from './resource-fork-explorer';
import type { GetInfoWindow } from './get-info-window';
import type { FinderWindow } from './finder-window';
import type { AboutDialog } from './about-dialog';
import type { AlertDialog } from './alert-dialog';
import type { SettingsWindow } from './settings-window';
import { iconCache } from '../fs/icon-cache';
import { persistWindow } from './window-layout';
import { isCompactUi } from './layout-mode';
import { bindMenuBarTracking, MENUBAR_CHANGE, menubarOpenKey, setMenubarOpen } from './menu-bar-track';

export interface AdvancedMenuHost {
  pcap: PcapCapture;
  logPanel: LogPanel;
  activityWindow: ActivityWindow;
  afpSessions: AfpSessionsDialog;
  resourceExplorer: ResourceForkExplorer;
  getInfoWindow: GetInfoWindow;
  about: AboutDialog;
  alertDialog?: AlertDialog;
  settings?: SettingsWindow;
  finder?: FinderWindow;
  onCaptureChanged?(capturing: boolean): void;
}

/** Screen-top menu bar with ClassicStack / Advanced menus. */
export class AppMenuBar extends HTMLElement {
  private host: AdvancedMenuHost | null = null;
  private unbindTracking: (() => void) | null = null;

  connectedCallback(): void {
    this.classList.add('app-menubar');
    this.render();
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener(MENUBAR_CHANGE, this.onMenubarChange);
    this.unbindTracking = bindMenuBarTracking(this);
  }

  disconnectedCallback(): void {
    this.removeEventListener(MENUBAR_CHANGE, this.onMenubarChange);
    this.unbindTracking?.();
    this.unbindTracking = null;
  }

  bind(host: AdvancedMenuHost): void {
    this.host = host;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  /** Lightweight badge / menu-item update while capturing (avoids closing the menu). */
  refreshCaptureStatus(): void {
    if (!this.host) return;
    const capturing = this.host.pcap.capturing;
    const count = this.host.pcap.packetCount;
    const status = this.querySelector('.app-menubar__status');
    if (status) {
      status.innerHTML = capturing
        ? `<span class="pcap-live" title="${count} frames buffered">● Capturing · ${count}</span>`
        : '';
    }
    const dl = this.querySelector('[data-act="download-pcap"]') as HTMLButtonElement | null;
    if (dl) {
      dl.disabled = count === 0;
      dl.innerHTML = `<span class="app-menu__check"></span>Download pcap${count ? ` (${count})` : ''}`;
    }
  }

  private render(): void {
    const capturing = this.host?.pcap.capturing ?? false;
    const count = this.host?.pcap.packetCount ?? 0;
    const logOpen = this.host ? !this.host.logPanel.hidden : false;
    const activityOpen = this.host ? !this.host.activityWindow.hidden : false;
    const appOpen = menubarOpenKey(this) === 'app';
    const advancedOpen = menubarOpenKey(this) === 'advanced';
    this.innerHTML = `
      <div class="app-menubar__inner">
        <div class="app-menubar__menus">
          <div class="app-menu${appOpen ? ' open' : ''}" data-menu="app">
            <button type="button" class="app-menu__trigger app-menubar__brand" data-act="toggle-app" aria-haspopup="true" aria-expanded="${appOpen}">
              ClassicStack
            </button>
            <div class="app-menu__dropdown" role="menu" ${appOpen ? '' : 'hidden'}>
              <button type="button" role="menuitem" data-act="about" class="app-menu__item">
                About ClassicStack…
              </button>
              <button type="button" role="menuitem" data-act="settings" class="app-menu__item">
                Settings…
              </button>
            </div>
          </div>
          <div class="app-menu${advancedOpen ? ' open' : ''}" data-menu="advanced">
            <button type="button" class="app-menu__trigger" data-act="toggle-advanced" aria-haspopup="true" aria-expanded="${advancedOpen}">
              Advanced
            </button>
            <div class="app-menu__dropdown" role="menu" ${advancedOpen ? '' : 'hidden'}>
              <button type="button" role="menuitemcheckbox" aria-checked="${capturing}" data-act="capture-pcap" class="app-menu__item">
                <span class="app-menu__check">${capturing ? '✓' : ''}</span>
                Capture pcap
              </button>
              <button type="button" role="menuitem" data-act="download-pcap" class="app-menu__item" ${count === 0 ? 'disabled' : ''}>
                <span class="app-menu__check"></span>
                Download pcap${count ? ` (${count})` : ''}
              </button>
              <hr />
              <button type="button" role="menuitem" data-act="mac-clients" class="app-menu__item">
                <span class="app-menu__check"></span>
                Message Macintosh clients…
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked="${logOpen}" data-act="show-log" class="app-menu__item">
                <span class="app-menu__check">${logOpen ? '✓' : ''}</span>
                Show Log
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked="${activityOpen}" data-act="show-activity" class="app-menu__item">
                <span class="app-menu__check">${activityOpen ? '✓' : ''}</span>
                Activity
              </button>
              <hr />
              <button type="button" role="menuitem" data-act="resource-fork" class="app-menu__item">
                <span class="app-menu__check"></span>
                Resource Fork…
              </button>
              <button type="button" role="menuitem" data-act="clear-icon-cache" class="app-menu__item">
                <span class="app-menu__check"></span>
                Clear icon cache
              </button>
            </div>
          </div>
        </div>
        <div class="app-menubar__status">
          ${capturing ? `<span class="pcap-live" title="${count} frames buffered">● Capturing · ${count}</span>` : ''}
        </div>
      </div>
    `;
  }

  private onMenubarChange = (): void => {
    this.render();
  };

  private closeMenus(): void {
    setMenubarOpen(this, null);
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t || !this.host) return;
    e.stopPropagation();
    const act = t.dataset.act;
    if (act === 'toggle-app' || act === 'toggle-advanced') return;

    if (act === 'about') {
      this.closeMenus();
      this.host.about.open();
      return;
    }

    if (act === 'settings') {
      this.closeMenus();
      this.host.settings?.open('general');
      return;
    }

    if (act === 'capture-pcap') {
      if (this.host.pcap.capturing) {
        this.host.pcap.stop();
        log.info(`Stopped pcap capture (${this.host.pcap.packetCount} frames)`, 'pcap');
      } else {
        this.host.pcap.start();
        log.info('Started pcap capture', 'pcap');
      }
      this.host.onCaptureChanged?.(this.host.pcap.capturing);
      this.closeMenus();
      return;
    }

    if (act === 'download-pcap') {
      const data = this.host.pcap.build();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadBytes(data, `localtalk-${stamp}.pcap`, 'application/vnd.tcpdump.pcap');
      log.info(`Downloaded pcap (${this.host.pcap.packetCount} frames, ${data.length} bytes)`, 'pcap');
      this.closeMenus();
      return;
    }

    if (act === 'mac-clients') {
      this.closeMenus();
      this.host.afpSessions.open();
      return;
    }

    if (act === 'show-log') {
      this.closeMenus();
      this.host.logPanel.toggle();
      return;
    }

    if (act === 'show-activity') {
      this.closeMenus();
      this.host.activityWindow.toggle();
      return;
    }

    if (act === 'resource-fork') {
      this.closeMenus();
      this.host.finder?.openResourceExplorer();
      return;
    }

    if (act === 'clear-icon-cache') {
      this.closeMenus();
      void (async () => {
        await iconCache.clear();
        this.host?.finder?.invalidateIcons?.();
        log.info('Cleared application icon cache', 'icons');
      })();
      return;
    }
  }

  private snapshotWindows(): void {
    const host = this.host;
    if (!host) return;
    if (host.finder && !isCompactUi()) persistWindow('finder', host.finder);
    persistWindow('log', host.logPanel);
    persistWindow('activity', host.activityWindow);
    persistWindow('resource', host.resourceExplorer);
    persistWindow('info', host.getInfoWindow);
  }

  exportPreferences(): void {
    this.snapshotWindows();
    const json = stringifyPrefsBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBytes(new TextEncoder().encode(json), `classicstack-prefs-${stamp}.json`, 'application/json');
    log.info('Exported preferences', 'app');
  }

  async importPreferences(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const file = await pickJsonFile();
    if (!file) return;
    let parsed;
    try {
      parsed = parsePrefsBundle(JSON.parse(await file.text()) as unknown);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      host.alertDialog?.show('Could not import preferences', msg);
      return;
    }
    const confirm = host.alertDialog
      ? await host.alertDialog.confirm({
          title: 'Import preferences',
          text: 'Replace current preferences, window layout, and extension mappings with this file? ClassicStack will reload.',
          confirmLabel: 'Import',
        })
      : { confirmed: true, checked: false };
    if (!confirm.confirmed) return;
    applyPrefsBundle(parsed);
    log.info(`Imported preferences from “${file.name}”`, 'app');
    location.reload();
  }
}

function pickJsonFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

customElements.define('app-menubar', AppMenuBar);
