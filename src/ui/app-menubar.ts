import { downloadBytes, type PcapCapture } from '../util/pcap';
import { log } from '../util/logger';
import { loadPrefs, savePrefs } from '../util/prefs';
import type { LogPanel } from './log-panel';
import type { ActivityWindow } from './activity-window';
import type { NetbootDialog } from './netboot-dialog';
import type { AfpSessionsDialog } from './afp-sessions-dialog';
import type { ExtensionEditorDialog } from './extension-editor-dialog';
import type { ResourceForkExplorer } from './resource-fork-explorer';
import type { FinderWindow } from './finder-window';
import type { AboutDialog } from './about-dialog';
import { iconCache } from '../fs/icon-cache';

type OpenMenu = 'app' | 'advanced' | null;

export interface AdvancedMenuHost {
  pcap: PcapCapture;
  logPanel: LogPanel;
  activityWindow: ActivityWindow;
  netboot: NetbootDialog;
  afpSessions: AfpSessionsDialog;
  extensionEditor: ExtensionEditorDialog;
  resourceExplorer: ResourceForkExplorer;
  about: AboutDialog;
  finder?: FinderWindow;
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
    const showHidden = this.host?.finder?.getShowHiddenFiles?.() ?? false;
    const autoExpand = this.host?.finder?.getAutoExpandFiles?.() ?? false;
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
              <button type="button" role="menuitem" data-act="show-log" class="app-menu__item">
                <span class="app-menu__check"></span>
                Show Log
              </button>
              <button type="button" role="menuitem" data-act="show-activity" class="app-menu__item">
                <span class="app-menu__check"></span>
                Activity…
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

  private advancedTrigger(): HTMLElement | null {
    return this.querySelector('[data-act="toggle-advanced"]');
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
      this.host.activityWindow.hide();
      this.host.logPanel.toggleCallout(this.advancedTrigger());
      return;
    }

    if (act === 'show-activity') {
      this.closeMenus();
      this.host.logPanel.hide();
      this.host.activityWindow.toggleCallout(this.advancedTrigger());
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
    }
  }
}

customElements.define('app-menubar', AppMenuBar);
