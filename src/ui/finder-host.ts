/** Protocol-neutral Finder host contract shared with ClassicStack’s Go SPA. */

import type { Catalog } from '../fs/virtual-fs';
import type { NameConflictChoice } from '../fs/name-conflict';
import type { WelcomePackProgress } from '../fs/welcome-pack';

/** File-sharing scheme a sidebar endpoint was discovered on (or this host’s own volumes). */
export type ShareKind = 'local' | 'afp' | 'smb' | 'ncp' | 'etherdfs';

/** Short pill on a sidebar row (AFP, TCP, NBP, …). */
export type SidebarBadge = {
  text: string;
  title?: string;
};

/**
 * One heading in the Finder sidebar. The host owns titles and order;
 * FinderWindow only renders. Unknown `RemoteEndpoint.group` values fall through
 * to the `network` group, or the first group with `refresh`.
 */
export type SidebarGroup = {
  id: string;
  title: string;
  /** Show the network-refresh control on this heading. */
  refresh?: boolean;
  /** Placeholder when the group has no endpoints. */
  empty?: string;
  /** Omit the heading when this group has no endpoints. */
  hideWhenEmpty?: boolean;
};

/** One item in a sidebar-row context menu (Configure, Mount, …). */
export type SidebarAction = {
  id: string;
  label: string;
};

/** One discoverable server or local volume the Finder can open. */
export interface RemoteEndpoint {
  /** Opaque id (NBP name, SMB server, `local:afp:Mac HD`, …). */
  id: string;
  kind: ShareKind;
  title: string;
  subtitle?: string;
  /** Sidebar section id from `FinderHost.sidebarGroups`. */
  group?: string;
  /** Share-type or transport pill (AFP, SMB, TCP, DDP, …). */
  badge?: string | SidebarBadge;
  /** File protocol for local shares (`afp`, `smb`, `ncp`, `etherdfs`). */
  protocol?: string;
  /** How this client was reached (`tcp`, `ddp`, `ipx`, `nbp`, `etherdfs`). */
  transport?: string;
  /**
   * Workgroup, AppleTalk zone, or transport network this server was found on.
   * Network Browser groups servers under this name (Browse Network → AFP → zone).
   */
  neighborhood?: string;
  /**
   * `volume` is a mounted share (eject on this row). Default `server` lists
   * volumes as children after login and shows Disconnect on this row.
   */
  role?: 'server' | 'volume';
  /** Copyable connect URI (no volume, no trailing slash). */
  uri?: string;
  /**
   * Volumes this host already knows are open on this server — from another
   * tab/session, not necessarily one this Finder window has logged into —
   * so they render as children under the server row the same way volumes
   * from this tab's own live login do (`FinderWindow.volumesFor`).
   */
  knownVolumes?: KnownVolume[];
  /**
   * Extra Chooser objects this host advertises besides file shares (PAP
   * printers, MacIP gateway, …). Network Browser lists them under the server.
   */
  services?: NetworkService[];
  /** Protocol-native address for Get Info (DDP net.node, IP, MAC, …). */
  address?: string;
  os?: string;
  version?: string;
  /** True when this row is *this* ClassicStack instance (Network Browser only). */
  own?: boolean;
}

/** One non-volume service a server may advertise in the Network Browser. */
export type NetworkServiceKind = 'share' | 'printer' | 'macipgw' | 'service';

export type NetworkService = {
  kind: NetworkServiceKind;
  name: string;
};

/** One volume a host already has open on a server, for `RemoteEndpoint.knownVolumes`. */
export type KnownVolume = {
  name: string;
  /** Friendly connect URL for this open volume (server + volume), if known. */
  path?: string;
  sessionId: string;
};

/** Result of contacting a remote (or local) endpoint before / after login. */
export interface SessionInfo {
  serverName: string;
  volumes: string[];
  allowGuest: boolean;
  uams?: string[];
}

export type Credentials =
  | { kind: 'guest' }
  | { kind: 'password'; username: string; password: string };

export interface CredentialPromptOptions {
  serverName: string;
  uams: string[];
  error?: string;
  allowGuest: boolean;
  /** File-sharing scheme; omitted on the in-browser AFP host (UAMs). */
  kind?: ShareKind;
}

/**
 * Composition root the Finder talks to for discover / login / mount.
 * ClassicStack-web implements this over TashTalk + AFP; ClassicStack’s SPA
 * implements it over HTTP to the Go server (no in-browser protocol stack).
 */
export interface FinderHost {
  isConnected(): boolean;
  nodeLabel(): string;
  /**
   * Rediscover endpoints. `scope` is a `SidebarGroup.id` so a heading’s scan
   * button can refresh only that service; omitted means all groups.
   */
  refreshNetwork(scope?: string): Promise<RemoteEndpoint[]>;
  /**
   * Last successful scan from the host (no network wait). FinderWindow paints
   * this immediately on load/reload, then awaits `refreshNetwork` for new servers.
   */
  cachedNetwork?(scope?: string): Promise<RemoteEndpoint[]>;
  /**
   * Resolves once currently-open volumes (FUSE/WinFsp mounts and live sessions)
   * are known. FinderWindow waits on this before restoring a URL path so it does
   * not bounce to “server isn’t connected” while `/finder/mounted` is in flight.
   */
  readyMounted?(): Promise<void>;
  beginRemote(ep: RemoteEndpoint): Promise<SessionInfo>;
  loginRemote(creds: Credentials): Promise<string[]>;
  openVolume(name: string): Promise<Catalog>;
  closeRemote(): Promise<void>;
  /** Close one opened volume (FPCloseVol / host unmount); stay logged in. */
  closeVolume?(name: string): Promise<void>;
  /**
   * Open a catalog for a sidebar endpoint without changing the Finder’s
   * current viewed session. Used when dropping onto a ClassicStack share or a
   * FUSE-mounted volume while another catalog is on screen.
   */
  openEndpointCatalog?(ep: RemoteEndpoint): Promise<Catalog>;
  /**
   * True when the in-process / in-browser file client is configured and running.
   * Finder shows the Network sidebar row and enables View → Network Browser.
   * Omitted: PWA uses `isConnected()`; ClassicStack treats the client as on.
   */
  networkBrowserEnabled?(): boolean;
  /**
   * File-sharing schemes the Network Browser lists as protocol folders.
   * Omitted: inferred from discovered endpoints.
   */
  networkSchemes?(): ShareKind[];
  /** IndexedDB Browser Share on the web PWA; null in the Go SPA. */
  localCatalog(): Catalog | null;
  promptCredentials(opts: CredentialPromptOptions): Promise<Credentials | null>;
  showAlert(title: string, text: string): void;
  promptNameConflict(opts: {
    name: string;
    isDir: boolean;
    suggestedName: string;
  }): Promise<NameConflictChoice>;

  /**
   * Sidebar headings in display order. Endpoints set `group` to one of these ids.
   * Omitted: a single LocalTalk/Network section (plus the IndexedDB local share).
   */
  sidebarGroups?(): SidebarGroup[];
  /** Context-menu items for a sidebar server (and optional volume child). */
  sidebarContextMenu?(ep: RemoteEndpoint, volume?: string): SidebarAction[];
  onSidebarAction?(ep: RemoteEndpoint, action: string, volume?: string): void | Promise<void>;
  /** Display name for the local catalog (default “Browser Share”). */
  localTitle?(): string;
  /**
   * Extra Get Info fields for a sidebar server or volume (UAMs, FUSE mount
   * point) that are not on `RemoteEndpoint`.
   */
  endpointInfoExtras?(
    ep: RemoteEndpoint,
    volume?: string,
  ): { uams?: string[]; mountpoint?: string; volumes?: string[]; os?: string; dialect?: string } | undefined;
  dismissLogin?(): void;
  /** TashTalk / Web Serial — omitted on the Go SPA. */
  connectTransport?(): Promise<void>;
  disconnectTransport?(): Promise<void>;
  /** Copy bundled public/welcome files into the local catalog. */
  installWelcomePack?(opts?: WelcomePackProgress): Promise<{ imported: number; skipped: number }>;
  seedWelcomePack?(
    opts?: WelcomePackProgress,
  ): Promise<{ imported: number; skipped: number } | null>;
}
