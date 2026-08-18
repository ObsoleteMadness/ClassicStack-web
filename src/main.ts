import './ui/styles/tokens.css';
import { WebSerialPort } from './transport/webserial';
import { VirtualFS } from './fs/virtual-fs';
import { skipWelcomePackSeed } from './fs/welcome-pack';
import { resetExtensionMap } from './fs/extension-map';
import { FinderWindow } from './ui/finder-window';
import { AfpFinderHost, WEB_SERIAL_HELP } from './finder/afp-finder-host';
import { AppMenuBar } from './ui/app-menubar';
import { LogPanel } from './ui/log-panel';
import { ActivityWindow } from './ui/activity-window';
import { FileActivityWindow } from './ui/file-activity-window';
import { AlertDialog } from './ui/alert-dialog';
import { AboutDialog } from './ui/about-dialog';
import { AfpSessionsDialog } from './ui/afp-sessions-dialog';
import { LoginDialog } from './ui/login-dialog';
import { NameConflictDialog } from './ui/name-conflict-dialog';
import { ExtensionEditorDialog } from './ui/extension-editor-dialog';
import { ResourceForkExplorer } from './ui/resource-fork-explorer';
import { GetInfoWindow } from './ui/get-info-window';
import {
  NetbootDialog,
  BUNDLED_BLOCK_SIZE,
  BUNDLED_PAYLOAD_URL,
  type NetbootState,
} from './ui/netboot-dialog';
import { SettingsWindow } from './ui/settings-window';
import { PcapCapture } from './util/pcap';
import { TrafficStats } from './util/traffic-stats';
import { log } from './util/logger';
import { clearPrefs } from './util/prefs';
import { iconCache } from './fs/icon-cache';
import { clearWindowLayouts, loadWindowLayouts } from './ui/window-layout';
import { startLayoutMode } from './ui/layout-mode';
import { assemblePayload, MemoryDisk, NetbootService } from './services/netboot';
import { registerPwa } from './pwa';

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main(): Promise<void> {
  log.installConsoleBridge();
  startLayoutMode();
  registerPwa();
  log.info('ClassicStack starting', 'app');

  const app = document.querySelector('#app')!;
  app.innerHTML = '';

  const menubar = new AppMenuBar();
  const stage = document.createElement('div');
  stage.className = 'app-stage';
  const finder = new FinderWindow();
  const logPanel = new LogPanel();
  logPanel.hidden = true;
  const activityWindow = new ActivityWindow();
  activityWindow.hidden = true;
  const fileActivityWindow = new FileActivityWindow();
  fileActivityWindow.hidden = true;
  const netboot = new NetbootDialog();
  const about = new AboutDialog();
  const alertDialog = new AlertDialog();
  const afpSessions = new AfpSessionsDialog();
  const loginDialog = new LoginDialog();
  const nameConflictDialog = new NameConflictDialog();
  const extensionEditor = new ExtensionEditorDialog();
  const resourceExplorer = new ResourceForkExplorer();
  resourceExplorer.hidden = true;
  const getInfoWindow = new GetInfoWindow();
  getInfoWindow.hidden = true;
  const settings = new SettingsWindow();

  stage.appendChild(finder);
  app.append(menubar, stage, logPanel, activityWindow, fileActivityWindow, netboot, about, alertDialog, afpSessions, loginDialog, nameConflictDialog, extensionEditor, resourceExplorer, getInfoWindow, settings);

  const serial = new WebSerialPort();
  const pcap = new PcapCapture();
  const traffic = new TrafficStats();
  const CAPTURE_STATUS_MS = 5_000;
  let lastCaptureStatusAt = 0;
  serial.tapFrames((frame, direction) => {
    traffic.record(frame.length, direction);
    pcap.record(frame, direction);
    if (!pcap.capturing) return;
    const now = Date.now();
    if (now - lastCaptureStatusAt < CAPTURE_STATUS_MS) return;
    lastCaptureStatusAt = now;
    menubar.refreshCaptureStatus();
  });

  let netbootSvc: NetbootService | null = null;
  let bundledPayload: Uint8Array | null = null;
  const vfs = new VirtualFS();
  await vfs.init();

  const host = new AfpFinderHost(serial, vfs, {
    finder,
    login: loginDialog,
    alert: alertDialog,
    nameConflict: nameConflictDialog,
    onClaimed() {
      void applyNetboot(netboot.getState());
    },
    onDisconnect() {
      netbootSvc?.stop();
      netbootSvc = null;
      traffic.reset();
    },
  });

  activityWindow.bind({
    traffic,
    getAfpServer: () => host.afpServer,
  });

  afpSessions.bind({
    listSessions: () => host.afpServer?.listSessions() ?? [],
    sendMessage: async (sessionId, text) => {
      if (!host.afpServer) throw new Error('Not connected');
      await host.afpServer.sendMessage(sessionId, text);
    },
    disconnectSession: async (sessionId, text, minutes) => {
      if (!host.afpServer) throw new Error('Not connected');
      await host.afpServer.disconnectSession(sessionId, text, minutes);
    },
  });

  async function loadBundledPayload(): Promise<Uint8Array> {
    if (!bundledPayload) {
      bundledPayload = await fetchBytes(BUNDLED_PAYLOAD_URL);
      log.info(`Loaded bundled ChainLoader.bin (${bundledPayload.length} bytes)`, 'netboot');
    }
    return bundledPayload;
  }

  async function applyNetboot(state: NetbootState): Promise<void> {
    netbootSvc?.stop();
    netbootSvc = null;
    if (!state.enabled || !host.stack || !host.nbp) return;
    if (!state.diskImage) {
      log.warn('Netboot enabled but no ChainBoot HFS disk selected — not advertising', 'netboot');
      return;
    }
    try {
      const payloadRaw = await loadBundledPayload();
      const diskBytes = await fileBytes(state.diskImage);
      const payload = assemblePayload(payloadRaw, BUNDLED_BLOCK_SIZE);
      netbootSvc = new NetbootService(
        host.stack,
        {
          payload,
          blockSize: BUNDLED_BLOCK_SIZE,
          disk: new MemoryDisk(diskBytes),
          paceMs: state.paceMs,
          chainPaceMs: state.chainPaceMs,
        },
        host.nbp,
      );
      netbootSvc.start();
    } catch (err) {
      log.error(`Netboot failed to start: ${err instanceof Error ? err.message : String(err)}`, 'netboot');
      netbootSvc = null;
    }
  }

  netboot.bind((state) => {
    void applyNetboot(state);
  });

  async function resetEnvironment(eraseShare: boolean): Promise<void> {
    log.info(eraseShare ? 'Resetting environment (including Browser Share)' : 'Resetting environment', 'app');
    try {
      await host.disconnectTransport?.();
    } catch {
      /* already disconnected */
    }
    clearPrefs();
    clearWindowLayouts();
    resetExtensionMap();
    await iconCache.clear().catch(() => undefined);
    if (eraseShare) {
      try {
        await vfs.eraseAllItems();
        await skipWelcomePackSeed(vfs);
      } catch (err) {
        log.warn(`Failed to erase Browser Share: ${err instanceof Error ? err.message : String(err)}`, 'fs');
      }
    }
    location.reload();
  }

  menubar.bind({
    pcap,
    logPanel,
    activityWindow,
    afpSessions,
    resourceExplorer,
    getInfoWindow,
    about,
    alertDialog,
    settings,
    finder,
    onCaptureChanged() {
      menubar.refreshCaptureStatus();
    },
  });

  settings.bind({
    finder,
    netboot,
    extensionEditor,
    alertDialog,
    exportPreferences: () => menubar.exportPreferences(),
    importPreferences: () => menubar.importPreferences(),
    resetEnvironment,
    onPrefsChanged: () => menubar.refresh(),
  });

  const savedWindows = loadWindowLayouts();
  if (savedWindows.log?.open) logPanel.show();
  if (savedWindows.activity?.open) activityWindow.show();
  if (savedWindows.resource?.open) resourceExplorer.show();

  finder.bind(vfs, host);
  finder.bindResourceExplorer(resourceExplorer);
  finder.bindGetInfoWindow(getInfoWindow);

  if (!WebSerialPort.supported()) {
    log.warn('WebSerial unavailable — use Chrome/Edge over HTTPS or localhost', 'serial');
    finder.setStatus('WebSerial unavailable — use Chrome/Edge over HTTPS or localhost.');
    alertDialog.show('Web Serial is not supported', WEB_SERIAL_HELP);
  }
}

void main();
