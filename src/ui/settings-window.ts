import { log } from '../util/logger';
import { loadPrefs, savePrefs } from '../util/prefs';
import type { ViewMode } from './finder-window';
import type { FinderWindow } from './finder-window';
import type { NetbootDialog, NetbootState } from './netboot-dialog';
import { BOOTSTRAP_FLOPPY_URL } from './netboot-dialog';
import type { ExtensionEditorDialog } from './extension-editor-dialog';
import type { AlertDialog } from './alert-dialog';
import { uiIcons } from './lucide-icon';
import { settingsBitmapIcons } from './settings-icons';
import {
  renderSettingsFrame,
  renderSettingsGroup,
  renderSettingsNav,
  renderSettingsPanelHeading,
  type SettingsNavItem,
  type SettingsRow,
} from './settings-panel';
import { enableWindowResize } from './window-resize';
import { isCompactUi } from './layout-mode';

const SETTINGS_MIN_WIDTH = 520;
const SETTINGS_MIN_HEIGHT = 400;
const SETTINGS_DEFAULT_WIDTH = 760;
const SETTINGS_DEFAULT_HEIGHT = 560;

export type SettingsSection = 'general' | 'netboot' | 'environment';

export interface SettingsHost {
  finder?: FinderWindow;
  netboot: NetbootDialog;
  extensionEditor: ExtensionEditorDialog;
  alertDialog?: AlertDialog;
  exportPreferences(): void;
  importPreferences(): Promise<void>;
  resetEnvironment(eraseShare: boolean): Promise<void>;
  onPrefsChanged?(): void;
}

const NAV: SettingsNavItem[] = [
  { id: 'general', label: 'General', iconHtml: settingsBitmapIcons.general },
  { id: 'netboot', label: 'Netboot', iconHtml: settingsBitmapIcons.netboot },
  { id: 'environment', label: 'Environment', iconHtml: uiIcons.environment },
];

const SECTION_TITLES: Record<SettingsSection, string> = {
  general: 'General',
  netboot: 'Netboot',
  environment: 'Environment',
};

const SECTION_DESC: Record<SettingsSection, string> = {
  general: 'Finder appearance, import, and export preferences.',
  netboot: 'AppleTalk Boot Protocol and ChainBoot for classic Macs.',
  environment: 'Browser storage, preference backup, and reset options.',
};

/** Two-column settings window (General, Netboot, Environment). */
export class SettingsWindow extends HTMLElement {
  private host: SettingsHost | null = null;
  private section: SettingsSection = 'general';
  private shellMounted = false;

  connectedCallback(): void {
    this.classList.add('settings-window');
    this.hidden = true;
    this.addEventListener('click', (e) => void this.onClick(e));
    this.addEventListener('change', (e) => void this.onChange(e));
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.hidden) this.close();
    });
  }

  bind(host: SettingsHost): void {
    this.host = host;
  }

  open(section: SettingsSection = 'general'): void {
    this.section = section;
    this.hidden = false;
    this.ensureShell();
    this.syncSection();
    log.info(`Opened Settings (${section})`, 'app');
    this.querySelector<HTMLElement>('.settings-nav__item.is-selected')?.focus();
  }

  close(): void {
    this.hidden = true;
    this.innerHTML = '';
    this.shellMounted = false;
  }

  private ensureShell(): void {
    if (this.shellMounted) return;
    this.innerHTML = renderSettingsFrame('Settings', renderSettingsNav(NAV, this.section));
    this.shellMounted = true;
    this.setupChrome();
  }

  private setupChrome(): void {
    const card = this.querySelector('.settings-shell__card') as HTMLElement | null;
    if (!card) return;
    if (!isCompactUi()) {
      card.style.width = `${Math.min(SETTINGS_DEFAULT_WIDTH, window.innerWidth - 32)}px`;
      card.style.height = `${Math.min(SETTINGS_DEFAULT_HEIGHT, window.innerHeight - 48)}px`;
    }
    enableWindowResize(card, {
      minWidth: isCompactUi() ? 280 : SETTINGS_MIN_WIDTH,
      minHeight: isCompactUi() ? 320 : SETTINGS_MIN_HEIGHT,
    });
  }

  /** Update sidebar selection and panel content without rebuilding the shell. */
  private syncSection(): void {
    this.querySelectorAll<HTMLElement>('.settings-nav__item').forEach((btn) => {
      const selected = btn.dataset.nav === this.section;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    const headingSlot = this.querySelector('.settings-panel__heading-slot');
    const content = this.querySelector('.settings-panel__content');
    const panel = this.querySelector('.settings-panel');
    if (headingSlot) {
      const nav = NAV.find((item) => item.id === this.section);
      headingSlot.innerHTML = renderSettingsPanelHeading({
        title: SECTION_TITLES[this.section],
        description: SECTION_DESC[this.section],
        iconHtml: nav?.iconHtml,
      });
    }
    if (content) content.innerHTML = this.renderSection(this.section);
    if (panel) panel.scrollTop = 0;
  }

  private refreshPanel(): void {
    if (!this.shellMounted) return;
    const content = this.querySelector('.settings-panel__content');
    if (content) content.innerHTML = this.renderSection(this.section);
  }

  private renderSection(section: SettingsSection): string {
    if (section === 'general') return this.renderGeneral();
    if (section === 'netboot') return this.renderNetboot();
    return this.renderEnvironment();
  }

  private renderGeneral(): string {
    const prefs = loadPrefs();
    const finder = this.host?.finder;
    const viewOptions = [
      { value: 'icon', label: 'Icons' },
      { value: 'list', label: 'List' },
      { value: 'column', label: 'Columns' },
    ];
    const exportOptions = [
      { value: 'appledouble', label: 'AppleDouble zip' },
      { value: 'macosx', label: 'Mac OS X zip' },
    ];

    const finderRows: SettingsRow[] = [
      {
        type: 'select',
        id: 'default-view',
        label: 'Default view',
        description: 'View mode used when ClassicStack opens without a URL view parameter.',
        value: prefs.defaultView,
        options: viewOptions,
      },
      {
        type: 'toggle',
        id: 'show-hidden',
        label: 'Show hidden files',
        description: 'Show Finder-invisible items and Icon\\r entries.',
        checked: finder?.getShowHiddenFiles?.() ?? prefs.showHiddenFiles,
      },
      {
        type: 'toggle',
        id: 'auto-expand',
        label: 'Auto-expand files',
        description: 'Decode dropped BinHex, MacBinary, StuffIt, and ZIP archives on import.',
        checked: finder?.getAutoExpandFiles?.() ?? prefs.autoExpandFiles,
      },
      {
        type: 'toggle',
        id: 'read-finder-icons',
        label: 'Load fork icons',
        description: 'Read Icon\\r and resource forks for custom Finder glyphs.',
        checked: finder?.getReadFinderIcons?.() ?? prefs.readFinderIcons,
      },
      {
        type: 'button',
        id: 'extension-editor',
        label: 'File type mappings',
        description: 'Edit filename extension → creator/type mappings.',
        buttonLabel: 'Edit mappings…',
      },
    ];

    const exportRows: SettingsRow[] = [
      {
        type: 'select',
        id: 'zip-export',
        label: 'Export format',
        description: 'Layout for ZIP downloads from the Finder.',
        value: prefs.zipExportStyle,
        options: exportOptions,
      },
    ];

    return [
      renderSettingsGroup('Finder', finderRows),
      renderSettingsGroup('Export', exportRows),
    ].join('');
  }

  private renderNetboot(): string {
    const state = this.host?.netboot.getState() ?? {
      enabled: false,
      diskImage: null,
      paceMs: 2,
      chainPaceMs: 10,
    };
    const diskHint = state.diskImage
      ? `${state.diskImage.name} (${state.diskImage.size.toLocaleString()} bytes)`
      : 'No System volume selected';

    const rows: SettingsRow[] = [
      {
        type: 'link',
        id: 'bootstrap-floppy',
        label: 'Bootstrap floppy',
        description: 'Download BootstrapFloppy.dsk to enable netboot XPRAM on the client Mac.',
        href: BOOTSTRAP_FLOPPY_URL,
        download: 'BootstrapFloppy.dsk',
        linkLabel: 'Download',
      },
      {
        type: 'badge',
        id: 'payload',
        label: 'Payload',
        description: 'Bundled ChainLoader.bin (256-byte ABP blocks).',
        badge: 'built-in',
      },
      {
        type: 'file',
        id: 'chainboot-disk',
        label: 'ChainBoot HFS disk',
        description: 'Writable System volume streamed over EBP.',
        accept: '.img,.hfs,.dsk,.iso,.toast,application/octet-stream',
        buttonLabel: 'Select HFS…',
        hint: diskHint,
      },
      {
        type: 'toggle',
        id: 'netboot-enabled',
        label: 'Netboot support',
        description: 'Advertises BootServer and serves ABP/EBP when serial is connected.',
        checked: state.enabled,
      },
    ];

    return renderSettingsGroup(undefined, rows);
  }

  private renderEnvironment(): string {
    const rows: SettingsRow[] = [
      {
        type: 'button',
        id: 'export-prefs',
        label: 'Export preferences',
        description: 'Save preferences, window layout, and extension mappings to a JSON file.',
        buttonLabel: 'Export…',
      },
      {
        type: 'button',
        id: 'import-prefs',
        label: 'Import preferences',
        description: 'Replace current preferences from a ClassicStack preferences file.',
        buttonLabel: 'Import…',
      },
      {
        type: 'button',
        id: 'reset-environment',
        label: 'Reset to defaults',
        description: 'Restore default preferences and window positions, then reload ClassicStack.',
        buttonLabel: 'Reset…',
        danger: true,
      },
    ];
    return renderSettingsGroup(undefined, rows);
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const t = (e.target as HTMLElement).closest('[data-act],[data-nav],[data-field]') as HTMLElement | null;
    if (!t) return;

    if (t.dataset.act === 'close') {
      this.close();
      return;
    }

    if (t.dataset.nav) {
      const next = t.dataset.nav as SettingsSection;
      if (next === this.section) return;
      this.section = next;
      this.syncSection();
      this.querySelector<HTMLElement>('.settings-nav__item.is-selected')?.focus();
      return;
    }

    const field = t.dataset.field;
    const id = t.dataset.id;
    if (field !== 'button' || !id) return;

    if (id === 'extension-editor') {
      this.host?.extensionEditor.open();
      return;
    }
    if (id === 'export-prefs') {
      this.host?.exportPreferences();
      return;
    }
    if (id === 'import-prefs') {
      await this.host?.importPreferences();
      return;
    }
    if (id === 'reset-environment') {
      await this.confirmReset();
    }
  }

  private async onChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement | HTMLSelectElement;
    const field = input.dataset.field;
    const id = input.dataset.id;
    if (!field || !id) return;

    if (field === 'toggle') {
      const checked = (input as HTMLInputElement).checked;
      await this.applyToggle(id, checked);
      return;
    }

    if (field === 'select') {
      await this.applySelect(id, input.value);
      return;
    }

    if (field === 'file') {
      const file = (input as HTMLInputElement).files?.[0] ?? null;
      await this.applyNetbootDisk(file);
    }
  }

  private async applyToggle(id: string, checked: boolean): Promise<void> {
    const host = this.host;
    if (id === 'show-hidden') {
      host?.finder?.setShowHiddenFiles?.(checked);
      host?.onPrefsChanged?.();
      return;
    }
    if (id === 'auto-expand') {
      host?.finder?.setAutoExpandFiles?.(checked);
      host?.onPrefsChanged?.();
      return;
    }
    if (id === 'read-finder-icons') {
      host?.finder?.setReadFinderIcons?.(checked);
      host?.onPrefsChanged?.();
      return;
    }
    if (id === 'netboot-enabled') {
      const netboot = host?.netboot;
      if (!netboot) return;
      const state = netboot.getState();
      if (checked && !state.diskImage) {
        log.warn('Select a ChainBoot HFS disk before enabling Netboot', 'netboot');
        this.refreshPanel();
        return;
      }
      this.updateNetboot({ enabled: checked });
      log.info(`Netboot support ${checked ? 'enabled' : 'disabled'}`, 'netboot');
    }
  }

  private async applySelect(id: string, value: string): Promise<void> {
    if (id === 'default-view') {
      const view = value as ViewMode;
      if (view !== 'icon' && view !== 'list' && view !== 'column') return;
      savePrefs({ defaultView: view });
      this.host?.finder?.setDefaultView?.(view);
      this.host?.onPrefsChanged?.();
      return;
    }
    if (id === 'zip-export') {
      savePrefs({ zipExportStyle: value === 'macosx' ? 'macosx' : 'appledouble' });
      this.host?.onPrefsChanged?.();
    }
  }

  private async applyNetbootDisk(file: File | null): Promise<void> {
    if (file) {
      log.info(`Selected ChainBoot HFS image: ${file.name} (${file.size} bytes)`, 'netboot');
    }
    this.updateNetboot({ diskImage: file });
    this.refreshPanel();
  }

  private updateNetboot(patch: Partial<NetbootState>): void {
    const netboot = this.host?.netboot;
    if (!netboot) return;
    const next = { ...netboot.getState(), ...patch };
    netboot.setState(next);
  }

  private async confirmReset(): Promise<void> {
    const host = this.host;
    if (!host?.alertDialog) return;
    const result = await host.alertDialog.confirm({
      title: 'Reset environment',
      text: 'This restores default window positions and preferences, then reloads ClassicStack.',
      checkboxLabel: 'Erase all Browser Share items',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!result.confirmed) return;
    this.close();
    await host.resetEnvironment(result.checked);
  }
}

customElements.define('settings-window', SettingsWindow);
