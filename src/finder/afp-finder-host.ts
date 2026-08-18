/** FinderHost over TashTalk + in-browser AFP (ClassicStack-web PWA). */

import { WebSerialPort } from '../transport/webserial';
import { LocalTalkStack } from '../net/stack';
import { NbpService, type LookupResult } from '../services/nbp';
import { AtpClient } from '../services/atp-client';
import { AfpServer } from '../services/afp-server/server';
import { AfpClient, type AfpServerNotice } from '../services/afp-client/client';
import { VirtualFS, type Catalog } from '../fs/virtual-fs';
import { RemoteVfs } from '../fs/remote-vfs';
import { addWelcomePack, seedWelcomePackIfNeeded } from '../fs/welcome-pack';
import type { WelcomePackProgress } from '../fs/welcome-pack';
import type {
  Credentials,
  FinderHost,
  RemoteEndpoint,
  SessionInfo,
} from '../ui/finder-host';
import type { LoginDialog } from '../ui/login-dialog';
import type { AlertDialog } from '../ui/alert-dialog';
import type { NameConflictDialog } from '../ui/name-conflict-dialog';
import type { NameConflictChoice } from '../fs/name-conflict';
import { log } from '../util/logger';
import * as asp from '../protocol/asp';
import { AfpFinderAPI } from './afp-finder-api';

export const WEB_SERIAL_HELP =
  'ClassicStack needs the Web Serial API to connect a TashTalk adaptor. Use Google Chrome (desktop or Android) or Microsoft Edge, over HTTPS or localhost. On a phone, plug the adaptor in with USB-C / OTG; 1 Mbaud with hardware flow control may fail on some Android USB stacks.';

const AFP_SCAN_MS = 10_000;

export type AfpFinderUi = {
  finder: {
    setStatus(msg: string, opts?: { busy?: boolean }): void;
    setServers(list: RemoteEndpoint[]): void;
    setNetworkScanning(v: boolean): void;
    unmountRemote(status?: string): void;
  };
  login: LoginDialog;
  alert: AlertDialog;
  nameConflict: NameConflictDialog;
  /** After a LocalTalk node is claimed (netboot, status). */
  onClaimed?: (net: number, node: number) => void;
  /** After serial disconnect (stop netboot, reset traffic). */
  onDisconnect?: () => void;
};

/**
 * Composition root for the PWA: serial → LocalTalk → AFP client/server, and a
 * FinderAPI that copies between Browser Share and remote volumes in-process.
 */
export class AfpFinderHost implements FinderHost {
  readonly api = new AfpFinderAPI();
  stack: LocalTalkStack | null = null;
  nbp: NbpService | null = null;
  atp: AtpClient | null = null;
  afpServer: AfpServer | null = null;
  remote: AfpClient | null = null;
  remoteNbpName = '';

  private afpScanTimer: ReturnType<typeof setInterval> | null = null;
  private afpScanBusy = false;
  private lastAfpScanKey = '';

  constructor(
    readonly serial: WebSerialPort,
    readonly vfs: VirtualFS,
    private readonly ui: AfpFinderUi,
  ) {
    this.api.bindLocal(vfs);
  }

  isConnected(): boolean {
    return this.serial.connected;
  }

  nodeLabel(): string {
    return this.stack && this.stack.node
      ? `node ${this.stack.node.toString(16).padStart(2, '0').toUpperCase()} net ${this.stack.network}`
      : '';
  }

  localTitle(): string {
    return 'Browser Share';
  }

  async connectTransport(): Promise<void> {
    if (!WebSerialPort.supported()) {
      this.ui.alert.show('Web Serial is not supported', WEB_SERIAL_HELP);
      throw new Error('Web Serial is not supported');
    }
    await this.serial.connect();
    this.stack = new LocalTalkStack(this.serial);
    this.nbp = new NbpService(this.stack);
    this.atp = new AtpClient(this.stack);
    this.afpServer = new AfpServer(this.stack, this.vfs, { volumeName: 'Browser Share', serverName: 'ClassicStack' });
    this.nbp.register('ClassicStack', 'AFPServer', this.afpServer.socket());
    this.stack.onClaimed((net, node) => {
      log.info(`LocalTalk node claimed: ${node} (net ${net})`, 'stack');
      this.ui.finder.setStatus(`LocalTalk node claimed: ${node} (net ${net}). Sharing “Browser Share”.`);
      this.ui.onClaimed?.(net, node);
      this.startAfpServerScan();
    });
    log.info('Serial connected; starting node claim', 'serial');
    await this.stack.startClaim();
  }

  async disconnectTransport(): Promise<void> {
    this.stopAfpServerScan();
    await this.remote?.close().catch(() => undefined);
    this.remote = null;
    this.remoteNbpName = '';
    this.stack?.stop();
    this.stack = null;
    this.nbp = null;
    this.atp = null;
    this.afpServer = null;
    await this.serial.disconnect();
    this.ui.onDisconnect?.();
    log.info('Serial disconnected', 'serial');
  }

  async refreshNetwork(): Promise<RemoteEndpoint[]> {
    const list = await this.scanAfpServers('manual');
    return list.map((s) => this.toEndpoint(s));
  }

  async beginRemote(ep: RemoteEndpoint): Promise<SessionInfo> {
    if (!this.atp) throw new Error('not connected');
    const list = this.nbp ? await this.nbp.lookup('=', 'AFPServer') : [];
    const h =
      list.find((x) => x.object === ep.id || x.object === ep.title) ??
      list.find((x) => x.object.toLowerCase() === ep.title.toLowerCase());
    if (!h) throw new Error(`AFP server “${ep.title}” is not on the network`);
    log.info(`AFP GetStatus/OpenSess ${h.object} (${h.network}.${h.node}:${h.socket || asp.DefaultSLS})`, 'afp');
    await this.remote?.close().catch(() => undefined);
    this.remote = await AfpClient.openSession(this.atp, h.network, h.node, h.socket || asp.DefaultSLS);
    this.remoteNbpName = h.object;
    this.attachRemoteNotices(this.remote);
    return {
      serverName: this.remote.serverName,
      volumes: [],
      allowGuest: this.remote.uams.some((u) => /no user authent/i.test(u)),
      uams: this.remote.uams,
    };
  }

  async loginRemote(creds: Credentials): Promise<string[]> {
    if (!this.remote) throw new Error('no AFP session');
    await this.remote.login(creds);
    return this.remote.volumes.map((v) => v.name);
  }

  async openVolume(name: string): Promise<Catalog> {
    if (!this.remote) throw new Error('not logged in');
    const volId = await this.remote.openVolume(name);
    log.info(`Mounted remote ${this.remote.serverName || this.remoteNbpName}:${name} (vol ${volId})`, 'afp');
    const sessionId = `${this.remoteNbpName}:${name}`;
    return this.api.bindRemote(sessionId, new RemoteVfs(this.remote, name, volId));
  }

  localCatalog(): Catalog {
    return this.api.localCatalog() ?? this.vfs;
  }

  installWelcomePack(opts?: WelcomePackProgress) {
    return addWelcomePack(this.vfs, opts);
  }

  seedWelcomePack(opts?: WelcomePackProgress) {
    return seedWelcomePackIfNeeded(this.vfs, opts);
  }

  promptCredentials(opts: Parameters<FinderHost['promptCredentials']>[0]): Promise<Credentials | null> {
    return this.ui.login.prompt(opts);
  }

  dismissLogin(): void {
    this.ui.login.close();
  }

  showAlert(title: string, text: string): void {
    this.ui.alert.show(title, text);
  }

  promptNameConflict(opts: { name: string; isDir: boolean; suggestedName: string }): Promise<NameConflictChoice> {
    return this.ui.nameConflict.prompt(opts);
  }

  async closeRemote(): Promise<void> {
    await this.remote?.close().catch(() => undefined);
    this.remote = null;
    this.remoteNbpName = '';
    log.info('Disconnected from AFP server', 'afp');
  }

  async closeVolume(name: string): Promise<void> {
    await this.remote?.closeVolume(name);
    this.api.unbind(`${this.remoteNbpName}:${name}`);
    log.info(`Released AFP volume “${name}” (session still logged in)`, 'afp');
  }

  private attachRemoteNotices(client: AfpClient): void {
    client.onNotice = (n: AfpServerNotice) => {
      if (n.kind === 'closed') {
        void this.remote?.close().catch(() => undefined);
        if (this.remote === client) {
          this.remote = null;
          this.remoteNbpName = '';
        }
        this.ui.finder.unmountRemote(n.text || 'The AFP server closed this session.');
        if (n.text) this.ui.alert.show(n.title, n.text);
        log.info(`Remote AFP session closed: ${n.text || n.title}`, 'afp');
        return;
      }
      if (n.text) this.ui.alert.show(n.title, n.text);
      log.info(`AFP ${n.kind} from ${n.title}: ${n.text.replace(/\n/g, ' ')}`, 'afp');
    };
  }

  private toEndpoint(s: LookupResult): RemoteEndpoint {
    return {
      id: s.object,
      kind: 'afp',
      title: s.object,
      subtitle: s.zone && s.zone !== '*' ? s.zone : `${s.network}.${s.node}`,
      badge: 'NBP',
      transport: 'nbp',
    };
  }

  private afpServerKey(s: LookupResult): string {
    return `${s.object}\0${s.network}.${s.node}:${s.socket}`;
  }

  private afpServerListKey(list: LookupResult[]): string {
    return list.map((s) => this.afpServerKey(s)).sort().join('|');
  }

  stopAfpServerScan(): void {
    if (this.afpScanTimer != null) {
      clearInterval(this.afpScanTimer);
      this.afpScanTimer = null;
    }
    this.afpScanBusy = false;
    this.lastAfpScanKey = '';
    this.ui.finder.setNetworkScanning(false);
  }

  private startAfpServerScan(): void {
    this.stopAfpServerScan();
    void (async () => {
      this.ui.finder.setStatus('Looking up AFPServer…');
      const list = await this.scanAfpServers('auto');
      if (!this.nbp) return;
      this.ui.finder.setStatus(
        list.length
          ? `Found ${list.length} AFP server(s)`
          : 'No AFP servers found — scanning every 10s',
      );
    })();
    this.afpScanTimer = setInterval(() => {
      void this.scanAfpServers('auto');
    }, AFP_SCAN_MS);
  }

  private async scanAfpServers(kind: 'auto' | 'manual'): Promise<LookupResult[]> {
    if (!this.nbp) return [];
    while (this.afpScanBusy) {
      if (kind === 'auto' || !this.nbp) return [];
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.nbp) return [];
    this.afpScanBusy = true;
    this.ui.finder.setNetworkScanning(true);
    try {
      const list = await this.nbp.lookup('=', 'AFPServer');
      if (!this.nbp) return [];
      const prevKey = this.lastAfpScanKey;
      const key = this.afpServerListKey(list);
      const changed = key !== prevKey;
      this.lastAfpScanKey = key;
      this.ui.finder.setServers(list.map((s) => this.toEndpoint(s)));
      if (kind === 'manual' || !prevKey || changed) {
        log.info(`NBP found ${list.length} AFPServer(s)`, 'nbp');
      }
      if (kind === 'auto' && prevKey && changed) {
        this.ui.finder.setStatus(
          list.length ? `Found ${list.length} AFP server(s)` : 'No AFP servers on the network',
        );
      }
      return list;
    } finally {
      this.afpScanBusy = false;
      this.ui.finder.setNetworkScanning(false);
    }
  }
}
