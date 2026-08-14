import './ui/styles/tokens.css';
import { WebSerialPort } from './transport/webserial';
import { LocalTalkStack } from './net/stack';
import { NbpService, type LookupResult } from './services/nbp';
import { AtpClient } from './services/atp-client';
import { AfpServer } from './services/afp-server/server';
import { AfpClient, type AfpCredentials, type AfpServerNotice } from './services/afp-client/client';
import { VirtualFS } from './fs/virtual-fs';
import { RemoteVfs } from './fs/remote-vfs';
import { FinderWindow, type FinderHost } from './ui/finder-window';
import { AppMenuBar } from './ui/app-menubar';
import { LogPanel } from './ui/log-panel';
import { ActivityWindow } from './ui/activity-window';
import { AlertDialog } from './ui/alert-dialog';
import { AfpSessionsDialog } from './ui/afp-sessions-dialog';
import { LoginDialog } from './ui/login-dialog';
import {
  NetbootDialog,
  BUNDLED_BLOCK_SIZE,
  BUNDLED_PAYLOAD_URL,
  type NetbootState,
} from './ui/netboot-dialog';
import { PcapCapture } from './util/pcap';
import { TrafficStats } from './util/traffic-stats';
import { log } from './util/logger';
import * as asp from './protocol/asp';
import { assemblePayload, MemoryDisk, NetbootService } from './services/netboot';

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
  const netboot = new NetbootDialog();
  const alertDialog = new AlertDialog();
  const afpSessions = new AfpSessionsDialog();
  const loginDialog = new LoginDialog();

  stage.appendChild(finder);
  app.append(menubar, stage, logPanel, activityWindow, netboot, alertDialog, afpSessions, loginDialog);

  const serial = new WebSerialPort();
  const pcap = new PcapCapture();
  const traffic = new TrafficStats();
  let badgeRaf = 0;
  serial.tapFrames((frame, direction) => {
    traffic.record(frame.length, direction);
    pcap.record(frame, direction);
    if (!pcap.capturing) return;
    if (badgeRaf) return;
    badgeRaf = requestAnimationFrame(() => {
      badgeRaf = 0;
      menubar.refreshCaptureStatus();
    });
  });

  menubar.bind({
    pcap,
    logPanel,
    activityWindow,
    netboot,
    afpSessions,
    finder,
    onCaptureChanged() {
      menubar.refreshCaptureStatus();
    },
  });

  let stack: LocalTalkStack | null = null;
  let nbp: NbpService | null = null;
  let atp: AtpClient | null = null;
  let afpServer: AfpServer | null = null;
  let netbootSvc: NetbootService | null = null;
  let bundledPayload: Uint8Array | null = null;
  const vfs = new VirtualFS();
  let remote: AfpClient | null = null;
  let remoteNbpName = '';
  let afpScanTimer: ReturnType<typeof setInterval> | null = null;
  let afpScanBusy = false;
  let lastAfpScanKey = '';
  const AFP_SCAN_MS = 10_000;

  activityWindow.bind({
    traffic,
    getAfpServer: () => afpServer,
  });

  await vfs.init();

  function attachRemoteNotices(client: AfpClient): void {
    client.onNotice = (n: AfpServerNotice) => {
      if (n.kind === 'closed') {
        void remote?.close().catch(() => undefined);
        if (remote === client) {
          remote = null;
          remoteNbpName = '';
        }
        finder.unmountRemote(n.text || 'The AFP server closed this session.');
        if (n.text) alertDialog.show(n.title, n.text);
        log.info(`Remote AFP session closed: ${n.text || n.title}`, 'afp');
        return;
      }
      if (n.text) alertDialog.show(n.title, n.text);
      log.info(`AFP ${n.kind} from ${n.title}: ${n.text.replace(/\n/g, ' ')}`, 'afp');
    };
  }

  afpSessions.bind({
    listSessions: () => afpServer?.listSessions() ?? [],
    sendMessage: async (sessionId, text) => {
      if (!afpServer) throw new Error('Not connected');
      await afpServer.sendMessage(sessionId, text);
    },
    disconnectSession: async (sessionId, text, minutes) => {
      if (!afpServer) throw new Error('Not connected');
      await afpServer.disconnectSession(sessionId, text, minutes);
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
    if (!state.enabled || !stack || !nbp) return;
    if (!state.diskImage) {
      log.warn('Netboot enabled but no ChainBoot HFS disk selected — not advertising', 'netboot');
      return;
    }
    try {
      const payloadRaw = await loadBundledPayload();
      const diskBytes = await fileBytes(state.diskImage);
      const payload = assemblePayload(payloadRaw, BUNDLED_BLOCK_SIZE);
      netbootSvc = new NetbootService(
        stack,
        {
          payload,
          blockSize: BUNDLED_BLOCK_SIZE,
          disk: new MemoryDisk(diskBytes),
          paceMs: state.paceMs,
          chainPaceMs: state.chainPaceMs,
        },
        nbp,
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

  function afpServerKey(s: LookupResult): string {
    return `${s.object}\0${s.network}.${s.node}:${s.socket}`;
  }

  function afpServerListKey(list: LookupResult[]): string {
    return list.map(afpServerKey).sort().join('|');
  }

  function stopAfpServerScan(): void {
    if (afpScanTimer != null) {
      clearInterval(afpScanTimer);
      afpScanTimer = null;
    }
    afpScanBusy = false;
    lastAfpScanKey = '';
  }

  async function scanAfpServers(kind: 'auto' | 'manual'): Promise<LookupResult[]> {
    if (!nbp) return [];
    while (afpScanBusy) {
      if (kind === 'auto' || !nbp) return [];
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!nbp) return [];
    afpScanBusy = true;
    try {
      const list = await nbp.lookup('=', 'AFPServer');
      if (!nbp) return [];
      const prevKey = lastAfpScanKey;
      const key = afpServerListKey(list);
      const changed = key !== prevKey;
      lastAfpScanKey = key;
      finder.setServers(list);
      if (kind === 'manual' || !prevKey || changed) {
        log.info(`NBP found ${list.length} AFPServer(s)`, 'nbp');
      }
      if (kind === 'auto' && prevKey && changed) {
        finder.setStatus(
          list.length ? `Found ${list.length} AFP server(s)` : 'No AFP servers on the network',
        );
      }
      return list;
    } finally {
      afpScanBusy = false;
    }
  }

  function startAfpServerScan(): void {
    stopAfpServerScan();
    void (async () => {
      finder.setStatus('Looking up AFPServer…');
      const list = await scanAfpServers('auto');
      if (!nbp) return;
      finder.setStatus(
        list.length
          ? `Found ${list.length} AFP server(s)`
          : 'No AFP servers found — scanning every 10s',
      );
    })();
    afpScanTimer = setInterval(() => {
      void scanAfpServers('auto');
    }, AFP_SCAN_MS);
  }

  const host: FinderHost = {
    isConnected: () => serial.connected,
    nodeLabel: () =>
      stack && stack.node
        ? `node ${stack.node.toString(16).padStart(2, '0').toUpperCase()} net ${stack.network}`
        : '',

    remoteMeta: () =>
      remote
        ? {
            nbpName: remoteNbpName || remote.serverName,
            serverName: remote.serverName,
            volumeName: remote.volumeName,
            volumes: remote.volumes.map((v) => v.name),
            loggedIn: remote.loggedIn,
          }
        : null,

    async connectSerial() {
      await serial.connect();
      stack = new LocalTalkStack(serial);
      nbp = new NbpService(stack);
      atp = new AtpClient(stack);
      afpServer = new AfpServer(stack, vfs, { volumeName: 'Browser Share', serverName: 'ClassicStack' });
      nbp.register('ClassicStack', 'AFPServer', afpServer.socket());
      stack.onClaimed((net, node) => {
        log.info(`LocalTalk node claimed: ${node} (net ${net})`, 'stack');
        finder.setStatus(`LocalTalk node claimed: ${node} (net ${net}). Sharing “Browser Share”.`);
        void applyNetboot(netboot.getState());
        startAfpServerScan();
      });
      log.info('Serial connected; starting node claim', 'serial');
      await stack.startClaim();
    },

    async disconnectSerial() {
      stopAfpServerScan();
      await remote?.close().catch(() => undefined);
      remote = null;
      remoteNbpName = '';
      netbootSvc?.stop();
      netbootSvc = null;
      stack?.stop();
      stack = null;
      nbp = null;
      atp = null;
      afpServer = null;
      traffic.reset();
      await serial.disconnect();
      log.info('Serial disconnected', 'serial');
    },

    async refreshNetwork() {
      return scanAfpServers('manual');
    },

    async beginRemote(h: LookupResult) {
      if (!atp) throw new Error('not connected');
      log.info(`AFP GetStatus/OpenSess ${h.object} (${h.network}.${h.node}:${h.socket || asp.DefaultSLS})`, 'afp');
      await remote?.close().catch(() => undefined);
      remote = await AfpClient.openSession(atp, h.network, h.node, h.socket || asp.DefaultSLS);
      remoteNbpName = h.object;
      attachRemoteNotices(remote);
      return {
        serverName: remote.serverName,
        versions: remote.versions,
        uams: remote.uams,
      };
    },

    async loginRemote(creds: AfpCredentials) {
      if (!remote) throw new Error('no AFP session');
      await remote.login(creds);
      return remote.volumes.map((v) => v.name);
    },

    async openRemoteVolume(name: string) {
      if (!remote) throw new Error('not logged in');
      const volId = await remote.openVolume(name);
      log.info(`Mounted remote ${remote.serverName || remoteNbpName}:${name} (vol ${volId})`, 'afp');
      return new RemoteVfs(remote, name, volId);
    },

    localCatalog() {
      return vfs;
    },

    promptCredentials(opts) {
      return loginDialog.prompt(opts);
    },

    dismissLogin() {
      loginDialog.close();
    },

    async findServer(nbpName: string) {
      if (!nbp) return null;
      let list = await nbp.lookup(nbpName, 'AFPServer');
      if (!list.length) list = await nbp.lookup('=', 'AFPServer');
      const hit =
        list.find((x) => x.object.toLowerCase() === nbpName.toLowerCase()) ??
        list.find((x) => x.object.toLowerCase().includes(nbpName.toLowerCase()));
      if (hit) finder.setServers(list);
      return hit ?? null;
    },

    async closeRemote() {
      await remote?.close().catch(() => undefined);
      remote = null;
      remoteNbpName = '';
      log.info('Ejected AFP server', 'afp');
    },
  };

  finder.bind(vfs, host);

  if (!WebSerialPort.supported()) {
    log.warn('WebSerial unavailable — use Chrome/Edge over HTTPS or localhost', 'serial');
    finder.setStatus('WebSerial unavailable — use Chrome/Edge over HTTPS or localhost.');
  }
}

void main();
