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
}

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
}

/**
 * Composition root the Finder talks to for discover / login / mount.
 * ClassicStack-web implements this over TashTalk + AFP; ClassicStack’s SPA
 * implements it over HTTP to the Go server (no in-browser protocol stack).
 */
export interface FinderHost {
  isConnected(): boolean;
  nodeLabel(): string;
  refreshNetwork(): Promise<RemoteEndpoint[]>;
  beginRemote(ep: RemoteEndpoint): Promise<SessionInfo>;
  loginRemote(creds: Credentials): Promise<string[]>;
  openVolume(name: string): Promise<Catalog>;
  closeRemote(): Promise<void>;
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
  /** Display name for the local catalog (default “Browser Share”). */
  localTitle?(): string;
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
