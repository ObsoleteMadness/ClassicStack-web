import { downloadBytes, type PcapCapture } from '../util/pcap';
import { log } from '../util/logger';
import { loadPrefs, savePrefs } from '../util/prefs';
import { applyPrefsBundle, parsePrefsBundle, stringifyPrefsBundle } from '../util/prefs-bundle';
import type { LogPanel } from './log-panel';
import type { ActivityWindow } from './activity-window';
import type { NetbootDialog } from './netboot-dialog';
import type { AfpSessionsDialog } from './afp-sessions-dialog';
import type { ExtensionEditorDialog } from './extension-editor-dialog';
import type { ResourceForkExplorer } from './resource-fork-explorer';
import type { GetInfoWindow } from './get-info-window';
import type { FinderWindow } from './finder-window';
import type { AboutDialog } from './about-dialog';
import type { AlertDialog } from './alert-dialog';
import { iconCache } from '../fs/icon-cache';
import { persistWindow } from './window-layout';
import { isCompactUi } from './layout-mode';

type OpenMenu = 'app' | 'advanced' | null;

export interface AdvancedMenuHost {
  pcap: PcapCapture;
  logPanel: LogPanel;
  activityWindow: ActivityWindow;
  netboot: NetbootDialog;
  afpSessions: AfpSessionsDialog;
  extensionEditor: ExtensionEditorDialog;
  resourceExplorer: ResourceForkExplorer;
  getInfoWindow: GetInfoWindow;
  about: AboutDialog;
  alertDialog?: AlertDialog;
  finder?: FinderWindow;
  resetEnvironment?(eraseShare: boolean): Promise<void>;
  onCaptureChanged?(capturing: boolean): void;
}

/** Screen-top menu bar with ClassicStack / Advanced menus. */
export class AppMenuBar extends HTMLElement {
  private host: AdvancedMenuHost | null = null;
  private openMenu: OpenMenu = null;

  connectedCallback(): void {
    this.classList.add('app-menubar');
    this.render();
    this.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('click', this.onWindowClick);
    window.addEventListener('keydown', this.onKey);
  }

  disconnectedCallback(): void {
    window.removeEventListener('click', this.onWindowClick);
    window.removeEventListener('keydown', this.onKey);
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
    const showHidden = this.host?.finder?.getShowHiddenFiles?.() ?? false;
    const autoExpand = this.host?.finder?.getAutoExpandFiles?.() ?? false;
    const readFinderIcons = this.host?.finder?.getReadFinderIcons?.() ?? true;
    const zipStyle = loadPrefs().zipExportStyle;
    const appOpen = this.openMenu === 'app';
    const advancedOpen = this.openMenu === 'advanced';
    this.innerHTML = `
      <div class="app-menubar__inner">
        <div class="app-menubar__menus">
          <div class="app-menu${appOpen ? ' open' : ''}">
            <button type="button" class="app-menu__trigger app-menubar__brand" data-act="toggle-app" aria-haspopup="true" aria-expanded="${appOpen}">
              ClassicStack
            </button>
            <div class="app-menu__dropdown" role="menu" ${appOpen ? '' : 'hidden'}>
              <button type="button" role="menuitem" data-act="about" class="app-menu__item">
                About ClassicStack…
              </button>
            </div>
          </div>
          <div class="app-menu${advancedOpen ? ' open' : ''}">
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
              <button type="button" role="menuitem" data-act="netboot" class="app-menu__item">
                <span class="app-menu__check"></span>
                Netboot…
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
              <button type="button" role="menuitemcheckbox" aria-checked="${showHidden}" data-act="toggle-show-hidden" class="app-menu__item">
                <span class="app-menu__check">${showHidden ? '✓' : ''}</span>
                Show hidden files
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked="${autoExpand}" data-act="toggle-auto-expand" class="app-menu__item">
                <span class="app-menu__check">${autoExpand ? '✓' : ''}</span>
                Auto-expand files
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked="${readFinderIcons}" data-act="toggle-read-finder-icons" class="app-menu__item">
                <span class="app-menu__check">${readFinderIcons ? '✓' : ''}</span>
                Read finder icons
              </button>
              <hr />
              <button type="button" role="menuitemradio" aria-checked="${zipStyle === 'appledouble'}" data-act="zip-appledouble" class="app-menu__item">
                <span class="app-menu__check">${zipStyle === 'appledouble' ? '✓' : ''}</span>
                AppleDouble zip
              </button>
              <button type="button" role="menuitemradio" aria-checked="${zipStyle === 'macosx'}" data-act="zip-macosx" class="app-menu__item">
                <span class="app-menu__check">${zipStyle === 'macosx' ? '✓' : ''}</span>
                Mac OS X zip
              </button>
              <hr />
              <button type="button" role="menuitem" data-act="extension-editor" class="app-menu__item">
                <span class="app-menu__check"></span>
                Extension editor…
              </button>
              <button type="button" role="menuitem" data-act="resource-fork" class="app-menu__item">
                <span class="app-menu__check"></span>
                Resource Fork…
              </button>
              <button type="button" role="menuitem" data-act="clear-icon-cache" class="app-menu__item">
                <span class="app-menu__check"></span>
                Clear icon cache
              </button>
              <hr />
              <button type="button" role="menuitem" data-act="export-prefs" class="app-menu__item">
                <span class="app-menu__check"></span>
                Export preferences…
              </button>
              <button type="button" role="menuitem" data-act="import-prefs" class="app-menu__item">
                <span class="app-menu__check"></span>
                Import preferences…
              </button>
              <hr />
              <button type="button" role="menuitem" data-act="reset-environment" class="app-menu__item">
                <span class="app-menu__check"></span>
                Reset environment…
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

  private onWindowClick = (e: MouseEvent): void => {
    if (!this.openMenu) return;
    if (this.contains(e.target as Node)) return;
    this.openMenu = null;
    this.render();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.openMenu) {
      this.openMenu = null;
      this.render();
    }
  };

  private closeMenus(): void {
    this.openMenu = null;
    this.render();
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t || !this.host) return;
    e.stopPropagation();
    const act = t.dataset.act;

    if (act === 'toggle-app') {
      this.openMenu = this.openMenu === 'app' ? null : 'app';
      this.render();
      return;
    }

    if (act === 'toggle-advanced') {
      this.openMenu = this.openMenu === 'advanced' ? null : 'advanced';
      this.render();
      return;
    }

    if (act === 'about') {
      this.closeMenus();
      this.host.about.open();
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

    if (act === 'netboot') {
      this.closeMenus();
      this.host.netboot.open();
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

    if (act === 'toggle-show-hidden') {
      const next = !(this.host.finder?.getShowHiddenFiles?.() ?? false);
      this.host.finder?.setShowHiddenFiles?.(next);
      this.closeMenus();
      return;
    }

    if (act === 'toggle-auto-expand') {
      const next = !(this.host.finder?.getAutoExpandFiles?.() ?? false);
      this.host.finder?.setAutoExpandFiles?.(next);
      this.closeMenus();
      return;
    }

    if (act === 'toggle-read-finder-icons') {
      const next = !(this.host.finder?.getReadFinderIcons?.() ?? true);
      this.host.finder?.setReadFinderIcons?.(next);
      this.closeMenus();
      return;
    }

    if (act === 'zip-appledouble' || act === 'zip-macosx') {
      savePrefs({ zipExportStyle: act === 'zip-macosx' ? 'macosx' : 'appledouble' });
      this.render();
      return;
    }

    if (act === 'extension-editor') {
      this.closeMenus();
      this.host.extensionEditor.open();
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

    if (act === 'export-prefs') {
      this.closeMenus();
      this.exportPreferences();
      return;
    }

    if (act === 'import-prefs') {
      this.closeMenus();
      void this.importPreferences();
      return;
    }

    if (act === 'reset-environment') {
      this.closeMenus();
      void this.resetEnvironment();
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

  private exportPreferences(): void {
    this.snapshotWindows();
    const json = stringifyPrefsBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBytes(new TextEncoder().encode(json), `classicstack-prefs-${stamp}.json`, 'application/json');
    log.info('Exported preferences', 'app');
  }

  private async importPreferences(): Promise<void> {
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

  private async resetEnvironment(): Promise<void> {
    const host = this.host;
    if (!host?.alertDialog || !host.resetEnvironment) return;
    const result = await host.alertDialog.confirm({
      title: 'Reset environment',
      text: 'This restores default window positions and preferences, then reloads ClassicStack.',
      checkboxLabel: 'Erase all Browser Share items',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!result.confirmed) return;
    await host.resetEnvironment(result.checked);
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
