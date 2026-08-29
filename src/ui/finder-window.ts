import type { Catalog, VNode } from '../fs/virtual-fs';
import { nodeRef, parentRef } from '../fs/virtual-fs';
import { EmptyCatalog } from '../fs/empty-catalog';
import type { CatalogCapabilities, NodeRef } from '../fs/catalog-caps';
import { parseRefKey, refKey, refsEqual, showsResourceFork, showsTypeCreator } from '../fs/catalog-caps';
import { formatStorePath, networkGlyphSrc, sidebarGlyphSrc, volumeChrome, type SidebarGlyphRole } from '../fs/volume-chrome';
import { isNetworkCatalog, NetworkCatalog } from '../fs/network-catalog';
import {
  matchNetworkServer,
  NETWORK_ROOT_NAME,
  NETWORK_SHARE_KEY,
  parseNetworkPath,
  serverNetworkPath,
} from '../fs/network-tree';
import {
  isNetworkContainer,
  isNetworkNavigable,
  isNetworkOpenable,
  opsForNetworkNode,
  overlayNativeOf,
  selectionAllowsMutate,
  selectionAllowsZip,
} from '../fs/network-ops';
import { buildLocationCrumbs, type LocationMode } from './finder-location';
import { modelFromEndpoint, networkInfoHtml, type NetworkInfoModel } from './network-info';
import type { ByteRangeReader } from '../fs/byte-range';
import type {
  Credentials,
  FinderHost,
  RemoteEndpoint,
  SessionInfo,
  SidebarAction,
  SidebarBadge,
  SidebarGroup,
} from './finder-host';
import { decodeMacRoman } from '../protocol/macroman';
import { buildAppleDouble, zipSidecarPath, zipStore, type ZipExportStyle } from '../fs/appledouble';
import { collectZipEntries, enumerateZipFiles, type ZipFilePlan } from '../fs/zip-export';
import { downloadBytes } from '../util/pcap';
import { formatBytes } from './format-bytes';
import {
  iconCache,
  readTypeCreator,
  isCustomFolderIconName,
  isFinderInvisible,
  isDefaultFolderIcon,
  isWinIconName,
  DEFAULT_FOLDER_ICONS,
  type IconUrls,
} from '../fs/icon-cache';
import { expandArchiveFile, expandFailureMessage, isExpandableArchive, type ExpandedNode } from '../fs/expand-incoming';
import { expandSitInPlace } from '../fs/expand-inplace';
import type { WelcomePackProgress } from '../fs/welcome-pack';
import { importExpandedTree, type ImportItemTrack } from '../fs/import-transfer';
import { decodeVers1, versInfoForGetInfo, type VersGetInfo, type VersRec } from '../fs/resource-types/vers';
import {
  decodeBmp,
  decodeIco,
  extractWinVersion,
  isWinResourceName,
  isWinVersionName,
  pickIconNear,
  type WinVersionGetInfo,
} from '../fs/winicon';
import {
  finderCommentFromFork,
  finderCommentId,
  finderFlagLabels,
  finderGetInfoDetails,
} from '../fs/finder-info';
import { loadPrefs, savePrefs } from '../util/prefs';
import { log } from '../util/logger';
import { isAbortError, throwIfAborted } from '../util/abort';
import { VisibleIconQueue } from './icon-prefetch';
import { uiIcons } from './lucide-icon';
import { enableWindowMove, enableWindowResize, onWindowGeometryChange } from './window-resize';
import {
  applyWindowFrame,
  defaultFinderFrame,
  loadWindowLayouts,
  persistWindow,
  restoreWindow,
} from './window-layout';
import type { ResourceForkExplorer } from './resource-fork-explorer';
import type { WinResourceExplorer } from './win-resource-explorer';
import type { GetInfoWindow } from './get-info-window';
import { isCompactUi, onLayoutModeChange } from './layout-mode';
import { positionCallout } from './callout';
import { paintTransferList } from './transfer-list';
import {
  transferActivity,
  TRANSFER_DETAIL_SEARCHING,
  TRANSFER_FILE_ICON,
  type TransferWriteProgress,
} from '../util/transfer-activity';
import {
  isTransferCancelled,
  planItemPlacement,
  uniqueCopyName,
  TransferCancelled,
  type PlacementPlan,
} from '../fs/name-conflict';
import { decodePict, pictToSvg } from '../fs/pict/pict';
import { decodedIconToDataUrl } from '../fs/resource-types/icon-decoder';
import { isBmpPreview, isIcoPreview, previewKindFor, previewMime, type FilePreviewKind } from './file-preview';
import { isCatalogWithBackend } from '../finder/api';
import {
  SIDEBAR_GROUP_NETWORK,
  assignSidebarGroup,
  badgeText,
  badgeTitle,
  connectedEndpointTitle,
  endpointsByGroup,
  isCatalogEndpoint,
  LOCAL_SHARE_KEY,
  shareDropFromElement,
  shareKeyForEndpoint,
  viewingCatalogEndpoint,
  visibleSidebarGroups,
  volumesForEndpoint,
  resolveSidebarActive,
} from './finder-sidebar';

/** Empty Finder pane when no sidebar volume is open. */
const NO_VOLUME_HINT = 'Select a volume from the side bar';

export type ViewMode = 'icon' | 'list' | 'column';
export type SortKey = 'name' | 'modified' | 'size';

/** Finder file types that open in the Quick Look overlay. */
const PREVIEW_TEXT_MAX_BYTES = 512 * 1024;

export type {
  Credentials,
  FinderHost,
  RemoteEndpoint,
  SessionInfo,
  SidebarBadge,
  SidebarGroup,
} from './finder-host';

/** Options for `FinderWindow.openRemote` (URI / Advanced “Open by Path”). */
export type OpenRemoteOptions = {
  /** Volume/share to mount after login. Omitted: list volumes and wait. */
  volume?: string;
  /** Try these before the login dialog (URI userinfo). */
  credentials?: Credentials;
  /**
   * When no `volume` is given, open the only advertised share automatically.
   * Default true (path-open / URI). Sidebar clicks pass false and list shares.
   */
  autoOpenSingle?: boolean;
  /**
   * After login with no volume, show this server’s shares in the Finder pane
   * (Network Browser folder). Default false — sidebar server clicks pass true.
   */
  listShares?: boolean;
  /** Folder path inside the volume (`csclient` URI path after the share). */
  folderPath?: string;
  /** Typed client URI to show in the path bar (Advanced → Open by Path). */
  locationUri?: string;
  /** How this open should appear in the path bar. */
  locationMode?: LocationMode;
  /**
   * Login / open a volume without replacing the Network Browser catalog.
   * Used when expanding zone → server → share in place.
   */
  attachOnly?: boolean;
};

class NetworkAuthCancelled extends Error {
  constructor() {
    super('Network authentication cancelled');
    this.name = 'NetworkAuthCancelled';
  }
}

function isListingCancelled(err: unknown): boolean {
  return isAbortError(err) || (err instanceof Error && err.name === 'NetworkAuthCancelled');
}

interface ListItem {
  key: string;
  name: string;
  isDir: boolean;
  size: number;
  mod: Date;
  node: VNode | null;
  finderInfo?: Uint8Array;
  /** Synthetic row shown until the first enumerate page arrives. */
  placeholder?: boolean;
  /** Dest of an in-flight copy/import; overlay a percent loader on the icon. */
  writing?: TransferWriteProgress;
}

const LISTING_PLACEHOLDER_KEY = '__listing__';

interface ClipNode {
  name: string;
  isDir: boolean;
  data: Uint8Array;
  resource: Uint8Array;
  finderInfo: Uint8Array;
  kids?: ClipNode[];
}

/** On-disk size for Finder lists: data fork + resource fork. */
function nodeByteSize(n: VNode, includeResource = true): number {
  if (n.isDir) return 0;
  const data = n.dataBytes ?? n.data.length;
  if (!includeResource) return data;
  return data + (n.resourceBytes ?? n.resource.length);
}

function nodeHasResourceFork(n: VNode): boolean {
  if (n.isDir) return false;
  return (n.resourceBytes ?? n.resource.length) > 0;
}

function clipByteSize(item: ClipNode): number {
  if (item.isDir) return (item.kids ?? []).reduce((n, k) => n + clipByteSize(k), 0);
  return item.data.length + item.resource.length;
}

function unixDate(ms: number): Date {
  return ms ? new Date(ms) : new Date(0);
}

function dataRef(el: Element | null): NodeRef | null {
  if (!el) return null;
  return parseRefKey(el.getAttribute('data-id'));
}

function selRef(ref: NodeRef): string {
  return CSS.escape(refKey(ref));
}

function itemAddr(it: ListItem): NodeRef | null {
  return it.node ? nodeRef(it.node) : parseRefKey(it.key);
}

export class FinderWindow extends HTMLElement {
  private vfs!: Catalog;
  private localVfs: Catalog | null = null;
  private networkCatalog: NetworkCatalog | null = null;
  private host!: FinderHost;
  private view: ViewMode = 'icon';
  private cwd: NodeRef = 2;
  private pathStack: { id: NodeRef; name: string }[] = [{ id: 2, name: 'Browser Share' }];
  /** For column view: one column of children per pathStack entry. */
  private columnChildren: VNode[][] = [];
  private selectedId: NodeRef | null = null;
  /** Full multi-selection; always a superset containing `selectedId` (the anchor/primary item). */
  private selectedIds = new Set<NodeRef>();
  /** Range-select (shift-click) start; separate from `selectedId` so repeated shift-clicks re-range from it. */
  private selectionAnchorId: NodeRef | null = null;
  private nodes: VNode[] = [];
  private servers: RemoteEndpoint[] = [];
  private source: 'local' | 'remote' = 'local';
  private status = 'Connect a TashTalk adaptor to begin.';
  private statusBusy = false;
  private welcomePackBusy = false;
  private showProps = false;
  private remoteOpen = false;
  /** True after AFP login; volumes listed under the server until disconnect. */
  private remoteLoggedIn = false;
  private remoteVolumes: string[] = [];
  /** Volumes enumerated for a server stay in the sidebar after switching rows. */
  private knownVolumes = new Map<string, string[]>();
  private loggedInEndpoints = new Set<string>();
  /** Share keys of volumes the user has opened (eject is hidden until then). */
  private openedVolumeKeys = new Set<string>();
  private remoteBusy = false;
  /** Sidebar endpoint id currently connecting / opening (spinner + selection). */
  private connectingEndpointId: string | null = null;
  /** Volume child name when opening a share under a server row. */
  private connectingVolume: string | null = null;
  private remoteNbpName = '';
  private remoteEndpoint: RemoteEndpoint | null = null;
  /** How the current location was entered — drives path-bar crumbs. */
  private locationMode: LocationMode = 'local';
  private locationUri = '';
  /** Network Browser crumbs kept when a share is mounted from that trail. */
  private networkPrefix: { name: string; path: string; iconSrc?: string }[] = [];
  private eventsBound = false;
  private dragDepth = 0;
  /** Folder ids expanded in list-view outline. */
  private expandedIds = new Set<NodeRef>();
  /** Folders whose children are being fetched (list disclose / column pane). */
  private loadingIds = new Set<NodeRef>();
  private folderLoadGen = new Map<NodeRef, number>();
  private columnLoading = false;
  private columnLoadGen = 0;
  /** Per-column widths in column view (`"0"`, `"1"`, …, `"preview"`). */
  private columnWidths = new Map<string, number>();
  private columnResize: {
    col: HTMLElement;
    handle: HTMLElement;
    key: string;
    startX: number;
    startW: number;
  } | null = null;
  private folderOpening = false;
  /** Folder whose children are being enumerated (spinner on that folder's glyph). */
  private enumeratingFolderId: NodeRef | null = null;
  private listChildCache = new Map<NodeRef, VNode[]>();
  /** Skip pushState while applying browser back/forward. */
  private historyQuiet = false;
  /** In-app navigation stack for ⌘[/]/ shortcuts (separate from leaving the page). */
  private navStack: ReturnType<FinderWindow['historySnapshot']>[] = [];
  private navIndex = -1;
  private navLock = false;
  private sortKey: SortKey = 'name';
  private sortDir: 'asc' | 'desc' = 'asc';
  private renamingId: NodeRef | null = null;
  private clipboard: {
    mode: 'cut' | 'copy';
    items: ClipNode[];
    source: Catalog | null;
    sourceIds: NodeRef[];
  } | null = null;
  private catalogs = new Map<string, Catalog>();
  private volumeUnsubs = new Map<string, () => void>();
  private contextMenu: {
    x: number;
    y: number;
    targetId: NodeRef | null;
    local?: boolean;
    sidebar?: { index: number; volume?: string; actions: SidebarAction[] };
  } | null = null;
  /** Show Finder-invisible / Icon\\r items (persisted via prefs). */
  private showHiddenFiles = loadPrefs().showHiddenFiles;
  /** Decode dropped BinHex / MacBinary (persisted via prefs). */
  private autoExpandFiles = loadPrefs().autoExpandFiles;
  /** Probe Icon\\r / resource forks for custom glyphs (persisted via prefs). */
  private readFinderIcons = loadPrefs().readFinderIcons;
  /** Local item being dragged (null for external file drops). */
  private dragNodeId: NodeRef | null = null;
  private dragNode: VNode | null = null;
  private dragCatalog: Catalog | null = null;
  private dropHoverFolderId: NodeRef | null = null;
  private springTimer: ReturnType<typeof setTimeout> | null = null;
  private springFolderId: NodeRef | null = null;
  private springShareKey: string | null = null;
  private vfsUnsub: (() => void) | null = null;
  private vfsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Parent folder ids coalesced from VFS change events until the debounced refresh. */
  private pendingVfsParents = new Set<NodeRef>();
  /** Nested Finder-initiated catalog writes; echoed VFS events are ignored while > 0. */
  private ownVfsMutation = 0;
  /** Resolved icon URLs keyed by ListItem.key (or type|creator). */
  private iconUrls = new Map<string, IconUrls>();
  private iconLoadGen = 0;
  /** Cancels queued FPGetIcon / icon-fork AFP work when leaving a folder. */
  private iconAbort: AbortController | null = null;
  /** Finder items waiting for a visible-icon load slot. */
  private iconPrefetchItems = new Map<string, ListItem>();
  private iconObserver: IntersectionObserver | null = null;
  /** Finder item elements currently intersecting the visible Finder pane. */
  private iconIntersectingEls = new Set<Element>();
  private iconQueue = new VisibleIconQueue<ListItem>(
    (it) => this.resolveVisibleIcon(it),
    (it) => this.isFinderIconVisible(it.key),
  );
  /** Cached `vers` 1 Get Info strings, keyed by node id. */
  private versInfo = new Map<NodeRef, { stamp: string; info: VersGetInfo | null }>();
  /** Cached Finder comment from `FCMT` in the resource fork. */
  private commentInfo = new Map<NodeRef, { stamp: string; comment: string | null }>();
  private versPending = new Set<NodeRef>();
  /** Cancels the in-flight cwd / column listing when navigating to another folder. */
  private navListAbort: AbortController | null = null;
  /** Per-folder list-view disclose listings; aborted on collapse or navigation. */
  private expandListAbort = new Map<NodeRef, AbortController>();
  /** Sidebar group id being scanned, or `'*'` for a full refresh. */
  private networkScanning: string | null = null;
  private preview: {
    id: NodeRef;
    name: string;
    kind: FilePreviewKind;
    text: string | null;
    url?: string | null;
    truncated?: boolean;
    error?: string;
  } | null = null;
  private previewGen = 0;
  /** Desktop view to restore when leaving compact layout. */
  private desktopView: ViewMode | null = null;
  private sidebarOpen = false;
  private openCallout: null | 'transfers' | 'actions' | 'share' = null;
  private unsubTransfer: (() => void) | null = null;
  private unsubLayout: (() => void) | null = null;
  private transferIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private transferRaf = 0;
  private lastTransferPct = 0;
  private transferBtnVisible = false;
  private writeSig = '';
  private resourceExplorer: ResourceForkExplorer | null = null;
  private winResourceExplorer: WinResourceExplorer | null = null;
  private getInfoWindow: GetInfoWindow | null = null;
  private finderLayoutReady = false;

  bindResourceExplorer(panel: ResourceForkExplorer): void {
    this.resourceExplorer = panel;
  }

  bindWinResourceExplorer(panel: WinResourceExplorer): void {
    this.winResourceExplorer = panel;
  }

  bindGetInfoWindow(win: GetInfoWindow): void {
    this.getInfoWindow = win;
    win.onAction = (act) => void this.handleAction(act);
    win.onClose = () => {
      this.showProps = false;
      this.syncPropsButton();
    };
  }

  /** Open the resource-fork explorer on the current (or given) item. */
  openResourceExplorer(id?: NodeRef | null): void {
    const node = id != null ? this.findNodeAnywhere(id) : this.selectedNode();
    this.resourceExplorer?.open(this.vfs, node);
  }

  /** Open the PE/NE resource explorer on the current (or given) item. */
  openWinResourceExplorer(id?: NodeRef | null): void {
    const node = id != null ? this.findNodeAnywhere(id) : this.selectedNode();
    this.winResourceExplorer?.open(this.vfs, node);
  }

  private syncResourceExplorer(): void {
    const node = this.selectedNode();
    this.resourceExplorer?.followSelection(this.vfs, node);
    this.winResourceExplorer?.followSelection(this.vfs, node);
  }

  /** Drop resolved icons after Advanced → Clear icon cache. */
  invalidateIcons(): void {
    this.iconUrls.clear();
    this.bumpIconLoadGen();
    iconCache.clearDirectoryCache();
    this.renderContent();
    this.renderPath();
  }

  getShowHiddenFiles(): boolean {
    return this.showHiddenFiles;
  }

  /** Toggle or set hidden-file visibility; persists and refreshes the view. */
  setShowHiddenFiles(show: boolean): void {
    if (this.showHiddenFiles === show) return;
    this.showHiddenFiles = show;
    savePrefs({ showHiddenFiles: show });
    void this.reload().then(() => {
      this.renderContent();
      this.renderPath();
    });
  }

  getAutoExpandFiles(): boolean {
    return this.autoExpandFiles;
  }

  setAutoExpandFiles(expand: boolean): void {
    if (this.autoExpandFiles === expand) return;
    this.autoExpandFiles = expand;
    savePrefs({ autoExpandFiles: expand });
  }

  getReadFinderIcons(): boolean {
    return this.readFinderIcons;
  }

  /** Live volume feature flags (Get Info / View menu). */
  catalogCapabilities(): CatalogCapabilities | null {
    return this.vfs ? this.caps() : null;
  }

  getDefaultView(): ViewMode {
    return loadPrefs().defaultView;
  }

  /** Persist default Finder view for new sessions (does not change the current view). */
  setDefaultView(view: ViewMode): void {
    if (view !== 'icon' && view !== 'list' && view !== 'column') return;
    savePrefs({ defaultView: view });
  }

  /** Toggle Icon\\r / resource-fork icon reads; persists and refreshes glyphs. */
  setReadFinderIcons(read: boolean): void {
    if (this.readFinderIcons === read) return;
    this.readFinderIcons = read;
    savePrefs({ readFinderIcons: read });
    this.invalidateIcons();
  }

  getView(): ViewMode {
    return this.view;
  }

  getSortKey(): SortKey {
    return this.sortKey;
  }

  async applyViewMode(mode: ViewMode): Promise<void> {
    await this.setView(mode);
  }

  async applySortKey(key: SortKey): Promise<void> {
    await this.applySort(key, false);
  }

  /** True when View → Network Browser and the Network sidebar row should be offered. */
  networkBrowserEnabled(): boolean {
    if (this.host?.networkBrowserEnabled) return this.host.networkBrowserEnabled();
    return this.hasTransport() ? this.host.isConnected() : true;
  }

  /** Open Browse Network at the root (View → Network Browser). */
  async openNetworkBrowser(): Promise<void> {
    if (!this.networkBrowserEnabled()) return;
    await this.showNetworkBrowser();
    this.closeSidebar();
    this.syncHistory();
    this.render();
  }

  /** True while the Network Browser catalog is the on-screen listing. */
  isNetworkBrowserOpen(): boolean {
    return isNetworkCatalog(this.vfs);
  }

  selectionSupportsPreview(): boolean {
    if (this.selectedId == null || this.selectedIds.size > 1) return false;
    const node = this.findNodeAnywhere(this.selectedId);
    return this.isPreviewable(node);
  }

  async menuOpenPreview(): Promise<void> {
    await this.openPreview();
  }

  async menuNewFolder(): Promise<void> {
    await this.onMkdir();
  }

  async menuDownloadZip(): Promise<void> {
    await this.onDownload();
  }

  menuGetInfo(): void {
    this.showPropertiesPanel();
  }

  menuRename(): void {
    this.startRename();
  }

  async menuDelete(): Promise<void> {
    await this.onDelete();
  }

  canCloseMountedShare(): boolean {
    return this.remoteEndpoint?.group === 'mounted';
  }

  async menuCloseShare(): Promise<void> {
    const ep = this.remoteEndpoint;
    if (!ep || ep.group !== 'mounted') return;
    await this.ejectEndpoint(ep);
  }

  bind(vfs: Catalog | null, host: FinderHost): void {
    this.host = host;
    this.localVfs = vfs ?? host.localCatalog();
    if (this.localVfs) {
      this.catalogs.set(LOCAL_SHARE_KEY, this.localVfs);
      this.attachCatalog(this.localVfs);
    } else {
      this.showNoVolumeSelected();
    }
    this.ensureShellEvents();
    void this.bootstrapFromLocation().then(() => {
      this.applyCompactView();
      if (this.hasLocalShare()) void this.runWelcomePack({ seed: true });
      if (!this.hasTransport()) {
        this.setStatus(NO_VOLUME_HINT);
        void this.onRefresh();
      }
    });
  }

  private hasLocalShare(): boolean {
    return this.localVfs != null;
  }

  private localShareTitle(): string {
    return this.host?.localTitle?.() || 'Browser Share';
  }

  private hasTransport(): boolean {
    return typeof this.host?.connectTransport === 'function';
  }

  private ensureNetworkCatalog(): NetworkCatalog {
    if (!this.networkCatalog) {
      this.networkCatalog = new NetworkCatalog({
        endpoints: () => this.servers,
        schemes: () => {
          const listed = this.host.networkSchemes?.() ?? [];
          return listed.filter((k) => k !== 'local');
        },
        volumes: (ep) => this.volumesFor(ep),
        volumeCatalog: (ep, vol) => this.catalogs.get(shareKeyForEndpoint(ep, vol)),
        volumeCatalogKey: (ep, vol) => {
          const key = shareKeyForEndpoint(ep, vol);
          return this.catalogs.has(key) ? key : undefined;
        },
      });
    }
    return this.networkCatalog;
  }

  private parseCwdNetwork() {
    return parseNetworkPath(typeof this.cwd === 'string' ? this.cwd : '', this.servers);
  }

  /** Volume catalog when the Network Browser cwd is inside a mounted share. */
  private activeCatalog(): Catalog {
    if (!isNetworkCatalog(this.vfs)) return this.vfs;
    const node = this.findNodeAnywhere(this.cwd);
    const key = node?.chrome?.catalogKey;
    if (key) {
      const cat = this.catalogs.get(key);
      if (cat) return cat;
    }
    const info = this.parseCwdNetwork();
    if (info.share && info.protocol && info.server) {
      const ep = matchNetworkServer(this.servers, info.protocol, info.neighborhood, info.server);
      if (ep) {
        const cat = this.catalogs.get(shareKeyForEndpoint(ep, info.share));
        if (cat) return cat;
      }
    }
    return this.vfs;
  }

  private caps(): CatalogCapabilities {
    return this.activeCatalog().capabilities();
  }

  private capsForNode(node?: VNode | null): CatalogCapabilities {
    const key = node?.chrome?.catalogKey;
    if (key) {
      const cat = this.catalogs.get(key);
      if (cat) return cat.capabilities();
    }
    return this.caps();
  }

  private catalogForNode(node?: VNode | null): Catalog {
    const key = node?.chrome?.catalogKey;
    if (key) {
      const cat = this.catalogs.get(key);
      if (cat) return cat;
    }
    return this.activeCatalog();
  }

  /**
   * Volume catalog + native ref when `node` is a Network Browser overlay of a
   * mounted share (or the share itself as a folder destination).
   */
  private overlayNative(node?: VNode | null): { cat: Catalog; ref: NodeRef } | null {
    const hit = overlayNativeOf(node);
    if (!hit) return null;
    const cat = this.catalogs.get(hit.catalogKey);
    if (!cat) return null;
    return { cat, ref: hit.nativeRef };
  }

  private async nativeFromNetworkPath(path: string): Promise<{ cat: Catalog; ref: NodeRef } | null> {
    const info = parseNetworkPath(path, this.servers);
    if (info.role !== 'share' || !info.share || !info.protocol || !info.server) return null;
    const ep = matchNetworkServer(this.servers, info.protocol, info.neighborhood, info.server);
    if (!ep) return null;
    const cat = this.catalogs.get(shareKeyForEndpoint(ep, info.share));
    if (!cat) return null;
    if (!info.volumePath) return { cat, ref: cat.rootId() };
    const n = await cat.resolvePath(info.volumePath);
    return n ? { cat, ref: nodeRef(n) } : null;
  }

  /** Map an overlay path/node to the mounted volume catalog. */
  private async resolveNative(ref: NodeRef, hint?: VNode | null): Promise<{ cat: Catalog; ref: NodeRef }> {
    const node = hint ?? this.findNodeAnywhere(ref) ?? (await this.vfs.get(ref));
    const fromNode = this.overlayNative(node);
    if (fromNode) return fromNode;
    if (isNetworkCatalog(this.vfs) && typeof ref === 'string') {
      const mapped = await this.nativeFromNetworkPath(ref);
      if (mapped) return mapped;
    }
    return { cat: this.vfs, ref };
  }

  /** Native vnode for zip / snapshot / expand (identity matches the volume catalog). */
  private async nativeNode(node: VNode): Promise<{ cat: Catalog; node: VNode }> {
    const handle = this.overlayNative(node);
    if (!handle) return { cat: this.vfs, node };
    const n = await handle.cat.get(handle.ref);
    return n ? { cat: handle.cat, node: n } : { cat: this.vfs, node };
  }

  private endpointForNetworkNode(node: VNode): RemoteEndpoint | undefined {
    const id = node.chrome?.endpointId;
    if (!id) return undefined;
    return this.servers.find((s) => s.id === id) ?? (this.remoteEndpoint?.id === id ? this.remoteEndpoint : undefined);
  }

  /** Walk Browse Network to `path` (`AFP/LToUDP Network/snow`). Empty = root. */
  private async showNetworkBrowser(path = ''): Promise<void> {
    const cat = this.ensureNetworkCatalog();
    this.attachCatalog(cat);
    this.source = 'remote';
    this.remoteOpen = false;
    this.locationMode = 'network';
    this.locationUri = '';
    this.networkPrefix = [];
    const parts = path.split('/').filter(Boolean);
    this.pathStack = [{ id: '', name: NETWORK_ROOT_NAME }];
    let cur = '';
    for (const name of parts) {
      cur = cur ? `${cur}/${name}` : name;
      this.pathStack.push({ id: cur, name });
    }
    this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
    this.clearSelection();
    this.renamingId = null;
    this.showProps = false;
    const info = parseNetworkPath(typeof this.cwd === 'string' ? this.cwd : '', this.servers);
    if ((info.role === 'server' || info.role === 'share') && info.protocol && info.server) {
      const ep = matchNetworkServer(this.servers, info.protocol, info.neighborhood, info.server);
      if (ep) this.adoptEndpoint(ep);
    } else if (info.role === 'root' || info.role === 'protocol' || info.role === 'neighborhood') {
      if (!this.loggedInEndpoints.has(this.remoteEndpoint?.id || '')) {
        this.remoteEndpoint = null;
      }
    }
    this.setStatus(path ? `${NETWORK_ROOT_NAME}:${parts.join(':')}` : NETWORK_ROOT_NAME);
    await this.reload();
    this.renderSidebar();
  }

  private async showServerSharesFolder(s: RemoteEndpoint): Promise<void> {
    const path = serverNetworkPath(s);
    this.adoptEndpoint(s);
    await this.showNetworkBrowser(path || '');
  }

  private async openNetworkShare(node: VNode): Promise<boolean> {
    const ep = this.endpointForNetworkNode(node);
    const name = node.name;
    if (!ep || !name) return false;
    this.locationMode = 'network';
    this.locationUri = '';
    return this.ensureVolumeAttached(ep, name);
  }

  /** Login / open a share from a Network Browser node. Returns true when the click is consumed. */
  private async activateNetworkNode(node: VNode): Promise<boolean> {
    const role = node.chrome?.networkRole;
    if (role === 'service') {
      this.selectOnly(nodeRef(node));
      this.showPropertiesPanel();
      return true;
    }
    if (role === 'share') {
      const ok = await this.openNetworkShare(node);
      return !ok;
    }
    if (role === 'server') {
      const ep = this.endpointForNetworkNode(node);
      if (!ep) return false;
      const ok = await this.ensureLoggedIn(ep);
      return !ok;
    }
    return false;
  }

  private attachCatalog(next: Catalog): void {
    if (this.vfs === next) return;
    this.vfsUnsub?.();
    this.vfs = next;
    this.vfsUnsub = next.subscribe((change) => this.onVfsChanged(change));
    this.expandedIds.clear();
    this.loadingIds.clear();
    this.folderLoadGen.clear();
    this.listChildCache.clear();
    this.columnChildren = [];
    this.columnLoading = false;
    this.columnLoadGen++;
    this.folderOpening = false;
    this.enumeratingFolderId = null;
    this.iconUrls.clear();
    this.abortAllListings();
    this.bumpIconLoadGen();
  }

  private dropRemoteCatalogs(nbp?: string): void {
    const prefix = nbp ? `${nbp}:` : null;
    const endpointKey = nbp ? `endpoint:${nbp}` : null;
    for (const key of [...this.catalogs.keys()]) {
      if (key === LOCAL_SHARE_KEY) continue;
      if (prefix) {
        if (key !== endpointKey && !key.startsWith(prefix)) continue;
      }
      const cat = this.catalogs.get(key);
      if (this.clipboard && this.clipboard.source === cat) this.clipboard.source = null;
      this.catalogs.delete(key);
      this.volumeUnsubs.get(key)?.();
      this.volumeUnsubs.delete(key);
    }
  }

  private catalogKeyForVolume(name: string): string {
    if (this.remoteEndpoint && isCatalogEndpoint(this.remoteEndpoint)) {
      return shareKeyForEndpoint(this.remoteEndpoint);
    }
    return `${this.remoteNbpName}:${name}`;
  }

  private mountCatalog(cat: Catalog, source: 'local' | 'remote', rootName: string): void {
    const key = source === 'local' ? LOCAL_SHARE_KEY : this.catalogKeyForVolume(rootName);
    this.catalogs.set(key, cat);
    this.attachCatalog(cat);
    this.source = source;
    this.cwd = cat.rootId();
    this.pathStack = [{ id: this.cwd, name: rootName }];
    this.clearSelection();
    this.renamingId = null;
    this.showProps = false;
  }

  /** Drop a remote mount (server CloseSession / disconnect attention). */
  unmountRemote(status?: string): void {
    this.dropRemoteCatalogs();
    this.knownVolumes.clear();
    this.loggedInEndpoints.clear();
    this.openedVolumeKeys.clear();
    this.remoteLoggedIn = false;
    this.remoteVolumes = [];
    this.remoteNbpName = '';
    this.remoteEndpoint = null;
    this.showLocalShare();
    if (status) this.setStatus(status);
    else if (this.isNoVolumeSelected()) this.setStatus(NO_VOLUME_HINT);
    void this.reload().then(() => {
      this.syncHistory();
      this.render();
    });
  }

  disconnectedCallback(): void {
    this.vfsUnsub?.();
    this.vfsUnsub = null;
    this.unsubTransfer?.();
    this.unsubTransfer = null;
    this.unsubLayout?.();
    this.unsubLayout = null;
    window.removeEventListener('pointerdown', this.onWinPointer, true);
    window.removeEventListener('pointermove', this.onColumnResizeMove);
    window.removeEventListener('pointerup', this.onColumnResizeUp);
    window.removeEventListener('pointercancel', this.onColumnResizeUp);
    if (this.transferIdleTimer) clearTimeout(this.transferIdleTimer);
    if (this.transferRaf) cancelAnimationFrame(this.transferRaf);
    if (this.vfsRefreshTimer) {
      clearTimeout(this.vfsRefreshTimer);
      this.vfsRefreshTimer = null;
    }
    this.abortAllListings();
    this.teardownIconObserver();
  }

  /** AFP / local mutations land here; debounce so fork writes don't thrash the UI. */
  private onVfsChanged(change: { parentIds: NodeRef[] }): void {
    if (this.ownVfsMutation > 0) return;
    for (const id of change.parentIds) this.pendingVfsParents.add(id);
    if (this.vfsRefreshTimer) clearTimeout(this.vfsRefreshTimer);
    this.vfsRefreshTimer = setTimeout(() => {
      this.vfsRefreshTimer = null;
      const parents = [...this.pendingVfsParents];
      this.pendingVfsParents.clear();
      if (!this.changeImpactsVisibleFolders(parents)) return;
      iconCache.clearDirectoryCache();
      this.iconUrls.clear();
      this.bumpIconLoadGen();
      void this.refreshAfterMutation();
    }, 150);
  }

  /** Run a Finder-initiated catalog write without treating its VFS echo as a remote change. */
  private async withOwnVfsMutation<T>(fn: () => Promise<T>): Promise<T> {
    this.ownVfsMutation++;
    try {
      return await fn();
    } finally {
      this.ownVfsMutation--;
    }
  }

  /** Drop a coalesced observer refresh; the caller already reloaded visible folders. */
  private discardPendingVfsRefresh(): void {
    if (this.vfsRefreshTimer) {
      clearTimeout(this.vfsRefreshTimer);
      this.vfsRefreshTimer = null;
    }
    this.pendingVfsParents.clear();
  }

  /** True when a mutation's parent is a folder whose children are currently shown. */
  private changeImpactsVisibleFolders(parentIds: NodeRef[]): boolean {
    if (parentIds.length === 0) return true;
    const visible = this.visibleFolderIds();
    return parentIds.some((id) => visible.has(id));
  }

  /** Folders whose children are painted in the current Finder view. */
  private visibleFolderIds(): Set<NodeRef> {
    const ids = new Set<NodeRef>();
    ids.add(this.cwd);
    if (this.view === 'column') {
      for (const p of this.pathStack) ids.add(p.id);
    }
    for (const id of this.expandedIds) ids.add(id);
    return ids;
  }

  /** Reload the listing only when `dest` is the open catalog and a parent is on screen. */
  private async refreshIfDestVisible(dest: Catalog, ...parentIds: NodeRef[]): Promise<void> {
    if (this.vfs !== dest) {
      if (isNetworkCatalog(this.vfs) && [...this.catalogs.values()].includes(dest)) {
        await this.refreshAfterMutation();
      }
      return;
    }
    if (!this.changeImpactsVisibleFolders(parentIds)) return;
    await this.refreshAfterMutation();
  }

  private async bootstrapFromLocation(): Promise<void> {
    await this.applyHistoryState(this.stateFromLocation());
    this.syncHistory(true);
    this.render();
  }

  /** Sidebar endpoint named by a restored `?share=` / `?vol=` URL. */
  private findNavEndpoint(share: string, vol: string): RemoteEndpoint | undefined {
    const shareKey = share.toLowerCase();
    const volKey = vol.toLowerCase();
    return this.servers.find((s) => {
      if (s.id.toLowerCase() === shareKey) return true;
      if ((s.title || '').toLowerCase() === shareKey) return true;
      if (s.role === 'volume' && (s.title || '').toLowerCase() === volKey) {
        const sub = (s.subtitle || '').toLowerCase();
        return !shareKey || sub === shareKey || s.id.toLowerCase() === shareKey;
      }
      return false;
    });
  }

  /**
   * Wait for open mounts (and the cached sidebar), then connect so a URL path
   * can resolve against a live catalog.
   */
  private async ensureRemoteForHistory(
    state: ReturnType<FinderWindow['historySnapshot']>,
  ): Promise<boolean> {
    if (this.remoteServerConnected(state.share)) return true;
    if (this.host.readyMounted) await this.host.readyMounted();
    if (this.host.cachedNetwork) await this.refreshSidebarEndpoints();
    if (this.remoteServerConnected(state.share)) return true;
    const ep = this.findNavEndpoint(state.share, state.vol);
    if (!ep) return false;
    return this.connectServerWithLogin(ep);
  }

  setStatus(msg: string, opts?: { busy?: boolean }): void {
    this.status = msg;
    this.statusBusy = opts?.busy ?? false;
    this.paintStatus();
  }

  private paintStatus(): void {
    const el = this.querySelector('.status');
    if (!el) return;
    el.classList.toggle('status--busy', this.statusBusy);
    el.innerHTML = this.statusBusy
      ? `<span class="status-spinner" aria-hidden="true"></span><span>${this.escape(this.status)}</span>`
      : this.escape(this.status);
  }

  private startTransfer(
    name: string,
    isDir: boolean,
    bytesTotal: number,
    finderInfo?: Uint8Array,
    parentId?: string,
    detail?: string,
  ): string {
    const queued = parentId == null && transferActivity.hasRunning();
    const id = transferActivity.start({
      name,
      kind: isDir ? 'folder' : 'file',
      bytesTotal,
      iconSrc: isDir ? undefined : TRANSFER_FILE_ICON,
      parentId,
      detail: queued ? 'Queued' : detail,
      queued,
    });
    if (!isDir && finderInfo && finderInfo.length >= 8) {
      const { type, creator } = readTypeCreator(finderInfo);
      void iconCache.getForTypeCreator(type, creator, name).then((urls) => {
        transferActivity.setIcon(id, urls.small);
      });
    }
    return id;
  }

  private trackImportItem(
    item: { name: string; isDir: boolean; bytesTotal: number },
    dest: Catalog = this.vfs,
    destParent?: NodeRef,
    overlayItem = destParent != null,
  ): ImportItemTrack & {
    onBytes: (n: number) => void;
    onDone: (err?: Error) => void;
  } {
    const id = this.startTransfer(item.name, item.isDir, item.bytesTotal);
    if (overlayItem && destParent != null) {
      transferActivity.setDest(id, dest, destParent, item.name, item.isDir ? 'folder' : 'file');
    }
    const queuedByPath = new Map<string, string>();
    const bind = (jobId: string): ImportItemTrack & {
      onBytes: (n: number) => void;
      onDone: (err?: Error) => void;
    } => ({
      onBytes: (n) => {
        throwIfAborted(transferActivity.signal(jobId));
        transferActivity.addBytes(jobId, n);
      },
      onDone: (err?: Error) => {
        if (!err) {
          void transferActivity.settle(jobId);
          return;
        }
        void transferActivity.settle(jobId, err);
        if (!isAbortError(err) && !transferActivity.isCancelled(jobId)) {
          transferActivity.failQueued(jobId, err.message);
        }
      },
      signal: transferActivity.signal(jobId),
      removePartial: async (parentId, name) => {
        try {
          const node = await dest.lookup(parentId, name);
          if (node && !node.isDir) await dest.remove(nodeRef(node));
        } catch {
          /* dest may already be gone */
        }
      },
      onWrite: (parentId, name) => {
        transferActivity.setWriteFile(jobId, dest, parentId, name);
      },
      onDir: (parentId, name, dirId, path) => {
        transferActivity.addDest(id, dest, parentId, name, 'folder');
        for (const [filePath, childId] of queuedByPath) {
          const slash = filePath.lastIndexOf('/');
          if (slash < 0 || filePath.slice(0, slash) !== path) continue;
          transferActivity.setDest(childId, dest, dirId, filePath.slice(slash + 1), 'file');
        }
      },
    });
    return {
      ...bind(id),
      runInCopySlot: (fn) => transferActivity.withCopySlot(id, fn),
      onStatus: (detail) => {
        transferActivity.setDetail(id, detail);
      },
      onExpandBegin: (bytesTotal, files) => {
        transferActivity.setBytes(id, 0, bytesTotal, 'Expanding');
        if (destParent != null) {
          transferActivity.clearDest(id);
          const tops = new Map<string, 'file' | 'folder'>();
          for (const f of files) {
            const slash = f.path.indexOf('/');
            const top = slash < 0 ? f.path : f.path.slice(0, slash);
            if (slash >= 0) tops.set(top, 'folder');
            else if (!tops.has(top)) tops.set(top, 'file');
          }
          for (const [name, kind] of tops) {
            if (kind === 'folder') transferActivity.addDest(id, dest, destParent, name, 'folder');
          }
        }
        const childIds = transferActivity.startMany(
          files.map((f) => ({
            name: f.path,
            kind: 'file' as const,
            bytesTotal: f.bytesTotal,
            iconSrc: TRANSFER_FILE_ICON,
            parentId: id,
            detail: 'Queued',
            queued: true,
          })),
        );
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          const childId = childIds[i]!;
          queuedByPath.set(f.path, childId);
          if (destParent != null && !f.path.includes('/')) {
            transferActivity.setDest(childId, dest, destParent, f.name, 'file');
          }
          if (!f.finderInfo || f.finderInfo.length < 8) continue;
          const { type, creator } = readTypeCreator(f.finderInfo);
          void iconCache.getForTypeCreator(type, creator, f.name).then((urls) => {
            transferActivity.setIcon(childId, urls.small);
          });
        }
      },
      onExpand: (sub) => {
        const childId = queuedByPath.get(sub.path);
        if (childId) {
          transferActivity.begin(childId, 'Expanding');
          return bind(childId);
        }
        const started = this.startTransfer(sub.name, false, sub.bytesTotal, sub.finderInfo, id, 'Expanding');
        return bind(started);
      },
    };
  }

  setNetworkScanning(busy: boolean): void {
    this.networkScanning = busy ? '*' : null;
    this.renderSidebar();
  }

  setServers(list: RemoteEndpoint[]): void {
    this.servers = list;
    if (
      this.remoteLoggedIn &&
      this.remoteEndpoint &&
      !list.some((s) => s.id === this.remoteEndpoint!.id)
    ) {
      this.servers = [this.remoteEndpoint, ...list];
    }
    this.networkCatalog?.notify();
    this.renderSidebar();
  }

  /**
   * Connect to a server from the Advanced menu or a client URI: login, list
   * volumes in the sidebar, and optionally open a share.
   */
  async openRemote(
    ep: RemoteEndpoint,
    opts?: OpenRemoteOptions,
  ): Promise<{ ok: boolean; volumes: string[] }> {
    const existing = this.servers.find((s) => s.id === ep.id);
    const target = existing ?? ep;
    if (!existing) {
      this.servers = [ep, ...this.servers];
      this.renderSidebar();
    }
    this.applyLocationOpts(opts);
    const ok = await this.connectServerWithLogin(target, opts?.volume, opts);
    if (!ok) return { ok: false, volumes: this.volumesFor(target) };
    if (opts?.folderPath && this.remoteOpen) {
      await this.enterFolderPath(opts.folderPath);
    }
    this.closeSidebar();
    if (this.remoteOpen) {
      await this.reload();
      this.syncHistory();
    }
    this.render();
    return { ok: true, volumes: this.volumesFor(this.remoteEndpoint ?? target) };
  }

  connectedCallback(): void {
    this.ensureShellEvents();
    if (this.vfs && this.host) this.render();
  }

  private ensureShellEvents(): void {
    if (this.eventsBound) return;
    this.eventsBound = true;
    this.addEventListener('click', (e) => void this.onClick(e));
    this.addEventListener('pointerdown', (e) => this.onColumnResizeDown(e));
    this.addEventListener('dblclick', (e) => void this.onDblClick(e));
    this.addEventListener('contextmenu', (e) => void this.onContextMenu(e));
    this.addEventListener('dragstart', (e) => this.onDragStart(e));
    this.addEventListener('dragend', () => this.onDragEnd());
    this.addEventListener('dragenter', (e) => this.onDragEnter(e));
    this.addEventListener('dragover', (e) => this.onDragOver(e));
    this.addEventListener('dragleave', (e) => this.onDragLeave(e));
    this.addEventListener('drop', (e) => void this.onDrop(e));
    window.addEventListener('popstate', (e) => void this.onPopState(e));
    window.addEventListener('keydown', (e) => void this.onKeyDown(e));
    window.addEventListener('pointerdown', this.onWinPointer, true);
    this.unsubTransfer = transferActivity.subscribe(() => {
      if (this.transferRaf) return;
      this.transferRaf = requestAnimationFrame(() => {
        this.transferRaf = 0;
        this.syncTransferButton();
        this.syncWriteOverlays();
      });
    });
    this.unsubLayout = onLayoutModeChange(() => this.applyCompactView());
    this.ensureRenameBlur();
  }

  private pathNamesForUrl(): string[] {
    return this.pathStack.slice(1).map((p) => p.name);
  }

  private buildLocationUrl(state: {
    view: ViewMode;
    source: 'local' | 'remote';
    share: string;
    vol: string;
    path: string[];
  }): string {
    const params = new URLSearchParams();
    if (state.view !== 'icon') params.set('view', state.view);
    if (state.source === 'remote' && state.share && state.vol) {
      params.set('share', state.share);
      params.set('vol', state.vol);
    }
    if (state.path.length) params.set('path', state.path.join('/'));
    const q = params.toString();
    return q ? `${location.pathname}?${q}` : location.pathname;
  }

  private stateFromLocation(): {
    view: ViewMode;
    source: 'local' | 'remote';
    share: string;
    vol: string;
    path: string[];
  } {
    const params = new URLSearchParams(location.search);
    const viewParam = params.get('view');
    const view: ViewMode =
      viewParam === 'list' || viewParam === 'column' || viewParam === 'icon'
        ? viewParam
        : loadPrefs().defaultView;
    const share = params.get('share') ?? '';
    const vol = params.get('vol') ?? '';
    const pathRaw = params.get('path') ?? '';
    const path = pathRaw
      ? pathRaw.split('/').map((s) => decodeURIComponent(s)).filter(Boolean)
      : [];
    return {
      view,
      source: share ? 'remote' : 'local',
      share,
      vol,
      path,
    };
  }

  private historySnapshot(): {
    view: ViewMode;
    source: 'local' | 'remote';
    share: string;
    vol: string;
    path: string[];
  } {
    const metaId = this.remoteEndpoint?.id ?? '';
    if (isNetworkCatalog(this.vfs)) {
      return {
        view: this.view,
        source: 'remote',
        share: NETWORK_SHARE_KEY,
        vol: NETWORK_ROOT_NAME,
        path: this.pathNamesForUrl(),
      };
    }
    return {
      view: this.view,
      source: this.source,
      share: this.source === 'remote' ? this.remoteNbpName || metaId : '',
      vol: this.source === 'remote' ? this.pathStack[0]?.name || '' : '',
      path: this.pathNamesForUrl(),
    };
  }

  private syncHistory(replace = false): void {
    if (this.historyQuiet) return;
    const state = this.historySnapshot();
    const url = this.buildLocationUrl(state);
    const current = `${location.pathname}${location.search}`;
    if (!replace && url === current) return;
    if (replace) history.replaceState(state, '', url);
    else history.pushState(state, '', url);
    this.recordNav(state, replace);
  }

  private copyNavState(
    state: ReturnType<FinderWindow['historySnapshot']>,
  ): ReturnType<FinderWindow['historySnapshot']> {
    return { ...state, path: [...state.path] };
  }

  private sameNavState(
    a: ReturnType<FinderWindow['historySnapshot']>,
    b: ReturnType<FinderWindow['historySnapshot']>,
  ): boolean {
    return (
      a.view === b.view &&
      a.source === b.source &&
      a.share === b.share &&
      a.vol === b.vol &&
      a.path.join('/') === b.path.join('/')
    );
  }

  private recordNav(
    state: ReturnType<FinderWindow['historySnapshot']>,
    replace: boolean,
  ): void {
    if (this.navLock) return;
    const snap = this.copyNavState(state);
    if (replace) {
      if (this.navIndex < 0) {
        this.navStack = [snap];
        this.navIndex = 0;
      } else {
        this.navStack[this.navIndex] = snap;
      }
      return;
    }
    const cur = this.navStack[this.navIndex];
    if (cur && this.sameNavState(cur, snap)) return;
    this.navStack = this.navStack.slice(0, this.navIndex + 1);
    this.navStack.push(snap);
    this.navIndex = this.navStack.length - 1;
  }

  private async onPopState(e: PopStateEvent): Promise<void> {
    if (!this.vfs) return;
    const state =
      e.state && typeof e.state === 'object' && 'view' in e.state
        ? (e.state as ReturnType<FinderWindow['historySnapshot']>)
        : this.stateFromLocation();
    await this.applyHistoryState(state);
    const idx = this.navStack.findIndex((s) => this.sameNavState(s, state));
    if (idx >= 0) this.navIndex = idx;
    else this.recordNav(state, false);
    this.render();
  }

  private async applyHistoryState(
    state: ReturnType<FinderWindow['historySnapshot']>,
  ): Promise<void> {
    this.historyQuiet = true;
    let bounceToLocal = false;
    try {
      this.view = state.view;
      this.clearSelection();
      if (state.source === 'remote') {
        if (state.share === NETWORK_SHARE_KEY) {
          if (!this.networkBrowserEnabled()) {
            bounceToLocal = true;
            this.bounceRemoteNavigation('Network Browser is unavailable until the client is enabled.');
            await this.reload();
            return;
          }
          await this.showNetworkBrowser(state.path.join('/'));
          return;
        }
        const target = state.vol ? `${state.share}:${state.vol}` : state.share || 'remote share';
        if (!state.share || !state.vol) {
          bounceToLocal = true;
          this.bounceRemoteNavigation(
            'Cannot navigate to that server — the URL must include both server and volume name.',
          );
          await this.reload();
          return;
        }
        if (!this.host.isConnected() || !(await this.ensureRemoteForHistory(state))) {
          bounceToLocal = true;
          this.bounceRemoteNavigation(
            `Cannot navigate to “${target}” — that server isn’t connected.`,
          );
          await this.reload();
          return;
        }
        const volName = this.canonicalVolumeName(state.vol);
        if (!volName) {
          bounceToLocal = true;
          this.bounceRemoteNavigation(
            `Cannot navigate to “${target}” — volume “${state.vol}” is not on that server.`,
          );
          await this.reload();
          return;
        }
        try {
          await this.mountRemoteVolume(volName);
          this.pathStack = await this.resolvePathNames(state.path, volName);
          this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
          await this.reload();
        } catch (err) {
          bounceToLocal = true;
          const msg = err instanceof Error ? err.message : String(err);
          this.bounceRemoteNavigation(`Cannot navigate to “${target}”: ${msg}`);
          await this.reload();
        }
        return;
      }
      this.showLocalShare();
      this.pathStack = await this.resolvePathNames(state.path, this.localShareTitle());
      this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
      await this.reload();
    } finally {
      this.historyQuiet = false;
      if (bounceToLocal) this.syncHistory(true);
    }
  }

  /** True when this Finder session is already logged in to the named AFP server. */
  private remoteServerConnected(share: string): boolean {
    if (!this.remoteLoggedIn || !share) return false;
    const id = this.remoteNbpName || this.remoteEndpoint?.id || '';
    return id.toLowerCase() === share.toLowerCase();
  }

  private canonicalVolumeName(vol: string): string | null {
    const lower = vol.toLowerCase();
    return this.remoteVolumes.find((v) => v.toLowerCase() === lower) ?? null;
  }

  private bounceRemoteNavigation(message: string): void {
    log.warn(message, 'finder');
    this.host.showAlert('Cannot navigate to that server', message);
    this.setStatus(message);
    this.showLocalShare();
  }

  private isNoVolumeSelected(): boolean {
    return this.vfs instanceof EmptyCatalog;
  }

  private emptyPaneMessage(): string {
    if (isNetworkCatalog(this.vfs)) {
      const info = this.parseCwdNetwork();
      if (info.role === 'server') return 'No shares listed — open this folder to sign in.';
      if (info.role === 'neighborhood') return 'No servers in this network.';
      if (info.role === 'protocol') return 'No networks found.';
      return 'Open a protocol to browse the network.';
    }
    if (this.isNoVolumeSelected() || !this.hasLocalShare()) return NO_VOLUME_HINT;
    if (this.hasTransport()) return 'Drop files or folders here, or browse the LocalTalk network.';
    return NO_VOLUME_HINT;
  }

  /** Clear the file pane — no volume selected in the sidebar. */
  private showNoVolumeSelected(): void {
    this.abortAllListings();
    this.attachCatalog(new EmptyCatalog());
    this.source = 'local';
    this.remoteOpen = false;
    this.cwd = this.vfs.rootId();
    this.pathStack = [{ id: this.cwd, name: '' }];
    this.clearSelection();
    this.renamingId = null;
    this.showProps = false;
    this.nodes = [];
    this.columnChildren = [];
    this.folderOpening = false;
    this.columnLoading = false;
  }

  private showLocalShare(): void {
    const local = this.localVfs ?? this.host.localCatalog();
    if (!local) {
      this.showNoVolumeSelected();
      return;
    }
    this.mountCatalog(local, 'local', this.localShareTitle());
    this.remoteOpen = false;
    this.locationMode = 'local';
    this.locationUri = '';
    this.networkPrefix = [];
  }

  private resetToLocalShare(): void {
    this.showLocalShare();
    this.remoteLoggedIn = false;
    this.remoteVolumes = [];
    this.remoteEndpoint = null;
    this.remoteNbpName = '';
  }

  private async resolvePathNames(names: string[], rootName?: string): Promise<{ id: NodeRef; name: string }[]> {
    const rootId = this.vfs.rootId();
    const stack: { id: NodeRef; name: string }[] = [
      { id: rootId, name: rootName ?? this.pathStack[0]?.name ?? this.localShareTitle() },
    ];
    const joined = names.join('/');
    if (joined) {
      const resolved = await this.vfs.resolvePath(joined);
      if (resolved?.isDir) {
        const walk: { id: NodeRef; name: string }[] = [];
        let cur: VNode | undefined = resolved;
        while (cur && nodeRef(cur) !== rootId) {
          walk.unshift({ id: nodeRef(cur), name: cur.name });
          const pref = parentRef(cur);
          if (pref === nodeRef(cur)) break;
          cur = this.findNodeAnywhere(pref) ?? (await this.vfs.get(pref));
        }
        return [...stack, ...walk];
      }
    }
    let parent = rootId;
    for (const name of names) {
      const node = await this.vfs.lookup(parent, name);
      if (!node?.isDir) break;
      stack.push({ id: nodeRef(node), name: node.name });
      parent = nodeRef(node);
    }
    return stack;
  }

  private abortAllExpandListings(): void {
    for (const ac of this.expandListAbort.values()) ac.abort();
    this.expandListAbort.clear();
  }

  private abortAllListings(): void {
    this.navListAbort?.abort();
    this.navListAbort = null;
    this.iconAbort?.abort();
    this.iconAbort = null;
    this.abortAllExpandListings();
    this.enumeratingFolderId = null;
    this.folderOpening = false;
  }

  /** Drop queued desktop-icon AFP calls from the previous folder / icon generation. */
  private bumpIconLoadGen(): AbortSignal {
    this.iconAbort?.abort();
    const ac = new AbortController();
    this.iconAbort = ac;
    this.iconLoadGen++;
    this.iconQueue.reset();
    this.iconPrefetchItems.clear();
    this.iconIntersectingEls.clear();
    return ac.signal;
  }

  /** Abort the previous folder listing (and any list-view expands) and start a new one. */
  private beginNavListing(): AbortSignal {
    this.navListAbort?.abort();
    this.abortAllExpandListings();
    const ac = new AbortController();
    this.navListAbort = ac;
    return ac.signal;
  }

  private beginExpandListing(id: NodeRef): AbortSignal {
    this.expandListAbort.get(id)?.abort();
    const ac = new AbortController();
    this.expandListAbort.set(id, ac);
    return ac.signal;
  }

  private abortExpandListing(id: NodeRef): void {
    this.expandListAbort.get(id)?.abort();
    this.expandListAbort.delete(id);
  }

  private async reload(): Promise<void> {
    if (!this.vfs) return;
    this.discardPendingVfsRefresh();
    this.bumpIconLoadGen();
    const listedId = this.cwd;
    const signal = this.beginNavListing();
    this.enumeratingFolderId = listedId;
    this.folderOpening = this.view !== 'column';
    this.nodes = [];
    this.renderPath();
    this.renderContent();
    try {
      const kids = await this.streamChildren(
        listedId,
        (partial) => {
          if (signal.aborted || this.cwd !== listedId) return;
          this.folderOpening = false;
          this.nodes = partial;
          this.listChildCache.set(listedId, partial);
          this.renderContent();
        },
        signal,
      );
      if (signal.aborted || this.cwd !== listedId) return;
      this.nodes = kids;
      this.listChildCache.set(listedId, kids);
      for (const id of [...this.expandedIds]) {
        if (signal.aborted) return;
        this.listChildCache.set(
          id,
          await this.streamChildren(
            id,
            (partial) => {
              if (signal.aborted || this.cwd !== listedId) return;
              this.listChildCache.set(id, partial);
              if (this.view === 'list') this.renderContent();
            },
            signal,
          ),
        );
      }
      if (signal.aborted || this.cwd !== listedId) return;
      await this.refreshColumns(listedId, signal);
    } catch (err) {
      if (isListingCancelled(err)) return;
      throw err;
    } finally {
      if (!signal.aborted && this.enumeratingFolderId === listedId) {
        this.enumeratingFolderId = null;
        this.folderOpening = false;
        this.renderPath();
        this.renderContent();
      }
    }
  }

  /**
   * List a folder, painting `onUpdate` after each AFP enumerate page.
   * Local catalogs resolve in one shot (onUpdate may still fire once).
   */
  private async streamChildren(
    parentId: NodeRef,
    onUpdate?: (kids: VNode[]) => void,
    signal?: AbortSignal,
  ): Promise<VNode[]> {
    try {
      const ready = await this.prepareNetworkListing(parentId, signal);
      if (signal?.aborted) return [];
      if (!ready) throw new NetworkAuthCancelled();
      return this.sortNodes(
        await this.vfs.children(
          parentId,
          (raw) => {
            onUpdate?.(this.sortNodes(raw));
          },
          signal,
        ),
      );
    } catch (err) {
      if (isAbortError(err)) return [];
      throw err;
    }
  }

  private async refreshColumns(alreadyListedId?: NodeRef, signal?: AbortSignal): Promise<void> {
    this.columnChildren = [];
    for (const step of this.pathStack) {
      if (signal?.aborted) return;
      if (step.id === alreadyListedId) {
        this.columnChildren.push(this.listChildCache.get(step.id) ?? this.nodes);
        continue;
      }
      this.columnChildren.push(await this.streamChildren(step.id, undefined, signal));
    }
  }

  private sortNodes(nodes: VNode[]): VNode[] {
    const list = nodes.filter((n) => this.isVisibleInFinder(n.name, n, n.finderInfo));
    const dir = this.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const aFold = a.isDir || isNetworkContainer(a);
      const bFold = b.isDir || isNetworkContainer(b);
      if (aFold !== bFold) return aFold ? -1 : 1;
      let cmp = 0;
      switch (this.sortKey) {
        case 'modified':
          cmp = a.modDate - b.modDate || a.name.localeCompare(b.name);
          break;
        case 'size':
          cmp =
            (a.isDir ? 0 : nodeByteSize(a)) - (b.isDir ? 0 : nodeByteSize(b)) ||
            a.name.localeCompare(b.name);
          break;
        default:
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
      return cmp * dir;
    });
    return list;
  }

  /**
   * Finder listing visibility. Hidden items remain in VFS and are still
   * included by directory copy/download (those use vfs.children directly).
   */
  private isVisibleInFinder(name: string, node?: VNode, finderInfo?: Uint8Array): boolean {
    if (this.showHiddenFiles) return true;
    if (isCustomFolderIconName(name)) return false;
    const hide = this.capsForNode(node).hideAttribute;
    if (hide && node?.attrs?.[hide]) return false;
    if (this.capsForNode(node).finderInfo && finderInfo && isFinderInvisible(finderInfo)) return false;
    return true;
  }

  private currentItems(): ListItem[] {
    const items = this.mergeWritingItems(this.cwd, this.nodes.map((n) => this.listItemFromNode(n)));
    if (this.folderOpening && this.nodes.length === 0) {
      return items.length ? [...items, this.listingPlaceholderItem()] : [this.listingPlaceholderItem()];
    }
    return items;
  }

  private itemIsNavigable(it: ListItem): boolean {
    return it.isDir || isNetworkNavigable(it.node);
  }

  private itemIsOpenable(it: ListItem): boolean {
    return it.isDir || isNetworkOpenable(it.node);
  }

  private listItemFromNode(n: VNode): ListItem {
    const item: ListItem = {
      key: refKey(nodeRef(n)),
      name: n.name,
      isDir: n.isDir,
      size: nodeByteSize(n, this.capsForNode(n).resourceFork),
      mod: unixDate(n.modDate),
      node: n,
      finderInfo: n.finderInfo,
    };
    const w = transferActivity
      .writesIn(this.vfs, parentRef(n))
      .find((x) => x.name.toLowerCase() === n.name.toLowerCase());
    if (w) item.writing = w;
    return item;
  }

  private mergeWritingItems(parentId: NodeRef, items: ListItem[]): ListItem[] {
    const writes = transferActivity.writesIn(this.vfs, parentId);
    if (!writes.length) return items;
    const byName = new Map<string, ListItem>();
    for (const it of items) {
      if (it.placeholder) continue;
      byName.set(it.name.toLowerCase(), it);
    }
    const extras: ListItem[] = [];
    for (const w of writes) {
      const hit = byName.get(w.name.toLowerCase());
      if (hit) {
        hit.writing = w;
        continue;
      }
      extras.push({
        key: `write:${w.jobId}`,
        name: w.name,
        isDir: w.kind === 'folder',
        size: 0,
        mod: new Date(0),
        node: null,
        writing: w,
      });
    }
    if (!extras.length) return items;
    return this.sortListItems([...items, ...extras]);
  }

  private sortListItems(items: ListItem[]): ListItem[] {
    const list = items.filter((it) => !it.placeholder);
    const placeholders = items.filter((it) => it.placeholder);
    const dir = this.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const aFold = a.isDir || isNetworkContainer(a.node);
      const bFold = b.isDir || isNetworkContainer(b.node);
      if (aFold !== bFold) return aFold ? -1 : 1;
      let cmp = 0;
      switch (this.sortKey) {
        case 'modified':
          cmp = a.mod.getTime() - b.mod.getTime() || a.name.localeCompare(b.name);
          break;
        case 'size':
          cmp = (a.isDir ? 0 : a.size) - (b.isDir ? 0 : b.size) || a.name.localeCompare(b.name);
          break;
        default:
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
      return cmp * dir;
    });
    return [...list, ...placeholders];
  }

  private listingPlaceholderItem(): ListItem {
    return {
      key: LISTING_PLACEHOLDER_KEY,
      name: 'Loading…',
      isDir: false,
      size: 0,
      mod: new Date(0),
      node: null,
      placeholder: true,
    };
  }

  private isFolderEnumerating(id: NodeRef): boolean {
    return this.enumeratingFolderId === id || this.loadingIds.has(id);
  }

  private selectedNode(): VNode | null {
    if (this.selectedId == null) return null;
    return this.findNodeAnywhere(this.selectedId);
  }

  /** Number of items in the current multi-selection (0, 1, or many). */
  selectionCount(): number {
    return this.selectedIds.size;
  }

  /** Resolved VNodes for every selected id (skips ids that can't be resolved, e.g. stale). */
  private selectedNodes(): VNode[] {
    const out: VNode[] = [];
    for (const id of this.selectedIds) {
      const n = this.findNodeAnywhere(id);
      if (n) out.push(n);
    }
    return out;
  }

  private clearSelection(): void {
    this.selectedId = null;
    this.selectedIds.clear();
    this.selectionAnchorId = null;
  }

  private selectOnly(id: NodeRef | null): void {
    if (id == null) {
      this.clearSelection();
      return;
    }
    this.selectedId = id;
    this.selectedIds = new Set([id]);
    this.selectionAnchorId = id;
  }

  /** All ids in DOM order among `[data-id]` elements under `scope` (used for shift-range select). */
  private orderedIdsInScope(scope: Element): NodeRef[] {
    const out: NodeRef[] = [];
    scope.querySelectorAll('[data-id]').forEach((el) => {
      const id = dataRef(el);
      if (id != null) out.push(id);
    });
    return out;
  }

  /** Apply a ⌘/Ctrl-click (toggle) or Shift-click (range) selection change within `scope`. */
  private applyMultiSelectClick(id: NodeRef, scope: Element, opts: { mod: boolean; range: boolean }): void {
    if (opts.range) {
      const anchor = this.selectionAnchorId ?? this.selectedId ?? id;
      const ids = this.orderedIdsInScope(scope);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        this.selectedIds = new Set(ids.slice(lo, hi + 1));
      } else {
        this.selectedIds = new Set([id]);
      }
      this.selectedId = id;
    } else {
      if (this.selectedIds.has(id)) {
        this.selectedIds.delete(id);
        const remaining = [...this.selectedIds];
        this.selectedId = remaining.length ? remaining[remaining.length - 1]! : null;
      } else {
        this.selectedIds.add(id);
        this.selectedId = id;
      }
      this.selectionAnchorId = id;
    }
    this.paintMultiSelection(scope);
  }

  /** Repaint selection highlighting within `scope` after a multi-select click, without a full re-render. */
  private paintMultiSelection(scope: Element): void {
    const keys = new Set(Array.from(this.selectedIds, refKey));
    scope.querySelectorAll('[data-id]').forEach((el) => {
      const k = el.getAttribute('data-id');
      el.classList.toggle('selected', !!k && keys.has(k));
    });
    this.syncClipboardButtons();
    this.syncResourceExplorer();
    if (this.showProps) this.refreshPropsPanel();
  }

  /** True only when every selected item is an expandable archive (and at least one is selected). */
  private allSelectedExpandable(): boolean {
    const nodes = this.selectedNodes();
    return nodes.length > 0 && nodes.every((n) => this.isExpandableArchive(n));
  }

  /** Is `key` (a ListItem/NodeRef key) part of the current selection — single or multi. */
  private isKeySelected(key: string): boolean {
    if (this.selectedIds.size > 1) {
      for (const id of this.selectedIds) {
        if (refKey(id) === key) return true;
      }
      return false;
    }
    return this.selectedId != null && key === refKey(this.selectedId);
  }

  private findNodeAnywhere(id: NodeRef): VNode | null {
    const direct = this.nodes.find((n) => nodeRef(n) === id);
    if (direct) return direct;
    for (const kids of this.listChildCache.values()) {
      const n = kids.find((x) => nodeRef(x) === id);
      if (n) return n;
    }
    return this.findInColumns(id) ?? null;
  }

  private render(): void {
    if (!this.host) return;
    this.innerHTML = `
      <div class="finder-chrome">
      <div class="titlebar">
        <div class="brand">Finder</div>
        <span class="node-label">${this.escape(this.host.nodeLabel())}</span>
      </div>
      <div class="toolbar">
        ${
          this.hasTransport()
            ? `<button type="button" class="btn primary" data-act="connect" aria-label="${this.host.isConnected() ? 'Disconnect' : 'Connect TashTalk'}" title="${this.host.isConnected() ? 'Disconnect' : 'Connect TashTalk'}">
          <span class="connect-icon">${uiIcons.usb}</span>
          <span class="connect-label">${this.host.isConnected() ? 'Disconnect' : 'Connect TashTalk'}</span>
        </button>`
            : ''
        }
        <button type="button" class="btn icon-btn" data-act="import" aria-label="Upload" title="Upload">${uiIcons.import}</button>
        <button type="button" class="btn transfer-btn" data-act="transfers" hidden aria-label="File transfers" title="File transfers"></button>
        <button type="button" class="btn icon-btn" data-act="mkdir" aria-label="New Folder" title="New Folder">${uiIcons.mkdir}</button>
        <button type="button" class="btn icon-btn toolbar-wide" data-act="cut" aria-label="Cut" title="Cut" ${this.selectedId == null ? 'disabled' : ''}>${uiIcons.cut}</button>
        <button type="button" class="btn icon-btn toolbar-wide" data-act="copy" aria-label="Copy" title="Copy" ${this.selectedId == null ? 'disabled' : ''}>${uiIcons.copy}</button>
        <button type="button" class="btn icon-btn toolbar-wide" data-act="paste" aria-label="Paste" title="Paste" ${this.clipboard ? '' : 'disabled'}>${uiIcons.paste}</button>
        <button type="button" class="btn icon-btn toolbar-wide" data-act="delete" aria-label="Delete" title="Delete" ${this.selectedId == null ? 'disabled' : ''}>${uiIcons.delete}</button>
        <button type="button" class="btn icon-btn ${this.showProps ? 'active' : ''}" data-act="props" aria-label="Get Info" title="Get Info" aria-pressed="${this.showProps}" ${this.selectedId == null ? 'disabled' : ''}>${uiIcons.props}</button>
        <button type="button" class="btn icon-btn" data-act="download" aria-label="Download Zip" title="Download Zip">${uiIcons.downloadZip}</button>
        <label class="sort-wrap toolbar-wide">
          <span>Sort</span>
          <select data-sort aria-label="Sort">
            <option value="name" ${this.sortKey === 'name' ? 'selected' : ''}>Name</option>
            <option value="modified" ${this.sortKey === 'modified' ? 'selected' : ''}>Date Modified</option>
            <option value="size" ${this.sortKey === 'size' ? 'selected' : ''}>Size</option>
          </select>
        </label>
        <div class="view-toggle" role="group" aria-label="View">
          <button type="button" data-view="icon" class="view-icon ${this.view === 'icon' ? 'active' : ''}" aria-label="Icons" title="Icons" aria-pressed="${this.view === 'icon'}">${uiIcons.viewIcon}</button>
          <button type="button" data-view="list" class="${this.view === 'list' ? 'active' : ''}" aria-label="List" title="List" aria-pressed="${this.view === 'list'}">${uiIcons.viewList}</button>
          <button type="button" data-view="column" class="${this.view === 'column' ? 'active' : ''}" aria-label="Columns" title="Columns" aria-pressed="${this.view === 'column'}">${uiIcons.viewColumn}</button>
        </div>
        <button type="button" class="btn icon-btn toolbar-compact-only" data-act="actions" aria-label="Actions" title="Actions">${uiIcons.more}</button>
        <div class="spacer"></div>
        <button type="button" class="btn icon-btn titlebar-zoom" data-act="zoom" aria-label="${this.classList.contains('is-maximized') ? 'Restore' : 'Maximize'}" title="${this.classList.contains('is-maximized') ? 'Restore' : 'Maximize'}">${this.classList.contains('is-maximized') ? uiIcons.restore : uiIcons.maximize}</button>
        <input type="file" multiple hidden data-import-files aria-label="Import files" />
      </div>
      </div>
      <div class="body">
        <div class="sidebar-backdrop" data-act="close-sidebar"></div>
        <aside class="sidebar"></aside>
        <section class="main">
          <div class="pathbar"></div>
          <div class="file-plane">
            <div class="content" tabindex="0"></div>
          </div>
        </section>
      </div>
      <div class="status${this.statusBusy ? ' status--busy' : ''}">${
        this.statusBusy
          ? `<span class="status-spinner" aria-hidden="true"></span><span>${this.escape(this.status)}</span>`
          : this.escape(this.status)
      }</div>
      <div class="ctx-root"></div>
      <div class="callout-root"></div>
      <div class="quicklook-root"></div>
      <div class="drag-portal" aria-hidden="true"></div>
    `;
    this.classList.toggle('sidebar-open', this.sidebarOpen);
    this.renderSidebar();
    this.renderPath();
    this.renderContent();
    this.renderContextMenu();
    this.renderCallouts();
    this.renderPreview();
    this.bindToolbarExtras();
    this.syncTransferButton();
    enableWindowResize(this, { minWidth: 560, minHeight: 360 });
    this.ensureFinderLayout();
  }

  private ensureFinderLayout(): void {
    enableWindowMove(this, '.finder-chrome', { raise: false });
    this.style.zIndex = '';
    if (this.finderLayoutReady) return;
    this.finderLayoutReady = true;
    onWindowGeometryChange(this, () => this.persistFinderLayout());
    this.restoreFinderLayout();
  }

  private persistFinderLayout(): void {
    if (isCompactUi()) return;
    persistWindow('finder', this);
  }

  private restoreFinderLayout(): void {
    if (isCompactUi()) {
      this.style.left = '';
      this.style.top = '';
      this.style.width = '';
      this.style.height = '';
      this.style.zIndex = '';
      this.classList.remove('is-maximized');
      return;
    }
    restoreWindow('finder', this, defaultFinderFrame);
  }

  private toggleMaximized(): void {
    if (isCompactUi()) return;
    if (this.classList.contains('is-maximized')) {
      const saved = loadWindowLayouts().finder ?? defaultFinderFrame();
      applyWindowFrame(this, { ...saved, maximized: false });
      persistWindow('finder', this);
      this.syncZoomButton();
      return;
    }
    persistWindow('finder', this);
    this.classList.add('is-maximized');
    persistWindow('finder', this);
    this.syncZoomButton();
  }

  private syncZoomButton(): void {
    const btn = this.querySelector('[data-act="zoom"]') as HTMLButtonElement | null;
    if (!btn) return;
    const max = this.classList.contains('is-maximized');
    btn.setAttribute('aria-label', max ? 'Restore' : 'Maximize');
    btn.title = max ? 'Restore' : 'Maximize';
    btn.innerHTML = max ? uiIcons.restore : uiIcons.maximize;
  }

  private selectionNodes(): VNode[] {
    const ids = this.selectedIds.size > 1 ? [...this.selectedIds] : this.selectedId != null ? [this.selectedId] : [];
    const nodes: VNode[] = [];
    for (const id of ids) {
      const n = this.findNodeAnywhere(id);
      if (n) nodes.push(n);
    }
    return nodes;
  }

  private networkListingLocked(): boolean {
    if (!isNetworkCatalog(this.vfs)) return false;
    const info = this.parseCwdNetwork();
    return !info.share;
  }

  private syncClipboardButtons(): void {
    const hasSel = this.selectedId != null;
    const nodes = this.selectionNodes();
    const canMutate = hasSel && !this.networkListingLocked() && selectionAllowsMutate(nodes);
    const canZip = hasSel && selectionAllowsZip(nodes);
    const cut = this.querySelector('[data-act="cut"]') as HTMLButtonElement | null;
    const copy = this.querySelector('[data-act="copy"]') as HTMLButtonElement | null;
    const paste = this.querySelector('[data-act="paste"]') as HTMLButtonElement | null;
    const del = this.querySelector('[data-act="delete"]') as HTMLButtonElement | null;
    const props = this.querySelector('[data-act="props"]') as HTMLButtonElement | null;
    const mkdir = this.querySelector('[data-act="mkdir"]') as HTMLButtonElement | null;
    const download = this.querySelector('[data-act="download"]') as HTMLButtonElement | null;
    if (cut) cut.disabled = !canMutate;
    if (copy) copy.disabled = !canMutate;
    if (paste) paste.disabled = !this.clipboard || this.networkListingLocked();
    if (del) del.disabled = !canMutate;
    if (props) props.disabled = !hasSel;
    if (mkdir) mkdir.disabled = this.caps().readOnly || this.networkListingLocked();
    if (download) download.disabled = hasSel ? !canZip && this.networkListingLocked() : this.networkListingLocked();
  }

  private syncPropsButton(): void {
    const btn = this.querySelector('[data-act="props"]') as HTMLButtonElement | null;
    if (!btn) return;
    btn.classList.toggle('active', this.showProps);
    btn.setAttribute('aria-pressed', String(this.showProps));
    btn.disabled = this.selectedId == null;
  }

  private bindToolbarExtras(): void {
    const sel = this.querySelector('[data-sort]') as HTMLSelectElement | null;
    sel?.addEventListener('change', () => {
      this.sortKey = (sel.value as SortKey) || 'name';
      this.sortDir = 'asc';
      void this.reload().then(() => this.renderContent());
    });
    const importInput = this.querySelector('[data-import-files]') as HTMLInputElement | null;
    importInput?.addEventListener('change', () => {
      if (!importInput.files?.length) return;
      void this.importPickedFiles(importInput.files);
      importInput.value = '';
    });
  }

  private sortHeaderHtml(key: SortKey, label: string): string {
    const active = this.sortKey === key;
    const aria = active ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="sortable${active ? ' sorted' : ''}" data-sort-col="${key}" aria-sort="${aria}" role="columnheader" tabindex="0">${label}</th>`;
  }

  private async applySort(key: SortKey, toggleIfSame = true): Promise<void> {
    if (toggleIfSame && this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDir = 'asc';
    }
    const sel = this.querySelector('[data-sort]') as HTMLSelectElement | null;
    if (sel) sel.value = this.sortKey;
    await this.reload();
    this.renderContent();
  }

  private renderSidebar(): void {
    const side = this.querySelector('.sidebar');
    if (!side) return;
    const connectedId = this.remoteNbpName || this.remoteEndpoint?.id || '';
    const volumes = this.remoteVolumes;
    const viewingLocal = this.source === 'local' && this.hasLocalShare();
    const netInfo = isNetworkCatalog(this.vfs) ? this.parseCwdNetwork() : null;
    const networkServerId =
      netInfo && (netInfo.role === 'server' || netInfo.role === 'share')
        ? this.remoteEndpoint?.id ||
          this.servers.find(
            (s) =>
              s.kind === netInfo.protocol &&
              s.title.trim().toLowerCase() === (netInfo.server || '').toLowerCase(),
          )?.id
        : undefined;
    const openVol =
      netInfo?.role === 'share'
        ? netInfo.share || ''
        : this.source === 'remote' && this.remoteOpen
          ? this.pathStack[0]?.name || ''
          : '';
    const active = resolveSidebarActive({
      connectingEndpointId: this.connectingEndpointId,
      connectingVolume: this.connectingVolume,
      viewingLocal,
      networkCatalog: isNetworkCatalog(this.vfs),
      networkRole: netInfo?.role ?? '',
      networkServerId,
      remoteOpen: this.remoteOpen,
      openVolume: openVol,
      remoteEndpointId: this.remoteEndpoint?.id || this.remoteNbpName || '',
    });
    const groups = this.sidebarGroups();
    const byGroup = endpointsByGroup(this.servers, groups);
    const refreshEnabled = this.host?.isConnected() || !this.hasTransport();
    const groupBlocks = visibleSidebarGroups(groups, byGroup)
      .map((g) => {
        const rows = (byGroup.get(g.id) ?? []).filter(({ ep }) => !ep.own);
        const items =
          rows
            .map(({ ep: s, index: i }) =>
              this.sidebarEndpointHtml(s, i, {
                connectedId,
                volumes,
                viewingLocal,
                openVol,
                active,
              }),
            )
            .join('') ||
          `<div class="side-item"><span class="dot off"></span><span>${this.escape(g.empty || 'None')}</span></div>`;
        const scanning = this.networkScanning === '*' || this.networkScanning === g.id;
        const refresh = g.refresh
          ? `<button type="button" class="side-refresh${scanning ? ' spinning' : ''}" data-act="refresh" data-refresh="${this.escape(g.id)}" aria-label="Scan ${this.escape(g.title)}" aria-busy="${scanning}" ${refreshEnabled ? '' : 'disabled'}>${uiIcons.refresh}</button>`
          : '';
        return `
      <div class="side-label${g.refresh ? ' side-label--with-action' : ''}">
        <span>${this.escape(g.title)}</span>
        ${refresh}
      </div>
      ${items}`;
      })
      .join('');
    const localBlock = this.hasLocalShare()
      ? `<div class="side-label">Local</div>
      <div class="side-item ${viewingLocal && active.kind === 'local' ? 'selected' : ''}" data-local data-share-key="${LOCAL_SHARE_KEY}" data-share-name="${this.escape(this.localShareTitle())}">
        <span class="dot"></span>
        <span class="side-item-label" aria-label="${this.escape(this.localShareTitle())}">${this.escape(this.localShareTitle())}</span>
        <button type="button" class="side-more" data-act="share-actions" aria-label="Share actions" title="Share actions">${uiIcons.more}</button>
      </div>`
      : '';
    const networkBlock = this.networkBrowserEnabled()
      ? `<div class="side-label">Network</div>
      <div class="side-item ${active.kind === 'network' ? 'selected' : ''}" data-network>
        ${this.sidebarGlyphHtml(networkGlyphSrc('root'))}
        <span class="side-item-label" aria-label="${this.escape(NETWORK_ROOT_NAME)}">${this.escape(NETWORK_ROOT_NAME)}</span>
      </div>`
      : '';
    side.innerHTML = `
      ${localBlock}
      ${networkBlock}
      ${groupBlocks}
    `;
  }

  private sidebarGroups(): SidebarGroup[] {
    const custom = this.host?.sidebarGroups?.();
    if (custom?.length) return custom;
    return [
      {
        id: SIDEBAR_GROUP_NETWORK,
        title: this.hasTransport() ? 'LocalTalk' : 'Network',
        refresh: true,
        empty: this.hasTransport() ? 'No AFP servers' : 'No servers',
      },
    ];
  }

  private sidebarBadgeHtml(badge: string | SidebarBadge | undefined): string {
    const text = badgeText(badge);
    if (!text) return '';
    const title = badgeTitle(badge);
    const tip = title ? ` title="${this.escape(title)}"` : '';
    return `<span class="side-badge"${tip}>${this.escape(text)}</span>`;
  }

  private sidebarGlyphHtml(src: string | undefined): string {
    if (!src) return '<span class="dot"></span>';
    return `<img class="side-item-icon" src="${this.escape(src)}" width="16" height="16" alt="" draggable="false" />`;
  }

  private volumesFor(s: RemoteEndpoint): string[] {
    return volumesForEndpoint(
      s,
      this.knownVolumes,
      this.remoteNbpName || this.remoteEndpoint?.id || '',
      this.remoteLoggedIn,
      this.remoteVolumes,
    );
  }

  /** True when the on-screen catalog is already this sidebar endpoint. */
  private viewingEndpoint(s: RemoteEndpoint): boolean {
    const currentId = this.remoteEndpoint?.id || this.remoteNbpName;
    if (isCatalogEndpoint(s)) {
      return viewingCatalogEndpoint(s, currentId, this.source, this.remoteOpen);
    }
    if (isNetworkCatalog(this.vfs)) {
      const info = this.parseCwdNetwork();
      if (info.role !== 'server' && info.role !== 'share') return false;
      return currentId === s.id || (info.server === s.title && s.kind === info.protocol);
    }
    if (this.source !== 'remote' || !this.remoteOpen || currentId !== s.id) return false;
    const openName = this.pathStack[0]?.name;
    return !!openName && this.volumesFor(s).includes(openName);
  }

  private async openCatalogVolume(s: RemoteEndpoint): Promise<void> {
    const name = this.volumesFor(s)[0] || s.title;
    if (!name) throw new Error(`Couldn’t open “${s.title}”`);
    await this.mountRemoteVolume(name);
  }

  private forgetEndpoint(id: string): void {
    if (!id) return;
    this.knownVolumes.delete(id);
    this.loggedInEndpoints.delete(id);
    for (const k of [...this.openedVolumeKeys]) {
      if (k === `endpoint:${id}` || k.startsWith(`${id}:`)) this.openedVolumeKeys.delete(k);
    }
  }

  private volumeIsOpen(s: RemoteEndpoint, volume?: string): boolean {
    if (s.role === 'volume') return true;
    if (!volume) return false;
    return this.openedVolumeKeys.has(shareKeyForEndpoint(s, volume));
  }

  private sidebarEndpointHtml(
    s: RemoteEndpoint,
    i: number,
    opts: {
      connectedId: string;
      volumes: string[];
      viewingLocal: boolean;
      openVol: string;
      active: ReturnType<typeof resolveSidebarActive>;
    },
  ): string {
    const connected = this.loggedInEndpoints.has(s.id) || (this.remoteLoggedIn && s.id === opts.connectedId);
    const localShare = s.kind === 'local';
    const volumeRow = s.role === 'volume';
    const chrome = volumeChrome({
      ...this.caps(),
      identity: { shareKind: s.kind, protocol: s.protocol as typeof s.kind },
    });
    const glyphClass = `side-item--${chrome.volumeIcon}`;
    const protocol = (s.protocol || (localShare ? '' : s.kind)).toLowerCase();
    const rowRole: SidebarGlyphRole = localShare ? 'share' : volumeRow ? 'volume' : 'server';
    const serverGlyph = this.sidebarGlyphHtml(sidebarGlyphSrc(protocol, rowRole));
    const volumeGlyph = this.sidebarGlyphHtml(sidebarGlyphSrc(protocol, 'volume'));
    const connectingHere = this.connectingEndpointId === s.id;
    const connectingServer = connectingHere && !this.connectingVolume;
    const serverSel =
      (opts.active.kind === 'server' && opts.active.id === s.id) ||
      (isCatalogEndpoint(s) && opts.active.kind === 'volume' && opts.active.id === s.id)
        ? 'selected'
        : '';
    const serverBusy = connectingServer || (connectingHere && (localShare || volumeRow) && !this.connectingVolume);
    const volumes = this.volumesFor(s);
    const kids =
      !localShare && !volumeRow && volumes.length
        ? volumes
            .map((v, vi) => {
              const shareKey = shareKeyForEndpoint(s, v);
              const connectingVol = connectingHere && this.connectingVolume === v;
              const selected =
                opts.active.kind === 'volume' && opts.active.id === s.id && opts.active.volume === v
                  ? 'selected'
                  : '';
              const eject = this.volumeIsOpen(s, v)
                ? `<button type="button" class="side-eject" data-eject="${vi}" data-vol-name="${this.escape(v)}" title="Eject" aria-label="Eject">${uiIcons.eject}</button>`
                : '';
              const volSpinner = connectingVol ? this.spinnerHtml('side-item-spinner') : '';
              // A volume already connected elsewhere (s.knownVolumes, not this tab's
              // own live login) carries a friendly path so the row shows where it
              // points, the way a Get Info / URI hint would for a mounted share.
              const path = s.knownVolumes?.find((k) => k.name === v)?.path;
              const pathAttr = path ? ` title="${this.escape(path)}"` : '';
              const pathMeta = path ? `<span class="side-item-host">${this.escape(path)}</span>` : '';
              return `
      <div class="side-item side-item--child ${glyphClass} ${selected}" data-vol="${vi}" data-vol-name="${this.escape(v)}" data-server-parent="${i}" data-share-key="${this.escape(shareKey)}" data-share-name="${this.escape(v)}"${pathAttr}${connectingVol ? ' aria-busy="true"' : ''}>
        ${volumeGlyph}
        <span class="side-item-label" aria-label="${this.escape(v)}">${this.escape(v)}${pathMeta}</span>
        ${volSpinner}
        ${eject}
      </div>`;
            })
            .join('')
        : '';
    const ejectSelf =
      volumeRow && !localShare
        ? `<button type="button" class="side-eject" data-eject-endpoint="${i}" title="Eject" aria-label="Eject">${uiIcons.eject}</button>`
        : '';
    const disconnect =
      connected && !localShare && !volumeRow
        ? `<button type="button" class="side-eject" data-disconnect="${i}" title="Disconnect" aria-label="Disconnect">${uiIcons.disconnect}</button>`
        : '';
    const subtitle = s.subtitle ? ` title="${this.escape(s.subtitle)}"` : '';
    const shareAttrs = isCatalogEndpoint(s)
      ? ` data-share-key="${this.escape(shareKeyForEndpoint(s))}" data-share-name="${this.escape(s.title)}"`
      : '';
    const serverSpinner = serverBusy ? this.spinnerHtml('side-item-spinner') : '';
    const hostLabel = this.escape(s.title);
    const hostMeta =
      !localShare && !volumeRow && s.subtitle
        ? `<span class="side-item-host">${this.escape(s.subtitle)}</span>`
        : '';
    return `
      <div class="side-item ${glyphClass} ${serverSel}" data-server="${i}"${subtitle}${shareAttrs}${serverBusy ? ' aria-busy="true"' : ''}>
        ${serverGlyph}
        <span class="side-item-label" aria-label="${this.escape(s.title)}">${hostLabel}${hostMeta}</span>
        ${serverSpinner}
        ${this.sidebarBadgeHtml(s.badge)}
        ${ejectSelf}
        ${disconnect}
      </div>${kids}`;
  }

  private locationCrumbs() {
    const volumeMounted = this.remoteOpen && !isNetworkCatalog(this.vfs);
    const proto = this.remoteEndpoint?.protocol || this.remoteEndpoint?.kind;
    return buildLocationCrumbs({
      mode: isNetworkCatalog(this.vfs) ? 'network' : this.locationMode,
      locationUri: this.locationUri,
      serverTitle: this.remoteEndpoint?.title || '',
      protocol: proto,
      groupTitle: this.catalogGroupTitle(),
      networkPrefix: this.networkPrefix,
      pathStack: this.pathStack,
      volumeMounted,
    });
  }

  /** Sidebar group for a hosted share / FUSE mount — not a LAN server name. */
  private catalogGroupTitle(): string {
    const ep = this.remoteEndpoint;
    if (!ep || !isCatalogEndpoint(ep) || isNetworkCatalog(this.vfs)) return '';
    const groups = this.sidebarGroups();
    const id = assignSidebarGroup(ep, groups);
    return groups.find((g) => g.id === id)?.title || '';
  }

  private renderPath(): void {
    const bar = this.querySelector('.pathbar');
    if (!bar) return;
    const crumbs = this.isNoVolumeSelected() ? [] : this.locationCrumbs();

    bar.innerHTML =
      `<button type="button" class="locations-btn" data-act="locations" aria-label="Locations" title="Locations">${uiIcons.menu}</button>` +
      crumbs
      .map((p, i) => {
        const label = this.escape(p.name);
        const current = i === crumbs.length - 1;
        const dropAttr = p.nodeId != null ? `data-path-id="${refKey(p.nodeId)}"` : '';
        const locAttr = p.networkPath != null
          ? `data-loc="network" data-network-path="${this.escape(p.networkPath)}"`
          : p.serverShares
            ? `data-loc="server"`
            : p.volumeRoot
              ? `data-loc="volume"`
              : p.pathIndex != null
                ? `data-loc="node" data-path-index="${p.pathIndex}"`
                : '';
        const sep = i > 0 ? `<span class="crumb-sep" aria-hidden="true">&gt;</span>` : '';
        const urls = p.nodeId != null ? this.iconUrls.get(refKey(p.nodeId)) : undefined;
        const crumbNode = p.nodeId != null ? this.findNodeAnywhere(p.nodeId) : undefined;
        let chromeSrc = p.iconSrc || crumbNode?.chrome?.iconSrc;
        if (!chromeSrc && isNetworkCatalog(this.vfs) && p.nodeId != null) {
          const info = parseNetworkPath(String(p.nodeId), this.servers);
          chromeSrc = info.volumePath ? undefined : networkGlyphSrc(info.role, info.protocol);
        }
        const icon =
          p.nodeId != null && this.isFolderEnumerating(p.nodeId)
            ? this.listingSpinnerHtml('crumb')
            : chromeSrc
              ? `<img class="crumb-icon-img" src="${this.escape(chromeSrc)}" alt="" width="16" height="16" draggable="false" />`
              : urls && !isDefaultFolderIcon(urls)
              ? `<img class="crumb-icon-img" src="${this.escape(urls.small)}" alt="" width="16" height="16" draggable="false" />`
              : this.folderGlyphHtml('small', 'crumb');
        return `${sep}<button type="button" class="crumb${current ? ' current' : ''}" ${locAttr} ${dropAttr} title="${label}" aria-label="${label}">
          ${icon}
          <span class="crumb-label">${label}</span>
        </button>`;
      })
      .join('');

    this.prefetchPathIcons(crumbs.map((c) => ({ id: c.nodeId })));
  }

  /** Load 16px folder icons for path crumbs (local share). */
  private prefetchPathIcons(crumbs: { id?: NodeRef }[]): void {
    if (!this.readFinderIcons) return;
    const gen = this.iconLoadGen;
    for (const c of crumbs) {
      if (c.id == null) continue;
      const key = refKey(c.id);
      if (this.iconUrls.has(key)) continue;
      void (async () => {
        try {
          await iconCache.init();
          const node = await this.vfs.get(c.id!);
          if (!node) return;
          const urls = await this.iconLookup(node);
          if (gen !== this.iconLoadGen) return;
          if (isDefaultFolderIcon(urls)) return;
          this.iconUrls.set(key, urls);
          this.patchIconInDom(key, urls);
        } catch {
          /* keep placeholder */
        }
      })();
    }
  }

  private renderContent(): void {
    const content = this.querySelector('.content');
    if (!content) return;
    const keepScroll = this.view !== 'column';
    const scrollTop = keepScroll ? content.scrollTop : 0;
    const scrollLeft = keepScroll ? content.scrollLeft : 0;
    const columnPaneScroll = this.view === 'column' ? this.captureColumnPaneScroll() : null;

    let iconItems: ListItem[] = [];

    if (this.view === 'column') {
      content.innerHTML = this.renderColumnView();
      iconItems = this.columnIconItems();
    } else {
      const items = this.currentItems();
      iconItems = items;
      if (items.length === 0) {
        content.innerHTML = `<div class="empty">${this.escape(this.emptyPaneMessage())}</div>`;
      } else if (this.view === 'icon') {
        content.innerHTML = `<div class="icon-grid">${items.map((it) => this.iconHtml(it)).join('')}</div>`;
      } else if (this.view === 'list') {
        const rows = this.buildOutlineRows(this.nodes, 0);
        if (rows.length === 0 && this.folderOpening) {
          rows.push({ item: this.listingPlaceholderItem(), depth: 0 });
        }
        iconItems = rows.map((r) => r.item);
        content.innerHTML = `<table class="list-table">
          <thead><tr>
            ${this.sortHeaderHtml('name', 'Name')}
            ${this.sortHeaderHtml('size', 'Size')}
            ${this.sortHeaderHtml('modified', 'Modified')}
          </tr></thead>
          <tbody>${rows.map(({ item, depth }) => this.listRowHtml(item, depth)).join('')}</tbody>
        </table>`;
      } else {
        content.innerHTML = `<div class="column-view"><div class="column">${items
          .map((it) => this.colItemHtml(it, 0, this.selectedIds))
          .join('')}</div></div>`;
      }
    }

    if (this.view === 'column') {
      this.restoreColumnPaneScroll(columnPaneScroll);
      this.scrollColumnsToEnd();
      requestAnimationFrame(() => this.restoreColumnPaneScroll(columnPaneScroll));
    } else {
      content.scrollTop = scrollTop;
      content.scrollLeft = scrollLeft;
      this.refreshPropsPanel();
    }
    this.focusRenameInput();
    if (iconItems.length) this.prefetchIcons(iconItems, 'replace');
    this.writeSig = this.writingSignature();
  }

  private columnIconItems(): ListItem[] {
    const out: ListItem[] = [];
    this.columnChildren.forEach((kids, colIndex) => {
      const parentId = this.pathStack[colIndex]?.id ?? this.cwd;
      out.push(...this.mergeWritingItems(parentId, kids.map((n) => this.listItemFromNode(n))));
    });
    return out;
  }

  /** Update the column preview pane, or the floating Get Info window in icon/list. */
  private refreshPropsPanel(): void {
    if (this.view === 'column') {
      this.getInfoWindow?.hide();
      this.paintColumnSelection();
      return;
    }
    if (!this.showProps) {
      this.getInfoWindow?.hide();
      return;
    }
    const win = this.getInfoWindow;
    if (!win) return;
    if (this.selectedIds.size > 1) {
      win.setBody(this.multiSelectionInfoHtml({ variant: 'dialog' }));
      win.show();
      return;
    }
    const sel = this.selectedNode();
    win.setBody(
      sel
        ? this.itemInfoHtml(sel, { variant: 'dialog' })
        : `<p class="get-info-window__empty">Select an item in the Finder.</p>`,
    );
    win.show();
  }

  private focusRenameInput(): void {
    if (this.renamingId == null) return;
    requestAnimationFrame(() => {
      const input = this.querySelector(`input[data-rename="${selRef(this.renamingId!)}"]`) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    });
  }

  private nameLabelHtml(it: ListItem, extraClass = 'row-name'): string {
    if (this.renamingId != null && it.key === refKey(this.renamingId)) {
      const safe = this.escape(it.name);
      return `<input class="rename-input" data-rename="${it.key}" value="${safe}" aria-label="${safe}" />`;
    }
    return this.fileNameLabel(it.name, extraClass);
  }

  private fileNameLabel(name: string, extraClass: string): string {
    const safe = this.escape(name);
    return `<span class="${extraClass} item-label" aria-label="${safe}">${safe}</span>`;
  }

  private scrollColumnsToEnd(): void {
    const scroller = this.querySelector('.column-view') as HTMLElement | null;
    if (!scroller) return;
    requestAnimationFrame(() => {
      scroller.scrollLeft = scroller.scrollWidth;
    });
  }

  /** Per-column vertical offsets, keyed by `data-col-index` or `"preview"`. */
  private captureColumnPaneScroll(): Map<string, number> {
    const out = new Map<string, number>();
    const view = this.querySelector('.column-view');
    if (!view) return out;
    view.querySelectorAll('.column-pane').forEach((pane) => {
      const key = this.columnPaneScrollKey(pane);
      if (key != null) out.set(key, (pane as HTMLElement).scrollTop);
    });
    return out;
  }

  private restoreColumnPaneScroll(saved: Map<string, number> | null): void {
    if (!saved || saved.size === 0) return;
    const view = this.querySelector('.column-view');
    if (!view) return;
    view.querySelectorAll('.column-pane').forEach((pane) => {
      const key = this.columnPaneScrollKey(pane);
      if (key == null) return;
      const top = saved.get(key);
      if (top != null) (pane as HTMLElement).scrollTop = top;
    });
  }

  private columnPaneScrollKey(pane: Element): string | null {
    const col = pane.closest('.column');
    if (!col) return null;
    return col.getAttribute('data-col-index') ?? (col.hasAttribute('data-preview') ? 'preview' : null);
  }

  /** Highlight the selection and swap the info pane without remounting list columns. */
  private paintColumnSelection(): void {
    const view = this.querySelector('.column-view');
    if (!view) {
      this.renderContent();
      return;
    }
    const listColCount = this.columnChildren.length;
    for (let i = 0; i < listColCount; i++) {
      if (!view.querySelector(`[data-col-index="${i}"]`)) {
        this.renderContent();
        return;
      }
    }

    view.querySelectorAll(':scope > .column[data-col-index]').forEach((col) => {
      const idx = Number(col.getAttribute('data-col-index'));
      if (Number.isFinite(idx) && idx >= listColCount) col.remove();
    });
    view.querySelector('.column--loading')?.remove();

    for (let colIndex = 0; colIndex < listColCount; colIndex++) {
      const kids = this.columnChildren[colIndex]!;
      const selectedInColumn = this.columnSelectionIds(colIndex, kids, listColCount);
      view.querySelectorAll(`[data-col-index="${colIndex}"] .col-item[data-id]`).forEach((el) => {
        const id = dataRef(el);
        el.classList.toggle('selected', id != null && selectedInColumn.has(id));
      });
    }

    const multi = this.selectedIds.size > 1;
    const preview = this.columnLoading || multi ? null : this.columnPreviewNode();
    const existing = view.querySelector('[data-preview]') as HTMLElement | null;
    if (multi) {
      existing?.remove();
      view.insertAdjacentHTML('beforeend', this.multiSelectionInfoHtml({ variant: 'column' }));
    } else if (!preview) {
      existing?.remove();
    } else if (existing?.getAttribute('data-id') !== refKey(nodeRef(preview))) {
      existing?.remove();
      view.insertAdjacentHTML('beforeend', this.itemInfoHtml(preview, { variant: 'column' }));
    } else {
      this.ensureVersInfo(preview);
    }

    this.syncClipboardButtons();
    this.scrollColumnsToEnd();
  }

  private buildOutlineRows(nodes: VNode[], depth: number, parentId = this.cwd): { item: ListItem; depth: number }[] {
    const rows: { item: ListItem; depth: number }[] = [];
    const items = this.mergeWritingItems(parentId, nodes.map((n) => this.listItemFromNode(n)));
    for (const item of items) {
      rows.push({ item, depth });
      if (item.node && this.itemIsNavigable(item) && this.expandedIds.has(nodeRef(item.node))) {
        const id = nodeRef(item.node);
        const kids = this.listChildCache.get(id) ?? [];
        if (kids.length === 0 && this.loadingIds.has(id) && !transferActivity.writesIn(this.vfs, id).length) {
          rows.push({ item: this.listingPlaceholderItem(), depth: depth + 1 });
        } else {
          rows.push(...this.buildOutlineRows(kids, depth + 1, id));
        }
      }
    }
    return rows;
  }

  private iconHtml(it: ListItem): string {
    if (it.placeholder) {
      return `<div class="icon-item icon-item--listing" aria-busy="true" aria-label="Loading">
      ${this.listingSpinnerHtml('icon')}
      <div class="icon-name"><span class="item-label">Loading…</span></div>
    </div>`;
    }
    const sel = this.isKeySelected(it.key) ? 'selected' : '';
    const drag = it.writing && !it.node ? '' : isNetworkContainer(it.node) ? '' : 'draggable="true"';
    const write = this.writeItemAttrs(it);
    const openable = this.itemIsOpenable(it);
    const navigable = this.itemIsNavigable(it);
    return `<div class="icon-item ${sel}${it.writing ? ' writing' : ''}" data-id="${it.key}" data-dir="${navigable ? '1' : '0'}" data-open="${openable ? '1' : '0'}" ${write} ${drag}>
      ${this.glyphHtml(it, 'large', 'icon')}
      <div class="icon-name">${this.nameLabelHtml(it)}</div>
    </div>`;
  }

  private listRowHtml(it: ListItem, depth = 0): string {
    if (it.placeholder) {
      return `<tr class="listing-placeholder" aria-busy="true" aria-label="Loading" style="--depth:${depth}">
      <td class="name-cell"><span class="disclose spacer"></span>${this.listingSpinnerHtml('row')}<span class="row-name item-label">Loading…</span></td>
      <td></td>
      <td></td>
    </tr>`;
    }
    const sel = this.isKeySelected(it.key) ? 'selected' : '';
    const id = itemAddr(it);
    const expanded = this.itemIsNavigable(it) && id != null && this.expandedIds.has(id);
    const loading = this.itemIsNavigable(it) && id != null && this.loadingIds.has(id);
    const drag = it.writing && !it.node ? '' : isNetworkContainer(it.node) ? '' : 'draggable="true"';
    const write = this.writeItemAttrs(it);
    const disclose = this.itemIsNavigable(it) && it.node
      ? `<button type="button" class="disclose ${expanded ? 'open' : ''}${loading ? ' loading' : ''}" data-disclose="${it.key}" aria-busy="${loading}" aria-label="${
          loading ? 'Loading' : expanded ? 'Collapse' : 'Expand'
        }">${uiIcons.disclose}</button>`
      : `<span class="disclose spacer"></span>`;
    return `<tr data-id="${it.key}" data-dir="${this.itemIsNavigable(it) ? '1' : '0'}" data-open="${this.itemIsOpenable(it) ? '1' : '0'}" class="${sel}${it.writing ? ' writing' : ''}" style="--depth:${depth}" aria-label="${this.escape(it.name)}" ${write} ${drag}>
      <td class="name-cell">${disclose}${this.glyphHtml(it, 'small', 'row')}${this.nameLabelHtml(it)}</td>
      <td>${it.isDir || isNetworkContainer(it.node) ? '—' : formatBytes(it.size)}</td>
      <td>${it.mod.toLocaleString()}</td>
    </tr>`;
  }

  private colItemHtml(it: ListItem, colIndex: number, selectedInColumn: Set<NodeRef>): string {
    if (it.placeholder) {
      return `<div class="col-item col-item--listing" aria-busy="true" aria-label="Loading">
      ${this.listingSpinnerHtml('col')}<span class="col-name item-label">Loading…</span>
    </div>`;
    }
    const id = itemAddr(it);
    const sel = id != null && selectedInColumn.has(id) ? 'selected' : '';
    const drag = it.writing && !it.node ? '' : isNetworkContainer(it.node) ? '' : 'draggable="true"';
    const write = this.writeItemAttrs(it);
    const label = this.nameLabelHtml(it, 'col-name');
    return `<div class="col-item ${sel}${it.writing ? ' writing' : ''}" data-id="${it.key}" data-dir="${this.itemIsNavigable(it) ? '1' : '0'}" data-open="${this.itemIsOpenable(it) ? '1' : '0'}" data-col="${colIndex}" aria-label="${this.escape(it.name)}" ${write} ${drag}>
      ${this.glyphHtml(it, 'small', 'col')}${label}
    </div>`;
  }

  private folderGlyphHtml(size: 'small' | 'large', kind: 'icon' | 'row' | 'col' | 'crumb' | 'preview'): string {
    const px = size === 'large' ? 32 : 16;
    const src = size === 'large' ? DEFAULT_FOLDER_ICONS.large : DEFAULT_FOLDER_ICONS.small;
    const cls =
      kind === 'icon'
        ? 'icon-glyph-img'
        : kind === 'col'
          ? 'col-icon-img'
          : kind === 'row'
            ? 'row-icon-img'
            : kind === 'crumb'
              ? 'crumb-icon-img'
              : 'preview-glyph-img';
    return `<img class="${cls}" src="${src}" alt="" width="${px}" height="${px}" draggable="false" />`;
  }

  private listingSpinnerHtml(kind: 'icon' | 'row' | 'col' | 'crumb' | 'preview'): string {
    const cls =
      kind === 'icon'
        ? 'icon-glyph-spinner'
        : kind === 'col'
          ? 'col-icon-spinner'
          : kind === 'row'
            ? 'row-icon-spinner'
            : kind === 'crumb'
              ? 'crumb-icon-spinner'
              : 'preview-glyph-spinner';
    return this.spinnerHtml(cls);
  }

  private glyphHtml(it: ListItem, size: 'small' | 'large', kind: 'icon' | 'row' | 'col'): string {
    if (it.placeholder) return this.listingSpinnerHtml(kind);
    const id = itemAddr(it);
    const enumerating = this.itemIsNavigable(it) && id != null && this.isFolderEnumerating(id) && !it.writing;
    if (enumerating) return this.listingSpinnerHtml(kind);
    const urls = this.iconUrls.get(it.key);
    const px = size === 'large' ? 32 : 16;
    let inner: string;
    const chromeSrc = it.node?.chrome?.iconSrc;
    if (chromeSrc) {
      const imgCls = kind === 'icon' ? 'icon-glyph-img' : kind === 'col' ? 'col-icon-img' : 'row-icon-img';
      inner = `<img class="${imgCls}" src="${this.escape(chromeSrc)}" alt="" width="${px}" height="${px}" draggable="false" />`;
    } else if (urls && !(it.isDir && isDefaultFolderIcon(urls))) {
      const src = size === 'large' ? urls.large : urls.small;
      const imgCls = kind === 'icon' ? 'icon-glyph-img' : kind === 'col' ? 'col-icon-img' : 'row-icon-img';
      inner = `<img class="${imgCls}" src="${this.escape(src)}" alt="" width="${px}" height="${px}" draggable="false" />`;
    } else if (it.isDir) {
      inner = this.folderGlyphHtml(size, kind);
    } else if (kind === 'icon') {
      inner = `<div class="icon-glyph">DOC</div>`;
    } else {
      const cls = kind === 'col' ? 'col-icon file' : 'row-icon file';
      inner = `<span class="${cls}" aria-hidden="true"></span>`;
    }
    return it.writing ? this.writeOverlayHtml(inner, it.writing, kind) : inner;
  }

  private writeItemAttrs(it: ListItem): string {
    const w = it.writing;
    if (!w) return '';
    const label = w.indeterminate
      ? `Copying ${this.escape(w.name)}`
      : `Copying ${this.escape(w.name)}, ${w.pct}%`;
    return `data-write-job="${this.escape(w.jobId)}" data-write-name="${this.escape(w.name)}" aria-busy="true" aria-label="${label}"`;
  }

  private writeOverlayHtml(inner: string, w: TransferWriteProgress, kind: 'icon' | 'row' | 'col'): string {
    const pctLabel = w.indeterminate ? '' : `${w.pct}%`;
    const ind = w.indeterminate ? ' icon-write--indeterminate' : '';
    return `<span class="icon-write icon-write--${kind}${ind}" style="--write-pct:${w.pct}" aria-hidden="true">
      <span class="icon-write__glyph">${inner}</span>
      <span class="icon-write__ring"></span>
      <span class="icon-write__pct">${pctLabel}</span>
    </span>`;
  }

  private iconLookup(node: VNode): Promise<IconUrls> {
    const signal = this.iconAbort?.signal;
    const loadDataRange = <T>(n: VNode, fn: (read: ByteRangeReader) => Promise<T>) =>
      this.vfs.withRangeReader(n, fn, { resource: false, signal });
    if (!this.readFinderIcons && !isWinIconName(node.name)) {
      if (node.isDir) return Promise.resolve(DEFAULT_FOLDER_ICONS);
      const { type, creator } = readTypeCreator(node.finderInfo);
      return iconCache.getForTypeCreator(type, creator, node.name);
    }
    return iconCache.getForNode(
      node,
      this.readFinderIcons && node.isDir ? (id, name) => this.vfs.lookup(id, name) : undefined,
      this.readFinderIcons ? (n) => this.vfs.loadIconResources(n, signal) : undefined,
      {
        loadDesktopIcons:
          this.readFinderIcons && this.catalogForNode(node).loadDesktopIcons
            ? (type, creator) => this.catalogForNode(node).loadDesktopIcons!(type, creator, signal)
            : undefined,
        loadDataRange,
        signal,
      },
    );
  }

  /** Observe Finder glyphs and load at most four on-screen icons at a time. */
  private prefetchIcons(items: ListItem[], mode: 'replace' | 'add'): void {
    if (mode === 'replace') {
      this.iconQueue.reset();
      this.iconPrefetchItems.clear();
      this.iconIntersectingEls.clear();
      this.iconObserver?.disconnect();
      this.iconObserver = null;
    }
    for (const it of items) {
      if (it.placeholder || this.iconUrls.has(it.key)) continue;
      this.iconPrefetchItems.set(it.key, it);
    }
    this.ensureIconObserver();
    this.observeIconElements(items);
  }

  private ensureIconObserver(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    if (this.iconObserver) return;
    // Viewport root so overflow:auto clipping (Finder pane / column panes) is
    // applied. A flex child as root often never reports intersections.
    this.iconObserver = new IntersectionObserver((entries) => this.onIconIntersect(entries), {
      root: null,
      threshold: 0,
    });
  }

  private teardownIconObserver(): void {
    this.iconObserver?.disconnect();
    this.iconObserver = null;
    this.iconIntersectingEls.clear();
    this.iconQueue.reset();
    this.iconPrefetchItems.clear();
  }

  private observeIconElements(items: ListItem[]): void {
    const observer = this.iconObserver;
    if (!observer) {
      for (const it of items) {
        if (it.placeholder || this.iconUrls.has(it.key)) continue;
        this.iconQueue.enqueue(it);
      }
      return;
    }
    for (const it of items) {
      if (it.placeholder || this.iconUrls.has(it.key)) continue;
      for (const el of this.finderIconElements(it.key)) observer.observe(el);
    }
  }

  private onIconIntersect(entries: IntersectionObserverEntry[]): void {
    const changed = new Set<string>();
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).getAttribute('data-id');
      if (!key) continue;
      if (entry.isIntersecting) {
        this.iconIntersectingEls.add(entry.target);
      } else {
        this.iconIntersectingEls.delete(entry.target);
      }
      changed.add(key);
    }
    for (const key of changed) {
      if (this.isFinderIconVisible(key)) {
        const it = this.iconPrefetchItems.get(key);
        if (!it || this.iconUrls.has(key)) continue;
        this.iconQueue.enqueue(it);
      } else {
        this.iconQueue.hide(key);
      }
    }
  }

  private finderIconElements(key: string): Element[] {
    return [...this.querySelectorAll(`.content [data-id="${CSS.escape(key)}"]`)];
  }

  private isFinderIconVisible(key: string): boolean {
    if (!this.iconObserver) return true;
    for (const el of this.iconIntersectingEls) {
      if (el.getAttribute('data-id') === key) return true;
    }
    return false;
  }

  private async resolveVisibleIcon(it: ListItem): Promise<void> {
    const gen = this.iconLoadGen;
    const signal = this.iconAbort?.signal;
    if (it.placeholder || this.iconUrls.has(it.key)) return;
    if (it.node?.chrome?.iconSrc) return;
    if (gen !== this.iconLoadGen || signal?.aborted) return;
    if (!this.isFinderIconVisible(it.key)) return;
    try {
      await iconCache.init();
      if (gen !== this.iconLoadGen || signal?.aborted) return;
      if (!this.isFinderIconVisible(it.key)) return;
      let urls: IconUrls;
      if (it.node) {
        urls = await this.iconLookup(it.node);
      } else if (it.isDir) {
        return;
      } else {
        const fi = it.finderInfo ?? new Uint8Array(32);
        const { type, creator } = readTypeCreator(fi);
        urls = await iconCache.getForTypeCreator(type, creator, it.name);
      }
      if (gen !== this.iconLoadGen || signal?.aborted) return;
      if (it.isDir && isDefaultFolderIcon(urls)) return;
      this.iconUrls.set(it.key, urls);
      this.patchIconInDom(it.key, urls);
      this.iconObserver && this.finderIconElements(it.key).forEach((el) => this.iconObserver?.unobserve(el));
    } catch (err) {
      if (isAbortError(err)) return;
    }
  }

  private patchIconInDom(key: string, urls: IconUrls): void {
    const id = parseRefKey(key);
    if (id != null && this.isFolderEnumerating(id)) return;
    const esc = CSS.escape(key);
    const nodes = [
      ...this.querySelectorAll(`[data-id="${esc}"], [data-path-id="${esc}"]`),
      ...(this.getInfoWindow?.querySelectorAll(`[data-id="${esc}"]`) ?? []),
    ];
    for (const el of nodes) {
      const large = el.querySelector('.icon-glyph, .icon-glyph-img, .icon-glyph-svg');
      if (large) {
        const img = document.createElement('img');
        img.className = 'icon-glyph-img';
        img.src = urls.large;
        img.alt = '';
        img.width = 32;
        img.height = 32;
        img.draggable = false;
        large.replaceWith(img);
      }
      const preview = el.querySelector('.preview-glyph, .preview-glyph-img, .preview-glyph-svg');
      if (preview) {
        const img = document.createElement('img');
        img.className = 'preview-glyph-img';
        img.src = urls.large;
        img.alt = '';
        img.width = 32;
        img.height = 32;
        img.draggable = false;
        preview.replaceWith(img);
      }
      const crumb = el.querySelector('.crumb-icon, .crumb-icon-img, .crumb-icon-svg');
      if (crumb) {
        const img = document.createElement('img');
        img.className = 'crumb-icon-img';
        img.src = urls.small;
        img.alt = '';
        img.width = 16;
        img.height = 16;
        img.draggable = false;
        crumb.replaceWith(img);
      }
      const small = el.querySelector('.row-icon, .col-icon, .row-icon-img, .col-icon-img, .row-icon-svg, .col-icon-svg');
      if (small) {
        const img = document.createElement('img');
        img.className =
          small.classList.contains('col-icon') ||
          small.classList.contains('col-icon-img') ||
          small.classList.contains('col-icon-svg')
            ? 'col-icon-img'
            : 'row-icon-img';
        img.src = urls.small;
        img.alt = '';
        img.width = 16;
        img.height = 16;
        img.draggable = false;
        small.replaceWith(img);
      }
    }
  }

  /** Ids to highlight in a column: the path crumb, or the (possibly multi-) selection in the deepest list column. */
  private columnSelectionIds(colIndex: number, kids: VNode[], listColCount: number): Set<NodeRef> {
    const pathSel = this.pathStack[colIndex + 1]?.id ?? null;
    if (pathSel != null) return new Set([pathSel]);
    if (colIndex === listColCount - 1 && this.selectedIds.size > 0) {
      const kidIds = new Set(kids.map((k) => nodeRef(k)));
      const out = new Set<NodeRef>();
      for (const id of this.selectedIds) {
        if (kidIds.has(id)) out.add(id);
      }
      return out;
    }
    return new Set();
  }

  private networkInfoModel(node: VNode): NetworkInfoModel {
    const role = node.chrome?.networkRole || 'root';
    const ep = this.endpointForNetworkNode(node);
    const extras = ep ? this.host.endpointInfoExtras?.(ep, role === 'share' ? node.name : undefined) : undefined;
    if (ep && (role === 'server' || role === 'share' || role === 'service')) {
      const model = modelFromEndpoint(ep, {
        volume: role === 'share' ? node.name : undefined,
        uams: extras?.uams,
        mountpoint: extras?.mountpoint,
        volumes: extras?.volumes ?? this.volumesFor(ep),
      });
      model.kind = role === 'service' ? 'service' : model.kind;
      model.serviceKind = node.chrome?.serviceKind;
      model.iconSrc = node.chrome?.iconSrc || model.iconSrc;
      model.name = node.name;
      return model;
    }
    const info = parseNetworkPath(
      typeof nodeRef(node) === 'string' ? String(nodeRef(node)) : '',
      this.servers,
    );
    return {
      kind: role,
      name: node.name,
      protocol: info.protocol,
      neighborhood: info.neighborhood,
      server: info.server,
      iconSrc: node.chrome?.iconSrc,
    };
  }

  private networkItemInfoHtml(node: VNode, opts: { variant: 'column' | 'dialog' }): string {
    return networkInfoHtml(this.networkInfoModel(node), {
      variant: opts.variant,
      zipShare: node.chrome?.networkRole === 'share',
    });
  }

  private showEndpointGetInfo(ep: RemoteEndpoint, volume?: string): void {
    const extras = this.host.endpointInfoExtras?.(ep, volume);
    const html = networkInfoHtml(
      modelFromEndpoint(ep, {
        volume,
        uams: extras?.uams,
        mountpoint: extras?.mountpoint,
        volumes: extras?.volumes ?? this.volumesFor(ep),
      }),
      { variant: 'dialog', zipShare: !!volume },
    );
    this.showProps = true;
    this.syncPropsButton();
    const win = this.getInfoWindow;
    if (!win) return;
    win.setBody(html);
    win.show();
  }

  private columnPreviewNode(): VNode | null {
    if (this.selectedId == null) return null;
    const node = this.findNodeAnywhere(this.selectedId);
    if (!node) return null;
    // Files always show preview when selected; folders when Properties is open
    if (!node.isDir) {
      for (const kids of this.columnChildren) {
        if (kids.some((k) => nodeRef(k) === nodeRef(node))) return node;
      }
      return null;
    }
    if (this.showProps) return node;
    return null;
  }

  private forkDownloadBtn(act: 'download-data' | 'download-resource', label: string): string {
    return `<button type="button" class="preview-fork-dl" data-act="${act}" title="${this.escape(label)}" aria-label="${this.escape(label)}">${uiIcons.download}</button>`;
  }

  /** Shared item info card — used by column-view preview and Properties. */
  private itemInfoHtml(node: VNode, opts: { variant: 'column' | 'dialog' }): string {
    if (isNetworkContainer(node)) return this.networkItemInfoHtml(node, opts);
    const caps = this.capsForNode(node);
    const fi = node.finderInfo;
    const { type, creator } = readTypeCreator(fi);
    const kind = node.isDir ? 'Folder' : caps.finderInfo && type === 'APPL' ? 'Application' : 'File';
    const glyphClass = node.isDir ? 'folder' : 'file';
    const urls = this.iconUrls.get(refKey(nodeRef(node)));
    const custom = urls && !isDefaultFolderIcon(urls);
    const glyph =
      node.isDir && this.isFolderEnumerating(nodeRef(node))
        ? this.listingSpinnerHtml('preview')
        : custom
          ? `<img class="preview-glyph-img" src="${this.escape(urls.large)}" alt="" width="32" height="32" draggable="false" />`
          : node.isDir
            ? this.folderGlyphHtml('large', 'preview')
            : `<div class="preview-glyph ${glyphClass}"></div>`;
    const shellClass =
      opts.variant === 'column'
        ? 'column column-preview item-info'
        : 'item-info item-info--dialog';
    if (!urls) this.ensureNodeIcon(node);
    const expandBtn = this.isExpandableArchive(node)
      ? `<button type="button" class="btn" data-act="expand">Expand</button>`
      : '';
    const previewBtn = this.isPreviewable(node)
      ? `<button type="button" class="btn" data-act="preview">Preview…</button>`
      : '';
    const attrBoxes = caps.attributes
      .map((a) => {
        const on = !!node.attrs?.[a.id];
        const dis = a.editable === false ? 'disabled' : '';
        return `<label class="preview-attr"><input type="checkbox" data-attr="${this.escape(a.id)}" ${on ? 'checked' : ''} ${dis}/> ${this.escape(a.label)}</label>`;
      })
      .join('');
    const typeInputs =
      showsTypeCreator(caps, node.isDir)
        ? `<label>Type</label>
        <input type="text" data-prop="type" maxlength="4" spellcheck="false" autocomplete="off" value="${this.escape(type)}" />
        <label>Creator</label>
        <input type="text" data-prop="creator" maxlength="4" spellcheck="false" autocomplete="off" value="${this.escape(creator)}" />`
        : '';
    const applyBtn =
      caps.finderInfo || caps.attributes.some((a) => a.editable !== false)
        ? `<button type="button" class="btn primary" data-act="apply-props">Apply</button>`
        : '';
    const rsrcBtn =
      !node.isDir && showsResourceFork(caps)
        ? `<button type="button" class="btn" data-act="resources">Resources…</button>`
        : '';
    const winRsrcBtn =
      !node.isDir && isWinResourceName(node.name)
        ? `<button type="button" class="btn" data-act="win-resources">Windows Resources…</button>`
        : '';
    const hasRsrc = nodeHasResourceFork(node);
    const showForkDownloads = !node.isDir && hasRsrc && caps.resourceFork;
    const downloadBtn =
      node.isDir || showForkDownloads
        ? `<button type="button" class="btn" data-act="download">${uiIcons.download} Zip</button>`
        : `<button type="button" class="btn" data-act="download-file">${uiIcons.download} Download</button>`;
    const typeCreatorFields = `<div class="preview-fields">
        ${typeInputs}
        ${attrBoxes ? `<div class="preview-attrs">${attrBoxes}</div>` : ''}
        <div class="preview-actions">
          ${expandBtn}
          ${previewBtn}
          ${downloadBtn}
          ${applyBtn}
          ${rsrcBtn}
          ${winRsrcBtn}
        </div>
      </div>`;
    const colAttrs =
      opts.variant === 'column'
        ? ` style="${this.colWidthStyle('preview')}"`
        : '';
    const resizer = opts.variant === 'column' ? this.colResizerHtml('preview') : '';
    const paneOpen = opts.variant === 'column' ? `<div class="column-pane">` : '';
    const paneClose = opts.variant === 'column' ? `</div>` : '';
    if (!node.isDir && (caps.resourceFork || isWinVersionName(node.name))) this.ensureVersInfo(node);
    const dateLabel: Record<string, string> = {
      created: 'Created',
      modified: 'Modified',
      accessed: 'Accessed',
      backup: 'Backup',
    };
    const dateVal = (field: string): number | undefined => {
      if (field === 'created') return node.createDate;
      if (field === 'modified') return node.modDate;
      if (field === 'accessed') return node.accessDate;
      if (field === 'backup') return node.backupDate;
      return undefined;
    };
    const dateRows = caps.dates
      .map((d) => {
        const ms = dateVal(d);
        return `<div class="preview-row"><span>${dateLabel[d] ?? d}</span><span>${ms ? unixDate(ms).toLocaleString() : '—'}</span></div>`;
      })
      .join('');
    const extraNames = caps.names
      .filter((k) => k !== 'long')
      .map((k) => {
        const val = k === 'short' ? node.shortName : node.mediumName;
        if (!val) return '';
        return `<div class="preview-row"><span>${k === 'short' ? 'Short name' : 'Medium name'}</span><span>${this.escape(val)}</span></div>`;
      })
      .join('');
    const sizeBytes = node.isDir ? 0 : nodeByteSize(node, caps.resourceFork);
    const dataDl = showForkDownloads
      ? this.forkDownloadBtn('download-data', 'Download data fork')
      : '';
    const resDl = showForkDownloads
      ? this.forkDownloadBtn('download-resource', 'Download resource fork')
      : '';
    const resRow =
      !node.isDir && caps.resourceFork
        ? `<div class="preview-row"><span>Resource</span><span class="preview-row__value">${formatBytes(node.resourceBytes ?? node.resource.length)}${resDl}</span></div>`
        : '';
    const flagRows = caps.finderInfo ? this.finderFlagRowsHtml(node) : '';
    return `<div class="${shellClass}" data-preview data-id="${refKey(nodeRef(node))}"${colAttrs}>
      ${paneOpen}
      <div class="preview-hero">
        ${glyph}
        <div class="preview-title" aria-label="${this.escape(node.name)}">${this.escape(node.name)}</div>
      </div>
      <div class="preview-meta">
        <div class="preview-row"><span>Kind</span><span>${kind}</span></div>
        <div class="preview-row"><span>Where</span><span>${this.escape(this.displayStorePath(node))}</span></div>
        <div class="preview-row"><span>Size</span><span class="preview-row__value">${node.isDir ? '—' : formatBytes(sizeBytes)}${dataDl}</span></div>
        ${resRow}
        ${dateRows}
        ${extraNames}
        ${flagRows}
        <div data-role="vers-slot">${caps.resourceFork || isWinVersionName(node.name) ? this.versRowsHtml(node) : ''}</div>
        <div data-role="comment-slot">${caps.resourceFork ? this.commentRowHtml(node) : ''}</div>
      </div>
      ${typeCreatorFields}
      ${paneClose}
      ${resizer}
    </div>`;
  }

  /** Info/preview panel shown in place of `itemInfoHtml` when multiple items are selected. */
  private multiSelectionInfoHtml(opts: { variant: 'column' | 'dialog' }): string {
    const nodes = this.selectedNodes();
    const count = this.selectedIds.size;
    const caps = this.caps();
    const folders = nodes.filter((n) => n.isDir).length;
    const files = nodes.length - folders;
    const kindLabel =
      files && folders
        ? `${files} file${files === 1 ? '' : 's'}, ${folders} folder${folders === 1 ? '' : 's'}`
        : folders
          ? `${folders} folder${folders === 1 ? '' : 's'}`
          : `${files} file${files === 1 ? '' : 's'}`;
    const totalBytes = nodes.reduce((sum, n) => sum + nodeByteSize(n, caps.resourceFork), 0);
    const shellClass =
      opts.variant === 'column' ? 'column column-preview item-info' : 'item-info item-info--dialog';
    const colAttrs = opts.variant === 'column' ? ` style="${this.colWidthStyle('preview')}"` : '';
    const resizer = opts.variant === 'column' ? this.colResizerHtml('preview') : '';
    const paneOpen = opts.variant === 'column' ? `<div class="column-pane">` : '';
    const paneClose = opts.variant === 'column' ? `</div>` : '';
    const expandBtn = this.allSelectedExpandable()
      ? `<button type="button" class="btn" data-act="expand">Expand</button>`
      : '';
    return `<div class="${shellClass}" data-preview data-preview-multi="1"${colAttrs}>
      ${paneOpen}
      <div class="preview-hero">
        <div class="preview-glyph preview-glyph--multi"></div>
        <div class="preview-title">${count} items selected</div>
      </div>
      <div class="preview-meta">
        <div class="preview-row"><span>Kind</span><span>${this.escape(kindLabel)}</span></div>
        <div class="preview-row"><span>Size</span><span>${formatBytes(totalBytes)}</span></div>
      </div>
      <div class="preview-fields">
        <div class="preview-actions">
          ${expandBtn}
          <button type="button" class="btn" data-act="download">Download Zip</button>
        </div>
      </div>
      ${paneClose}
      ${resizer}
    </div>`;
  }

  private displayStorePath(node: VNode): string {
    const caps = this.caps();
    const chrome = volumeChrome(caps);
    const vol = this.pathStack[0]?.name || this.localShareTitle();
    const store =
      node.addr === 'path'
        ? node.path
        : [...this.pathStack.slice(1).map((p) => p.name), node.name].filter(Boolean).join('/');
    return formatStorePath(store, chrome.pathFormat, vol);
  }

  private versStamp(node: VNode): string {
    return `${node.modDate}:${node.resourceBytes ?? node.resource.length}:${node.dataBytes ?? node.data.length}`;
  }

  private cachedVersInfo(node: VNode): VersGetInfo | null | undefined {
    const hit = this.versInfo.get(nodeRef(node));
    if (!hit || hit.stamp !== this.versStamp(node)) return undefined;
    return hit.info;
  }

  private finderFlagRowsHtml(node: VNode): string {
    const { type } = readTypeCreator(node.finderInfo);
    const details = finderGetInfoDetails(node.finderInfo, {
      attributes: node.attributes,
      type: node.isDir ? undefined : type,
      isDir: node.isDir,
    });
    const tags = finderFlagLabels(details);
    const rows: string[] = [];
    if (tags.length) {
      rows.push(
        `<div class="preview-row" data-finder="flags"><span>Flags</span><span>${this.escape(tags.join(' · '))}</span></div>`,
      );
    }
    if (details.label) {
      rows.push(
        `<div class="preview-row" data-finder="label"><span>Label</span><span class="preview-label"><span class="preview-label-swatch" style="background:${this.escape(details.label.color)}"></span>${this.escape(details.label.name)}</span></div>`,
      );
    }
    return rows.join('');
  }

  private commentRowHtml(node: VNode): string {
    const comment = this.cachedComment(node);
    if (!comment) return '';
    return `<div class="preview-row preview-row--block" data-finder="comment"><span>Comments</span><span>${this.escape(comment)}</span></div>`;
  }

  private cachedComment(node: VNode): string | null | undefined {
    const hit = this.commentInfo.get(nodeRef(node));
    if (!hit || hit.stamp !== this.versStamp(node)) return undefined;
    return hit.comment;
  }

  private versRowsHtml(node: VNode): string {
    const info = this.cachedVersInfo(node);
    if (!info) return '';
    return this.versRowsMarkup(info);
  }

  private versRowsMarkup(info: VersGetInfo): string {
    const rows: string[] = [];
    const push = (key: string, label: string, value: string | undefined, block = false) => {
      if (!value) return;
      const cls = block ? ' preview-row--block' : '';
      rows.push(
        `<div class="preview-row${cls}" data-vers="${key}"><span>${label}</span><span>${this.escape(value)}</span></div>`,
      );
    };
    push('version', 'Version', info.version);
    push('product-version', 'Product version', info.productVersion);
    push('product', 'Product', info.product);
    push('description', 'Description', info.description, true);
    push('company', 'Company', info.company);
    push('copyright', 'Copyright', info.copyright, true);
    return rows.join('');
  }

  private ensureVersInfo(node: VNode): void {
    if (node.isDir) return;
    if (this.cachedVersInfo(node) !== undefined && this.cachedComment(node) !== undefined) return;
    if (this.versPending.has(nodeRef(node))) return;
    const winVer = isWinVersionName(node.name);
    const rsrcHint = node.resourceBytes ?? node.resource.length;
    const dataHint = node.dataBytes ?? node.data.length;
    if (!winVer && rsrcHint < 16 && node.resource.length < 16 && node.data.length < 16) return;
    if (winVer && dataHint < 64 && rsrcHint < 16 && node.data.length < 64) return;
    this.versPending.add(nodeRef(node));
    void this.loadVersInfo(node);
  }

  private async loadVersInfo(node: VNode): Promise<void> {
    const stamp = this.versStamp(node);
    try {
      const extra = await this.readGetInfoExtras(node);
      const mac = extra.vers ? versInfoForGetInfo(extra.vers) : null;
      this.versInfo.set(nodeRef(node), { stamp, info: this.mergeGetInfoVersion(mac, extra.win) });
      this.commentInfo.set(nodeRef(node), { stamp, comment: extra.comment });
      this.patchVersInDom(nodeRef(node));
      this.patchCommentInDom(nodeRef(node));
    } catch {
      this.versInfo.set(nodeRef(node), { stamp, info: null });
      this.commentInfo.set(nodeRef(node), { stamp, comment: null });
    } finally {
      this.versPending.delete(nodeRef(node));
    }
  }

  private mergeGetInfoVersion(mac: VersGetInfo | null, win: WinVersionGetInfo | null): VersGetInfo | null {
    if (!mac && !win) return null;
    const version = mac?.version || win?.version || '';
    const copyright = mac?.copyright || win?.copyright || '';
    const productVersion = win?.productVersion && win.productVersion !== version ? win.productVersion : '';
    const info: VersGetInfo = {
      version,
      copyright,
      product: win?.product || '',
      productVersion,
      description: win?.description || '',
      company: win?.company || '',
    };
    if (!info.version && !info.copyright && !info.product && !info.description && !info.company) return null;
    return info;
  }

  private async readGetInfoExtras(
    node: VNode,
  ): Promise<{ vers: VersRec | null; comment: string | null; win: WinVersionGetInfo | null }> {
    const { cat, node: native } = await this.nativeNode(node);
    const wantFork = this.capsForNode(node).resourceFork;
    let vers: VersRec | null = null;
    let comment: string | null = null;
    if (wantFork) {
      const cid = finderCommentId(node.finderInfo);
      const want = (type: string, id: number): boolean => {
        if (type === 'vers' && id === 1) return true;
        if (type !== 'FCMT') return false;
        return id === 1 || (cid !== 0 && id === cid);
      };
      let rf = await cat.loadResourceFork(native, { want });
      if (!rf) rf = await cat.loadResourceFork(native, { fork: 'data', want });
      if (rf) {
        vers = decodeVers1(rf);
        comment = finderCommentFromFork(rf, node.finderInfo);
      }
    }
    let win: WinVersionGetInfo | null = null;
    if (isWinVersionName(node.name)) {
      try {
        win = await cat.withRangeReader(native, (read) => extractWinVersion(read), { resource: false });
      } catch {
        win = null;
      }
    }
    return { vers, comment, win };
  }

  private patchVersInDom(id: NodeRef): void {
    const hit = this.versInfo.get(id);
    const markup = hit?.info ? this.versRowsMarkup(hit.info) : '';
    this.querySelectorAll(`[data-preview][data-id="${selRef(id)}"] [data-role="vers-slot"]`).forEach((el) => {
      el.innerHTML = markup;
    });
    this.getInfoWindow
      ?.querySelectorAll(`[data-preview][data-id="${selRef(id)}"] [data-role="vers-slot"]`)
      .forEach((el) => {
        el.innerHTML = markup;
      });
    if (markup) this.getInfoWindow?.fitToContents();
  }

  private patchCommentInDom(id: NodeRef): void {
    const hit = this.commentInfo.get(id);
    const markup = hit?.comment
      ? `<div class="preview-row preview-row--block" data-finder="comment"><span>Comments</span><span>${this.escape(hit.comment)}</span></div>`
      : '';
    this.querySelectorAll(`[data-preview][data-id="${selRef(id)}"] [data-role="comment-slot"]`).forEach((el) => {
      el.innerHTML = markup;
    });
    this.getInfoWindow
      ?.querySelectorAll(`[data-preview][data-id="${selRef(id)}"] [data-role="comment-slot"]`)
      .forEach((el) => {
        el.innerHTML = markup;
      });
    if (markup) this.getInfoWindow?.fitToContents();
  }

  /** Resolve icon for a single node and patch list + properties glyphs. */
  private ensureNodeIcon(node: VNode): void {
    const key = refKey(nodeRef(node));
    if (this.iconUrls.has(key)) return;
    const gen = this.iconLoadGen;
    void (async () => {
      try {
        await iconCache.init();
        const urls = await this.iconLookup(node);
        if (gen !== this.iconLoadGen) return;
        if (node.isDir && isDefaultFolderIcon(urls)) return;
        this.iconUrls.set(key, urls);
        this.patchIconInDom(key, urls);
      } catch {
        /* keep placeholder */
      }
    })();
  }

  private colWidthPx(key: string): number {
    const fallback = key === 'preview' ? 240 : 200;
    return this.columnWidths.get(key) ?? fallback;
  }

  private colWidthStyle(key: string): string {
    return `--col-width:${this.colWidthPx(key)}px`;
  }

  private colResizerHtml(key: string): string {
    if (isCompactUi()) return '';
    return `<div class="column-resizer" data-col-resize="${key}" role="separator" aria-orientation="vertical"></div>`;
  }

  private columnHtml(colIndex: number, body: string, extraClass = ''): string {
    const key = String(colIndex);
    const loading = extraClass.includes('column--loading');
    const cls = extraClass ? `column ${extraClass}` : 'column';
    return `<div class="${cls}" data-col-index="${colIndex}"${loading ? ' aria-busy="true"' : ''} style="${this.colWidthStyle(key)}"><div class="column-pane">${body}</div>${this.colResizerHtml(key)}</div>`;
  }

  private mountColumnEl(colIndex: number, body: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'column';
    el.setAttribute('data-col-index', String(colIndex));
    el.style.setProperty('--col-width', `${this.colWidthPx(String(colIndex))}px`);
    el.innerHTML = `<div class="column-pane">${body}</div>${this.colResizerHtml(String(colIndex))}`;
    return el;
  }

  private columnPaneBody(kids: VNode[], colIndex: number, selectedIds: Set<NodeRef>): string {
    const parentId = this.pathStack[colIndex]?.id ?? this.cwd;
    const items = this.mergeWritingItems(parentId, kids.map((n) => this.listItemFromNode(n)));
    if (items.length === 0) {
      return `<div class="empty" style="padding:16px;font-size:12px">Empty</div>`;
    }
    return items.map((it) => this.colItemHtml(it, colIndex, selectedIds)).join('');
  }

  /** Replace a loading column (or refresh its pane) without remounting earlier columns. */
  private paintColumnKids(view: Element, parentColIndex: number, kids: VNode[]): void {
    const colIndex = parentColIndex + 1;
    const body = this.columnPaneBody(kids, colIndex, new Set());
    const loadingCol = view.querySelector('.column--loading');
    if (loadingCol) {
      loadingCol.replaceWith(this.mountColumnEl(colIndex, body));
      return;
    }
    const pane = view.querySelector(`[data-col-index="${colIndex}"] .column-pane`);
    if (pane) {
      pane.innerHTML = body;
      return;
    }
    view.querySelector(`[data-col-index="${parentColIndex}"]`)?.after(this.mountColumnEl(colIndex, body));
  }

  private onColumnResizeDown(e: PointerEvent): void {
    const handle = (e.target as HTMLElement | null)?.closest?.('[data-col-resize]') as HTMLElement | null;
    if (!handle || isCompactUi()) return;
    e.preventDefault();
    e.stopPropagation();
    const col = handle.closest('.column') as HTMLElement | null;
    if (!col) return;
    const key = handle.getAttribute('data-col-resize') ?? '0';
    this.columnResize = {
      col,
      handle,
      key,
      startX: e.clientX,
      startW: col.getBoundingClientRect().width,
    };
    handle.classList.add('dragging');
    this.querySelector('.column-view')?.classList.add('is-resizing');
    handle.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', this.onColumnResizeMove);
    window.addEventListener('pointerup', this.onColumnResizeUp);
    window.addEventListener('pointercancel', this.onColumnResizeUp);
  }

  private onColumnResizeMove = (e: PointerEvent): void => {
    if (!this.columnResize) return;
    e.preventDefault();
    const w = Math.round(
      Math.max(140, Math.min(560, this.columnResize.startW + (e.clientX - this.columnResize.startX))),
    );
    this.columnWidths.set(this.columnResize.key, w);
    this.columnResize.col.style.setProperty('--col-width', `${w}px`);
  };

  private onColumnResizeUp = (): void => {
    if (!this.columnResize) return;
    this.columnResize.handle.classList.remove('dragging');
    this.querySelector('.column-view')?.classList.remove('is-resizing');
    this.columnResize = null;
    window.removeEventListener('pointermove', this.onColumnResizeMove);
    window.removeEventListener('pointerup', this.onColumnResizeUp);
    window.removeEventListener('pointercancel', this.onColumnResizeUp);
  };

  private renderColumnView(): string {
    if (this.columnChildren.length === 0) {
      if (this.columnLoading || this.enumeratingFolderId != null) {
        return `<div class="column-view">${this.columnLoadingHtml(0)}</div>`;
      }
      return `<div class="column-view">${this.columnHtml(0, `<div class="empty">${this.escape(this.emptyPaneMessage())}</div>`)}</div>`;
    }
    const listColCount = this.columnChildren.length;
    const cols = this.columnChildren
      .map((kids, colIndex) => {
        const selectedInColumn = this.columnSelectionIds(colIndex, kids, listColCount);
        const parentId = this.pathStack[colIndex]?.id ?? this.cwd;
        const items = this.mergeWritingItems(parentId, kids.map((n) => this.listItemFromNode(n)));
        const body =
          items.length === 0
            ? `<div class="empty" style="padding:16px;font-size:12px">Empty</div>`
            : items.map((it) => this.colItemHtml(it, colIndex, selectedInColumn)).join('');
        return this.columnHtml(colIndex, body);
      })
      .join('');

    const loadingCol = this.columnLoading
      ? this.columnLoadingHtml(listColCount)
      : '';
    const multi = this.selectedIds.size > 1;
    const preview = this.columnLoading || multi ? null : this.columnPreviewNode();
    const previewCol = multi
      ? this.multiSelectionInfoHtml({ variant: 'column' })
      : preview
        ? this.itemInfoHtml(preview, { variant: 'column' })
        : '';
    return `<div class="column-view">${cols}${loadingCol}${previewCol}</div>`;
  }

  private spinnerHtml(extraClass = ''): string {
    return `<span class="status-spinner${extraClass ? ` ${extraClass}` : ''}" aria-hidden="true"></span>`;
  }

  private columnLoadingHtml(colIndex: number): string {
    const parentId = this.pathStack[colIndex]?.id ?? this.enumeratingFolderId ?? this.cwd;
    const items = this.mergeWritingItems(parentId, []);
    const body = [...items, this.listingPlaceholderItem()]
      .map((it) => this.colItemHtml(it, colIndex, new Set()))
      .join('');
    return this.columnHtml(colIndex, body, 'column--loading');
  }

  private nextFolderLoad(id: NodeRef): number {
    const g = (this.folderLoadGen.get(id) ?? 0) + 1;
    this.folderLoadGen.set(id, g);
    return g;
  }

  private folderLoadIsCurrent(id: NodeRef, gen: number): boolean {
    return this.folderLoadGen.get(id) === gen;
  }

  private itemFromEvent(e: Event): HTMLElement | null {
    const t = e.target as HTMLElement | null;
    return t?.closest?.('[data-id]') as HTMLElement | null;
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const t = e.target as HTMLElement;

    // Ignore clicks inside rename / type-creator fields (handled by blur/enter)
    if (t.closest('[data-rename], [data-prop], [data-col-resize]')) return;

    const ctxItem = t.closest('[data-ctx]') as HTMLElement | null;
    if (ctxItem) {
      e.preventDefault();
      const action = ctxItem.getAttribute('data-ctx')!;
      const ctxTarget = this.contextMenu?.targetId ?? null;
      const sidebar = this.contextMenu?.sidebar;
      this.contextMenu = null;
      this.renderContextMenu();
      if (sidebar) {
        const ep = this.servers[sidebar.index];
        if (action === 'disconnect') {
          if (ep && ep.id !== this.remoteEndpoint?.id && ep.id !== this.remoteNbpName) {
            await this.host.onSidebarAction?.(ep, 'disconnect');
            this.forgetEndpoint(ep.id);
            this.renderSidebar();
            return;
          }
          await this.disconnectRemote();
          return;
        }
        if (action === 'eject' || action === 'unmount') {
          if (sidebar.volume) await this.ejectVolume(sidebar.volume);
          else if (ep) await this.ejectEndpoint(ep);
          return;
        }
        if (action === 'info' || action === 'share-info') {
          if (ep) this.showEndpointGetInfo(ep, sidebar.volume);
          return;
        }
        if (ep) await this.host.onSidebarAction?.(ep, action, sidebar.volume);
        return;
      }
      await this.handleContextAction(action, ctxTarget);
      return;
    }
    if (this.contextMenu) {
      this.contextMenu = null;
      this.renderContextMenu();
    }

    const locCrumb = t.closest('[data-loc]') as HTMLElement | null;
    if (locCrumb) {
      e.preventDefault();
      if (locCrumb.classList.contains('current')) return;
      const kind = locCrumb.getAttribute('data-loc');
      if (kind === 'network') {
        await this.showNetworkBrowser(locCrumb.getAttribute('data-network-path') || '');
        this.syncHistory();
        this.render();
        return;
      }
      if (kind === 'server') {
        if (this.remoteEndpoint) {
          await this.showServerSharesFolder(this.remoteEndpoint);
          this.syncHistory();
          this.render();
        }
        return;
      }
      if (kind === 'volume') {
        await this.navigateToPathIndex(0);
        return;
      }
      if (kind === 'node') {
        const index = Number(locCrumb.getAttribute('data-path-index'));
        if (Number.isFinite(index)) await this.navigateToPathIndex(index);
        return;
      }
      return;
    }
    const pathCrumb = t.closest('[data-path-index]') as HTMLElement | null;
    if (pathCrumb) {
      e.preventDefault();
      const index = Number(pathCrumb.getAttribute('data-path-index'));
      if (index >= this.pathStack.length - 1) return;
      await this.navigateToPathIndex(index);
      return;
    }

    const sortCol = t.closest('[data-sort-col]') as HTMLElement | null;
    if (sortCol) {
      e.preventDefault();
      const key = (sortCol.getAttribute('data-sort-col') as SortKey) || 'name';
      await this.applySort(key);
      return;
    }

    const calloutAct = t.closest('[data-callout-act]')?.getAttribute('data-callout-act');
    if (calloutAct) {
      e.preventDefault();
      const target = this.openCallout === 'share' ? null : this.selectedId;
      const local = this.openCallout === 'share';
      this.openCallout = null;
      this.renderCallouts();
      if (local) await this.handleContextAction(calloutAct, null);
      else await this.handleContextAction(calloutAct, target);
      return;
    }

    const actEl = t.closest('[data-act]') as HTMLElement | null;
    const act = actEl?.getAttribute('data-act');
    if (act === 'cancel-transfer') {
      e.preventDefault();
      e.stopPropagation();
      const jobId = actEl?.getAttribute('data-job');
      if (jobId) transferActivity.cancel(jobId);
      return;
    }
    if (act === 'refresh') {
      await this.onRefresh(actEl?.getAttribute('data-refresh') || undefined);
      return;
    }
    if (act) {
      await this.handleAction(act);
      return;
    }
    const viewBtn = t.closest('[data-view]');
    if (viewBtn) {
      const next = (viewBtn.getAttribute('data-view') as ViewMode) || 'icon';
      await this.setView(next);
      return;
    }
    if (t.closest('[data-local]')) {
      if (!this.hasLocalShare()) return;
      this.showLocalShare();
      this.closeSidebar();
      await this.reload();
      this.syncHistory();
      this.render();
      return;
    }
    if (t.closest('[data-network]')) {
      if (!this.networkBrowserEnabled()) return;
      await this.showNetworkBrowser();
      this.closeSidebar();
      this.syncHistory();
      this.render();
      return;
    }
    const ejectEl = t.closest('[data-eject]');
    if (ejectEl) {
      e.preventDefault();
      e.stopPropagation();
      const name =
        ejectEl.getAttribute('data-vol-name') ||
        this.remoteVolumes[Number(ejectEl.getAttribute('data-eject'))];
      if (name) await this.ejectVolume(name);
      return;
    }
    const ejectEpEl = t.closest('[data-eject-endpoint]');
    if (ejectEpEl) {
      e.preventDefault();
      e.stopPropagation();
      const i = Number(ejectEpEl.getAttribute('data-eject-endpoint'));
      const ep = this.servers[i];
      if (ep) await this.ejectEndpoint(ep);
      return;
    }
    const disconnectEl = t.closest('[data-disconnect]');
    if (disconnectEl) {
      e.preventDefault();
      e.stopPropagation();
      const i = Number(disconnectEl.getAttribute('data-disconnect'));
      const ep = this.servers[i];
      if (ep && ep.id !== this.remoteEndpoint?.id && ep.id !== this.remoteNbpName) {
        await this.host.onSidebarAction?.(ep, 'disconnect');
        this.forgetEndpoint(ep.id);
        this.renderSidebar();
        return;
      }
      await this.disconnectRemote();
      return;
    }
    const volEl = t.closest('[data-vol]');
    if (volEl) {
      const parentI = Number(volEl.getAttribute('data-server-parent'));
      const parent = Number.isFinite(parentI) ? this.servers[parentI] : this.remoteEndpoint;
      const name =
        volEl.getAttribute('data-vol-name') ||
        this.remoteVolumes[Number(volEl.getAttribute('data-vol'))];
      if (!name || !parent) return;
      if (this.remoteBusy) return;
      try {
        const ok = await this.connectServerWithLogin(parent, name, { locationMode: 'server' });
        if (!ok) return;
        this.closeSidebar();
        if (this.remoteOpen) {
          await this.reload();
          this.syncHistory();
        }
        this.render();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Open volume failed: ${msg}`, 'afp');
        this.setStatus(`Open volume failed: ${msg}`);
      }
      return;
    }
    const serverEl = t.closest('[data-server]');
    if (serverEl) {
      const i = Number(serverEl.getAttribute('data-server'));
      const s = this.servers[i];
      if (!s) return;
      if (this.remoteBusy) return;
      if (this.viewingEndpoint(s)) {
        this.closeSidebar();
        await this.reload();
        this.syncHistory();
        this.render();
        return;
      }
      if (!isCatalogEndpoint(s) && this.loggedInEndpoints.has(s.id) && !this.remoteBusy) {
        await this.showServerSharesFolder(s);
        this.closeSidebar();
        this.syncHistory();
        this.render();
        return;
      }
      const openOpts = isCatalogEndpoint(s)
        ? { autoOpenSingle: true, listShares: false, locationMode: 'local' as const }
        : { autoOpenSingle: false, listShares: true };
      await this.connectServerWithLogin(s, undefined, openOpts);
      this.closeSidebar();
      if (this.remoteOpen || isNetworkCatalog(this.vfs)) {
        await this.reload();
        this.syncHistory();
      }
      this.render();
      return;
    }

    const disclose = t.closest('[data-disclose]') as HTMLElement | null;
    if (disclose && this.view === 'list') {
      e.preventDefault();
      e.stopPropagation();
      const id = parseRefKey(disclose.getAttribute('data-disclose'));
      if (id == null) return;
      this.selectOnly(id);
      const row = disclose.closest('[data-id]') as HTMLElement | null;
      if (row) this.paintSelection(row);
      await this.toggleExpand(id);
      return;
    }

    const item = this.itemFromEvent(e);
    if (!item || !this.querySelector('.content')?.contains(item)) return;
    if (item.matches('[data-preview], .item-info') || item.closest('[data-preview], .item-info')) return;

    const id = dataRef(item);
    if (id == null) return;
    const isDir = item.getAttribute('data-dir') === '1';
    const isOpen = isDir || item.getAttribute('data-open') === '1';
    const mod = e.metaKey || e.ctrlKey;
    const range = e.shiftKey && !mod;

    if (mod || range) {
      const scope =
        this.view === 'column' ? (item.closest('[data-col-index]') ?? this.contentEl()) : this.contentEl();
      if (scope) this.applyMultiSelectClick(id, scope, { mod, range });
      return;
    }

    const wasSelected = this.selectedId === id && this.selectedIds.size === 1;
    this.selectOnly(id);

    if (isCompactUi() && this.view !== 'column' && isOpen && wasSelected) {
      const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
      if (node && isNetworkOpenable(node)) await this.openFolder(node);
      return;
    }

    if (this.view === 'column') {
      this.syncResourceExplorer();
      const colIndex = Number(item.getAttribute('data-col') ?? '0');
      const beforePath = this.pathNamesForUrl().join('/');
      this.pathStack = this.pathStack.slice(0, colIndex + 1);
      this.columnChildren = this.columnChildren.slice(0, colIndex + 1);
      if (isDir) {
        const node = this.findInColumns(id) ?? this.findNodeAnywhere(id);
        if (node && (await this.activateNetworkNode(node))) return;
        if (node && isNetworkNavigable(node)) {
          this.pathStack.push({ id: nodeRef(node), name: node.name });
          this.cwd = nodeRef(node);
          await this.loadColumnFolder(nodeRef(node), colIndex);
        } else {
          this.columnLoading = true;
          this.renderPath();
          this.renderContent();
          const fetched = await this.vfs.get(id);
          if (fetched && (await this.activateNetworkNode(fetched))) return;
          if (fetched && isNetworkNavigable(fetched)) {
            this.pathStack.push({ id: nodeRef(fetched), name: fetched.name });
            this.cwd = nodeRef(fetched);
            await this.loadColumnFolder(nodeRef(fetched), colIndex);
          } else {
            this.columnLoading = false;
            this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
            this.renderPath();
            this.renderContent();
          }
        }
      } else {
        const node = this.findInColumns(id) ?? this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
        if (node && (await this.activateNetworkNode(node))) return;
        this.columnLoading = false;
        this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
        this.nodes = this.columnChildren[this.columnChildren.length - 1] ?? this.nodes;
        this.renderPath();
        this.paintColumnSelection();
      }
      if (beforePath !== this.pathNamesForUrl().join('/')) this.syncHistory();
      return;
    }

    this.paintSelection(item);
    // Don't remount the file plane when Properties is open — preserves dblclick.
    if (this.showProps) this.refreshPropsPanel();
  }

  private async loadColumnFolder(folderId: NodeRef, parentColIndex: number): Promise<void> {
    const signal = this.beginNavListing();
    this.columnLoadGen++;
    const gen = this.columnLoadGen;
    this.enumeratingFolderId = folderId;
    this.columnLoading = true;
    this.renderPath();
    this.renderContent();
    try {
      const kids = await this.streamChildren(
        folderId,
        (partial) => {
          if (gen !== this.columnLoadGen || signal.aborted) return;
          this.columnChildren = this.columnChildren.slice(0, parentColIndex + 1);
          this.columnChildren.push(partial);
          this.nodes = partial;
          this.columnLoading = false;
          this.renderPath();
          this.renderContent();
        },
        signal,
      );
      if (gen !== this.columnLoadGen || signal.aborted) return;
      this.columnChildren = this.columnChildren.slice(0, parentColIndex + 1);
      this.columnChildren.push(kids);
      this.nodes = kids;
    } catch (err) {
      if (gen !== this.columnLoadGen) return;
      if (isListingCancelled(err)) {
        if (!isAbortError(err)) {
          this.pathStack = this.pathStack.slice(0, parentColIndex + 1);
          this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
        }
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Couldn’t open folder: ${msg}`);
      this.pathStack = this.pathStack.slice(0, parentColIndex + 1);
      this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
    } finally {
      if (gen === this.columnLoadGen && !signal.aborted) {
        this.columnLoading = false;
        if (this.enumeratingFolderId === folderId) this.enumeratingFolderId = null;
      }
    }
    if (gen !== this.columnLoadGen) return;
    this.renderPath();
    this.renderContent();
  }

  private async toggleExpand(id: NodeRef): Promise<void> {
    const row = this.querySelector(`tr[data-id="${selRef(id)}"]`) as HTMLTableRowElement | null;
    const disclose = row?.querySelector('[data-disclose]') as HTMLElement | null;
    if (this.dragDepth === 0 && this.dragNodeId == null) {
      this.querySelectorAll('.list-table tr.drop-target').forEach((el) => el.classList.remove('drop-target'));
    }

    if (this.expandedIds.has(id)) {
      this.expandedIds.delete(id);
      this.loadingIds.delete(id);
      this.abortExpandListing(id);
      this.nextFolderLoad(id);
      this.collapseDescendants(id);
      this.setDiscloseState(disclose, 'closed');
      if (row) this.removeListChildRows(row);
      else this.renderContent();
      this.refreshFolderGlyph(id);
      return;
    }
    this.expandedIds.add(id);
    this.selectOnly(id);
    if (row) {
      this.paintSelection(row);
      if (this.dragDepth === 0 && this.dragNodeId == null) row.classList.remove('drop-target');
    }
    this.setDiscloseState(disclose, 'open');

    const cached = this.listChildCache.get(id);
    if (cached) {
      if (row) this.insertListChildRows(row, cached, id);
      else this.renderContent();
      return;
    }
    const gen = this.nextFolderLoad(id);
    this.loadingIds.add(id);
    this.setDiscloseState(disclose, 'loading');
    this.refreshFolderGlyph(id);
    if (row) this.insertListingPlaceholderRow(row);
    else this.renderContent();
    const signal = this.beginExpandListing(id);
    try {
      const kids = await this.streamChildren(
        id,
        (partial) => {
          if (!this.folderLoadIsCurrent(id, gen) || !this.expandedIds.has(id)) return;
          this.listChildCache.set(id, partial);
          const live = this.querySelector(`tr[data-id="${selRef(id)}"]`) as HTMLTableRowElement | null;
          if (live?.parentElement) this.replaceListChildRows(live, partial, id);
          else this.renderContent();
        },
        signal,
      );
      if (!this.folderLoadIsCurrent(id, gen)) return;
      this.listChildCache.set(id, kids);
    } catch (err) {
      if (!this.folderLoadIsCurrent(id, gen) || isListingCancelled(err)) {
        if (this.folderLoadIsCurrent(id, gen) && !isAbortError(err)) {
          this.expandedIds.delete(id);
          this.setDiscloseState(disclose, 'closed');
        }
        return;
      }
      this.expandedIds.delete(id);
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Couldn’t expand folder: ${msg}`);
      this.setDiscloseState(disclose, 'closed');
    } finally {
      if (this.folderLoadIsCurrent(id, gen)) this.loadingIds.delete(id);
    }
    if (!this.folderLoadIsCurrent(id, gen)) return;
    this.refreshFolderGlyph(id);
    const live = this.querySelector(`tr[data-id="${selRef(id)}"]`) as HTMLTableRowElement | null;
    if (live?.parentElement && this.expandedIds.has(id)) {
      this.replaceListChildRows(live, this.listChildCache.get(id) ?? [], id);
    } else this.renderContent();
  }

  private setDiscloseState(disclose: Element | null, state: 'open' | 'closed' | 'loading'): void {
    if (!(disclose instanceof HTMLElement)) return;
    disclose.classList.toggle('open', state !== 'closed');
    disclose.classList.toggle('loading', state === 'loading');
    disclose.setAttribute('aria-busy', String(state === 'loading'));
    disclose.setAttribute(
      'aria-label',
      state === 'loading' ? 'Loading' : state === 'open' ? 'Collapse' : 'Expand',
    );
    if (!disclose.querySelector('svg')) disclose.innerHTML = uiIcons.disclose;
  }

  private removeListChildRows(row: HTMLTableRowElement): void {
    const depth = Number(String(row.style.getPropertyValue('--depth') || '0'));
    let next = row.nextElementSibling as HTMLTableRowElement | null;
    while (next) {
      const d = Number(String(next.style.getPropertyValue('--depth') || '0'));
      if (d <= depth) break;
      const remove = next;
      next = next.nextElementSibling as HTMLTableRowElement | null;
      remove.remove();
    }
  }

  private collapseDescendants(id: NodeRef): void {
    const kids = this.listChildCache.get(id) ?? [];
    for (const k of kids) {
      if (k.isDir && this.expandedIds.has(nodeRef(k))) {
        this.expandedIds.delete(nodeRef(k));
        this.abortExpandListing(nodeRef(k));
        this.collapseDescendants(nodeRef(k));
      }
    }
  }

  private findInColumns(id: NodeRef): VNode | undefined {
    for (const col of this.columnChildren) {
      const n = col.find((x) => refsEqual(nodeRef(x), id));
      if (n) return n;
    }
    return this.nodes.find((n) => nodeRef(n) === id);
  }

  private paintSelection(item: HTMLElement): void {
    this.querySelectorAll('.selected').forEach((el) => {
      if (el.classList.contains('side-item')) return;
      el.classList.remove('selected');
    });
    item.classList.add('selected');
    this.syncClipboardButtons();
    this.syncResourceExplorer();
  }

  private async onDblClick(e: MouseEvent): Promise<void> {
    const t = e.target as HTMLElement;
    if (t.closest('.finder-chrome') && !t.closest('button, select, label, input, a')) {
      e.preventDefault();
      this.toggleMaximized();
      return;
    }
    const item = this.itemFromEvent(e);
    if (!item || !this.querySelector('.content')?.contains(item)) return;
    if (item.getAttribute('data-dir') !== '1' && item.getAttribute('data-open') !== '1') return;
    if (this.view === 'column') return;
    if ((e.target as HTMLElement).closest?.('[data-disclose]')) return;

    e.preventDefault();
    const id = dataRef(item);
    if (id == null) return;

    const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
    if (!node || !isNetworkOpenable(node)) return;
    await this.openFolder(node);
  }

  private async openFolder(node: VNode): Promise<void> {
    if (await this.activateNetworkNode(node)) return;
    if (!isNetworkNavigable(node)) return;
    const openedId = nodeRef(node);
    const prevCwd = this.cwd;
    const prevStack = this.pathStack.slice();
    this.cwd = nodeRef(node);
    this.pathStack.push({ id: nodeRef(node), name: node.name });
    this.clearSelection();
    this.syncResourceExplorer();
    this.expandedIds.clear();
    this.folderOpening = true;
    this.enumeratingFolderId = nodeRef(node);
    this.nodes = [];
    this.renderPath();
    this.renderContent();
    try {
      await this.reload();
    } catch (err) {
      if (this.cwd === openedId) {
        this.pathStack = prevStack;
        this.cwd = prevCwd;
        this.folderOpening = false;
        this.enumeratingFolderId = null;
        if (!isListingCancelled(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          this.setStatus(`Couldn’t open folder: ${msg}`);
        }
        this.renderPath();
        this.renderContent();
      }
      return;
    } finally {
      if (this.cwd === openedId) this.folderOpening = false;
    }
    if (this.cwd !== openedId) return;
    this.renderPath();
    this.renderContent();
    this.syncClipboardButtons();
    this.syncHistory();
  }

  private contentEl(): HTMLElement | null {
    return this.querySelector('.content');
  }

  private onDragStart(e: DragEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('[data-rename], [data-disclose], [data-preview], .item-info, [data-col-resize]')) {
      e.preventDefault();
      return;
    }
    const item = this.itemFromEvent(e);
    if (!item || !this.contentEl()?.contains(item)) {
      e.preventDefault();
      return;
    }
    const id = dataRef(item);
    if (id == null) {
      e.preventDefault();
      return;
    }
    if (isNetworkContainer(this.findNodeAnywhere(id))) {
      e.preventDefault();
      return;
    }
    this.dragNodeId = id;
    this.dragNode = this.findNodeAnywhere(id);
    const handle = this.overlayNative(this.dragNode);
    if (handle) {
      this.dragNodeId = handle.ref;
      this.dragCatalog = handle.cat;
    } else {
      this.dragCatalog = this.vfs;
    }
    // Dragging an item outside the current multi-selection replaces it; dragging
    // a selected item keeps the whole selection intact (matches Finder/Explorer).
    if (!this.selectedIds.has(id)) this.selectOnly(id);
    e.dataTransfer?.setData('application/x-cs-node', String(id));
    e.dataTransfer!.effectAllowed = 'copyMove';
    item.classList.add('dragging');
  }

  private onDragEnd(): void {
    this.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    this.dragNodeId = null;
    this.dragNode = null;
    this.dragCatalog = null;
    this.clearSpringTimer();
    this.clearDropUi();
    this.clearDragPortal();
    this.dragDepth = 0;
  }

  /** Keep the HTML5 drag source in-document while the file plane remounts/truncates. */
  private parkDragSource(): void {
    if (this.dragNodeId == null) return;
    const dragging = this.querySelector('.dragging') as HTMLElement | null;
    const portal = this.querySelector('.drag-portal') as HTMLElement | null;
    if (!dragging || !portal || portal.contains(dragging)) return;
    portal.appendChild(dragging);
  }

  private clearDragPortal(): void {
    const portal = this.querySelector('.drag-portal');
    if (portal) portal.replaceChildren();
  }

  private isExternalFileDrag(e: DragEvent): boolean {
    if (this.dragNodeId != null) return false;
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return [...types].includes('Files');
  }

  private isInternalDrag(): boolean {
    return this.dragNodeId != null;
  }

  private isDropDrag(e: DragEvent): boolean {
    return this.isInternalDrag() || this.isExternalFileDrag(e);
  }

  private onDragEnter(e: DragEvent): void {
    if (!this.isDropDrag(e)) return;
    e.preventDefault();
    this.dragDepth++;
  }

  private onDragOver(e: DragEvent): void {
    if (!this.isDropDrag(e)) return;
    e.preventDefault();
    void this.updateDropHover(e);
  }

  private onDragLeave(e: DragEvent): void {
    if (!this.isDropDrag(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.clearSpringTimer();
      this.clearDropUi();
    }
  }

  /** Folder under cursor for spring-load, else null. */
  private folderUnderPointer(e: DragEvent): HTMLElement | null {
    const item = this.itemFromEvent(e);
    if (!item || !this.contentEl()?.contains(item)) return null;
    if (item.getAttribute('data-dir') !== '1') return null;
    const id = dataRef(item);
    if (this.dragNodeId === id) return null;
    return item;
  }

  /** Parent folder id represented by the column under the pointer. */
  private columnParentFromEvent(e: DragEvent): NodeRef | null {
    if (this.view !== 'column') return null;
    const t = e.target as HTMLElement | null;
    const col = t?.closest?.('[data-col-index]') as HTMLElement | null;
    if (!col || !this.contentEl()?.contains(col)) return null;
    const idx = Number(col.getAttribute('data-col-index'));
    if (!Number.isFinite(idx) || idx < 0) return null;
    return this.pathStack[idx]?.id ?? null;
  }

  /** Folder id from a path-bar crumb under the pointer, if any. */
  private pathDropIdFromEvent(e: DragEvent): NodeRef | null {
    const t = e.target as HTMLElement | null;
    const crumb = t?.closest?.('[data-path-id]') as HTMLElement | null;
    const bar = this.querySelector('.pathbar');
    if (!crumb || !bar?.contains(crumb)) return null;
    return parseRefKey(crumb.getAttribute('data-path-id'));
  }

  private columnIndexFromEvent(e: DragEvent): number | null {
    if (this.view !== 'column') return null;
    const t = e.target as HTMLElement | null;
    const col = t?.closest?.('[data-col-index]') as HTMLElement | null;
    if (!col) return null;
    const idx = Number(col.getAttribute('data-col-index'));
    return Number.isFinite(idx) ? idx : null;
  }

  /** Destination parent id for a drop in the current catalog, or null if invalid. */
  private resolveDropParent(e: DragEvent): NodeRef | null {
    const pathId = this.pathDropIdFromEvent(e);
    if (pathId != null) return pathId;

    const content = this.contentEl();
    if (!content) return null;
    const item = this.itemFromEvent(e);
    if (item && content.contains(item)) {
      const id = dataRef(item);
      if (id == null) return this.columnParentFromEvent(e) ?? this.cwd;
      if (this.dragNodeId === id) return null;
      if (item.getAttribute('data-dir') === '1') return id;
      const node = this.findNodeAnywhere(id);
      if (node) return parentRef(node);
      return this.columnParentFromEvent(e) ?? this.cwd;
    }
    const colParent = this.columnParentFromEvent(e);
    if (colParent != null) return colParent;
    const t = e.target as Node | null;
    if (t && content.contains(t)) return this.cwd;
    return null;
  }

  private currentShareKey(): string {
    if (this.source === 'local') return LOCAL_SHARE_KEY;
    if (this.remoteEndpoint && isCatalogEndpoint(this.remoteEndpoint)) {
      return shareKeyForEndpoint(this.remoteEndpoint);
    }
    return `${this.remoteNbpName}:${this.pathStack[0]?.name ?? ''}`;
  }

  /** Sidebar share under the pointer (Browser Share, ClassicStack share, or mounted volume). */
  private shareDropFromEvent(e: DragEvent): { key: string; name: string } | null {
    return shareDropFromElement(e.target, this.querySelector('.sidebar'));
  }

  private async ensureShareCatalog(key: string): Promise<Catalog | null> {
    if (key === LOCAL_SHARE_KEY) return this.localVfs ?? this.catalogs.get(LOCAL_SHARE_KEY) ?? null;
    const existing = this.catalogs.get(key);
    if (existing) return existing;
    if (key.startsWith('endpoint:')) {
      const id = key.slice('endpoint:'.length);
      const ep = this.servers.find((s) => s.id === id);
      if (!ep || !this.host.openEndpointCatalog) return null;
      const cat = await this.host.openEndpointCatalog(ep);
      this.bindVolumeCatalog(key, cat);
      return cat;
    }
    const prefix = `${this.remoteNbpName}:`;
    if (!this.remoteLoggedIn || !key.startsWith(prefix)) return null;
    const name = key.slice(prefix.length);
    if (!name) return null;
    const cat = await this.host.openVolume(name);
    this.bindVolumeCatalog(key, cat);
    return cat;
  }

  private resolveDropDest(e: DragEvent): {
    catalog: Catalog | null;
    parentId: NodeRef;
    shareKey?: string;
    label: string;
  } | null {
    const share = this.shareDropFromEvent(e);
    if (share) {
      const cat = this.catalogs.get(share.key) ?? (share.key === LOCAL_SHARE_KEY ? (this.localVfs ?? null) : null);
      return {
        catalog: cat,
        parentId: cat?.rootId() ?? 0,
        shareKey: share.key,
        label: share.name,
      };
    }
    if (isNetworkCatalog(this.vfs)) {
      const parentId = this.resolveDropParent(e);
      if (parentId == null) return null;
      const destNode = this.findNodeAnywhere(parentId);
      const info = parseNetworkPath(typeof parentId === 'string' ? parentId : '', this.servers);
      if (!info.share || destNode?.chrome?.networkRole === 'service') return null;
      const native = this.overlayNative(destNode);
      if (native) {
        return {
          catalog: native.cat,
          parentId: native.ref,
          label: destNode?.name ?? this.pathStack.find((p) => p.id === parentId)?.name ?? 'folder',
        };
      }
      return {
        catalog: this.vfs,
        parentId,
        label: destNode?.name ?? this.pathStack.find((p) => p.id === parentId)?.name ?? 'folder',
      };
    }
    const parentId = this.resolveDropParent(e);
    if (parentId == null) return null;
    const destNode = this.findNodeAnywhere(parentId);
    return {
      catalog: this.vfs,
      parentId,
      label: destNode?.name ?? this.pathStack.find((p) => p.id === parentId)?.name ?? 'folder',
    };
  }

  private async updateDropHover(e: DragEvent): Promise<void> {
    const share = this.shareDropFromEvent(e);
    if (share) {
      const destCat =
        this.catalogs.get(share.key) ?? (share.key === LOCAL_SHARE_KEY ? (this.localVfs ?? null) : null);
      if (this.isInternalDrag() && this.dragNodeId != null && destCat && destCat === this.dragCatalog) {
        if (!this.isValidMoveTarget(this.dragNodeId, destCat.rootId(), destCat)) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
          this.clearSpringTimer();
          this.paintDropTarget(null, false, null, null, null);
          return;
        }
      }
      if (e.dataTransfer) {
        const same = this.isInternalDrag() && destCat != null && destCat === this.dragCatalog;
        e.dataTransfer.dropEffect = this.isInternalDrag() ? (same ? 'move' : 'copy') : 'copy';
      }
      this.paintDropTarget(null, false, null, null, share.key);
      if (share.key !== this.currentShareKey() && share.key !== this.springShareKey) {
        this.clearSpringTimer();
        this.springShareKey = share.key;
        this.springTimer = setTimeout(() => {
          void this.springLoadShare(share.key);
        }, 1000);
      } else if (share.key === this.currentShareKey()) {
        this.clearSpringTimer();
      }
      return;
    }

    const pathId = this.pathDropIdFromEvent(e);
    if (pathId != null) {
      if (this.isInternalDrag() && this.dragNodeId != null && this.dragCatalog === this.vfs) {
        if (!this.isValidMoveTarget(this.dragNodeId, pathId, this.vfs)) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
          this.clearSpringTimer();
          this.paintDropTarget(null, false, null, null);
          return;
        }
      }
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = this.isInternalDrag() && this.dragCatalog === this.vfs ? 'move' : 'copy';
      }
      this.clearSpringTimer();
      this.paintDropTarget(null, false, null, pathId);
      return;
    }

    const dest = this.resolveDropParent(e);
    const folderEl = this.folderUnderPointer(e);
    const folderId = folderEl ? dataRef(folderEl) : null;
    const colIndex = this.columnIndexFromEvent(e);

    if (this.isInternalDrag() && dest != null && this.dragNodeId != null && this.dragCatalog === this.vfs) {
      if (!this.isValidMoveTarget(this.dragNodeId, dest, this.vfs)) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        this.clearSpringTimer();
        this.paintDropTarget(null, false, null, null);
        return;
      }
    }

    if (e.dataTransfer) {
      if (!this.isInternalDrag()) e.dataTransfer.dropEffect = 'copy';
      else e.dataTransfer.dropEffect = this.dragCatalog === this.vfs ? 'move' : 'copy';
    }

    const blankActive = dest != null && folderId == null;
    this.paintDropTarget(folderId, blankActive, blankActive ? colIndex : null, null);

    if (folderId != null && folderId !== this.springFolderId) {
      this.clearSpringTimer();
      this.springFolderId = folderId;
      this.springTimer = setTimeout(() => {
        void this.springLoadFolder(folderId);
      }, 1000);
    } else if (folderId == null) {
      this.clearSpringTimer();
    }
  }

  private paintDropTarget(
    folderId: NodeRef | null,
    blankActive: boolean,
    columnIndex: number | null = null,
    pathId: NodeRef | null = null,
    shareKey: string | null = null,
  ): void {
    this.dropHoverFolderId = folderId;
    this.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    this.querySelectorAll('.drop-target-col').forEach((el) => el.classList.remove('drop-target-col'));
    const content = this.contentEl();
    content?.classList.remove('drop-active');

    if (shareKey != null) {
      const sel = `[data-share-key="${CSS.escape(shareKey)}"]`;
      this.querySelector(`.sidebar ${sel}`)?.classList.add('drop-target');
      return;
    }

    if (pathId != null) {
      this.querySelector(`.crumb[data-path-id="${selRef(pathId)}"]`)?.classList.add('drop-target');
      return;
    }

    if (folderId != null) {
      const el =
        this.querySelector(`.col-item[data-id="${selRef(folderId)}"]`) ??
        this.querySelector(`.icon-item[data-id="${selRef(folderId)}"]`) ??
        this.querySelector(`tr[data-id="${selRef(folderId)}"]`) ??
        this.querySelector(`[data-id="${selRef(folderId)}"]`);
      el?.classList.add('drop-target');
      return;
    }

    if (!blankActive) return;

    if (columnIndex != null) {
      this.querySelector(`[data-col-index="${columnIndex}"]`)?.classList.add('drop-target-col');
      return;
    }
    content?.classList.add('drop-active');
  }

  private clearDropUi(): void {
    this.dropHoverFolderId = null;
    this.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    this.querySelectorAll('.drop-target-col').forEach((el) => el.classList.remove('drop-target-col'));
    this.contentEl()?.classList.remove('drop-active');
  }

  private clearSpringTimer(): void {
    if (this.springTimer != null) {
      clearTimeout(this.springTimer);
      this.springTimer = null;
    }
    this.springFolderId = null;
    this.springShareKey = null;
  }

  private async springLoadShare(key: string): Promise<void> {
    this.springTimer = null;
    if (this.springShareKey !== key) return;
    if (this.currentShareKey() === key) return;
    try {
      if (key.startsWith('endpoint:')) {
        await this.ensureShareCatalog(key);
        return;
      }
      this.parkDragSource();
      if (key === LOCAL_SHARE_KEY) {
        this.showLocalShare();
      } else {
        const prefix = `${this.remoteNbpName}:`;
        if (!key.startsWith(prefix)) return;
        await this.mountRemoteVolume(key.slice(prefix.length));
      }
      if (this.springShareKey !== key) return;
      await this.reload();
      if (this.springShareKey !== key) return;
      this.renderSidebar();
      this.renderPath();
      this.renderContent();
      this.syncHistory();
      this.paintDropTarget(null, false, null, null, key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Couldn’t open share: ${msg}`);
    }
  }

  private async springLoadFolder(id: NodeRef): Promise<void> {
    this.springTimer = null;
    if (this.dropHoverFolderId !== id && this.springFolderId !== id) return;
    const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
    if (!node?.isDir) return;

    if (this.view === 'list') {
      await this.springExpandList(id);
      return;
    }
    if (this.view === 'column') {
      await this.springOpenColumn(node);
      return;
    }
    await this.springOpenIcon(node);
  }

  /** Expand a list-view folder without remounting the dragged row. */
  private async springExpandList(id: NodeRef): Promise<void> {
    if (this.expandedIds.has(id) || this.loadingIds.has(id)) return;
    this.expandedIds.add(id);
    const row = this.querySelector(`tr[data-id="${selRef(id)}"]`) as HTMLTableRowElement | null;
    const cached = this.listChildCache.get(id);
    if (cached) {
      this.insertListChildRows(row, cached, id);
      return;
    }
    const gen = this.nextFolderLoad(id);
    this.loadingIds.add(id);
    const disclose = row?.querySelector('[data-disclose]');
    if (disclose) this.setDiscloseState(disclose, 'loading');
    this.refreshFolderGlyph(id);
    if (row) this.insertListingPlaceholderRow(row);
    else this.renderContent();
    const signal = this.beginExpandListing(id);
    try {
      const kids = await this.streamChildren(
        id,
        (partial) => {
          if (!this.folderLoadIsCurrent(id, gen) || !this.expandedIds.has(id)) return;
          this.listChildCache.set(id, partial);
          const live = this.querySelector(`tr[data-id="${selRef(id)}"]`) as HTMLTableRowElement | null;
          if (live?.parentElement) this.replaceListChildRows(live, partial, id);
          else {
            this.parkDragSource();
            this.renderContent();
            this.paintDropTarget(id, false);
          }
        },
        signal,
      );
      if (!this.folderLoadIsCurrent(id, gen)) return;
      this.listChildCache.set(id, kids);
    } catch (err) {
      if (!this.folderLoadIsCurrent(id, gen) || isListingCancelled(err)) {
        if (this.folderLoadIsCurrent(id, gen) && !isAbortError(err)) this.expandedIds.delete(id);
        return;
      }
      this.expandedIds.delete(id);
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Couldn’t expand folder: ${msg}`);
    } finally {
      if (this.folderLoadIsCurrent(id, gen)) this.loadingIds.delete(id);
    }
    if (!this.folderLoadIsCurrent(id, gen)) return;
    this.refreshFolderGlyph(id);
    const live = this.querySelector(`tr[data-id="${selRef(id)}"]`) as HTMLTableRowElement | null;
    if (!live?.parentElement) {
      this.parkDragSource();
      this.renderContent();
      this.paintDropTarget(id, false);
      return;
    }
    if (this.expandedIds.has(id)) this.replaceListChildRows(live, this.listChildCache.get(id) ?? [], id);
    else this.renderContent();
  }

  private insertListingPlaceholderRow(row: HTMLTableRowElement): void {
    const depth = Number(String(row.style.getPropertyValue('--depth') || '0'));
    row.insertAdjacentHTML('afterend', this.listRowHtml(this.listingPlaceholderItem(), depth + 1));
  }

  private refreshFolderGlyph(id: NodeRef): void {
    const node = this.findNodeAnywhere(id);
    if (!node?.isDir) {
      this.renderPath();
      return;
    }
    const item: ListItem = {
      key: String(id),
      name: node.name,
      isDir: true,
      size: 0,
      mod: unixDate(node.modDate),
      node,
      finderInfo: node.finderInfo,
    };
    const w = transferActivity
      .writesIn(this.vfs, parentRef(node))
      .find((x) => x.name.toLowerCase() === node.name.toLowerCase());
    if (w) item.writing = w;
    const sel =
      '.icon-write, .icon-glyph-img, .icon-glyph-svg, .icon-glyph-spinner, .col-icon-img, .col-icon-svg, .col-icon-spinner, .row-icon-img, .row-icon-svg, .row-icon-spinner';
    for (const el of this.querySelectorAll(`[data-id="${selRef(id)}"]`)) {
      const kind = el.classList.contains('icon-item')
        ? 'icon'
        : el.classList.contains('col-item')
          ? 'col'
          : el.tagName === 'TR'
            ? 'row'
            : null;
      if (!kind) continue;
      const g = el.querySelector(sel);
      if (!g) continue;
      const tmp = document.createElement('div');
      tmp.innerHTML = this.glyphHtml(item, kind === 'icon' ? 'large' : 'small', kind);
      const next = tmp.firstElementChild;
      if (next) g.replaceWith(next);
    }
    this.renderPath();
  }

  private replaceListChildRows(row: HTMLTableRowElement, kids: VNode[], folderId: NodeRef): void {
    this.removeListChildRows(row);
    this.insertListChildRows(row, kids, folderId);
  }

  private insertListChildRows(row: HTMLTableRowElement | null, kids: VNode[], folderId: NodeRef): void {
    if (!row?.parentElement) return;
    const depth = Number(String(row.style.getPropertyValue('--depth') || '0'));
    const html = this.mergeWritingItems(folderId, kids.map((n) => this.listItemFromNode(n)))
      .map((item) => this.listRowHtml(item, depth + 1))
      .join('');
    row.insertAdjacentHTML('afterend', html);
    this.setDiscloseState(row.querySelector('[data-disclose]'), 'open');
    if (this.dragDepth > 0 || this.dragNodeId != null) this.paintDropTarget(folderId, false);
    const folder = this.findNodeAnywhere(folderId);
    const items = this.mergeWritingItems(folderId, kids.map((n) => this.listItemFromNode(n)));
    if (folder) {
      items.unshift({
        key: refKey(nodeRef(folder)),
        name: folder.name,
        isDir: true,
        size: nodeByteSize(folder),
        mod: unixDate(folder.modDate),
        node: folder,
        finderInfo: folder.finderInfo,
      });
    }
    this.prefetchIcons(items, 'add');
  }

  /** Navigate into a folder in icon view; park drag source so the gesture survives. */
  private async springOpenIcon(node: VNode): Promise<void> {
    if (this.cwd === nodeRef(node)) return;
    // Only spring-open folders visible in the current directory.
    if (!this.nodes.some((n) => nodeRef(n) === nodeRef(node))) {
      const visible = this.querySelector(`.icon-item[data-id="${selRef(nodeRef(node))}"]`);
      if (!visible) return;
    }

    this.parkDragSource();
    const openedId = nodeRef(node);
    this.cwd = nodeRef(node);
    this.pathStack.push({ id: nodeRef(node), name: node.name });
    this.clearSelection();
    this.expandedIds.clear();
    await this.reload();
    if (this.cwd !== openedId) return;
    this.renderPath();
    this.renderContent();
    this.syncClipboardButtons();
    this.syncHistory();
    this.clearSpringTimer();
    this.clearDropUi();
  }

  /** Open a folder into the next Miller column without remounting earlier columns (keeps drag alive). */
  private async springOpenColumn(node: VNode): Promise<void> {
    const colItem = this.querySelector(`.col-item[data-id="${selRef(nodeRef(node))}"]`) as HTMLElement | null;
    if (!colItem) return;
    const colIndex = Number(colItem.getAttribute('data-col') ?? '0');
    if (this.pathStack[colIndex + 1]?.id === nodeRef(node) && !this.columnLoading) return;

    this.parkDragSource();
    const signal = this.beginNavListing();

    this.pathStack = this.pathStack.slice(0, colIndex + 1);
    this.pathStack.push({ id: nodeRef(node), name: node.name });
    this.cwd = nodeRef(node);
    this.clearSelection();
    this.columnChildren = this.columnChildren.slice(0, colIndex + 1);

    const view = this.querySelector('.column-view');
    if (!view) {
      await this.loadColumnFolder(nodeRef(node), colIndex);
      this.syncHistory();
      this.clearSpringTimer();
      return;
    }

    view.querySelectorAll(':scope > .column').forEach((col) => {
      const idx = Number(col.getAttribute('data-col-index'));
      if (Number.isFinite(idx) && idx > colIndex) col.remove();
    });
    view.querySelectorAll('[data-preview]').forEach((el) => el.remove());

    const parentCol = view.querySelector(`[data-col-index="${colIndex}"]`);
    parentCol?.querySelectorAll('.col-item.selected').forEach((el) => el.classList.remove('selected'));
    colItem.classList.add('selected');

    this.columnLoadGen++;
    const gen = this.columnLoadGen;
    this.enumeratingFolderId = nodeRef(node);
    this.columnLoading = true;
    this.refreshFolderGlyph(nodeRef(node));
    parentCol?.insertAdjacentHTML('afterend', this.columnLoadingHtml(colIndex + 1));
    this.renderPath();
    this.scrollColumnsToEnd();

    try {
      const kids = await this.streamChildren(
        nodeRef(node),
        (partial) => {
          if (gen !== this.columnLoadGen || signal.aborted) return;
          this.columnChildren = this.columnChildren.slice(0, colIndex + 1);
          this.columnChildren.push(partial);
          this.nodes = partial;
          this.columnLoading = false;
          this.paintColumnKids(view, colIndex, partial);
          this.scrollColumnsToEnd();
        },
        signal,
      );
      if (gen !== this.columnLoadGen || signal.aborted) return;
      this.columnChildren = this.columnChildren.slice(0, colIndex + 1);
      this.columnChildren.push(kids);
      this.nodes = kids;
      this.columnLoading = false;
      this.paintColumnKids(view, colIndex, kids);
    } catch (err) {
      if (gen !== this.columnLoadGen) return;
      this.columnLoading = false;
      view.querySelector('.column--loading')?.remove();
      if (isListingCancelled(err)) {
        if (!isAbortError(err)) {
          this.pathStack = this.pathStack.slice(0, colIndex + 1);
          this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
        }
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Couldn’t open folder: ${msg}`);
      this.pathStack = this.pathStack.slice(0, colIndex + 1);
      this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
    } finally {
      if (gen === this.columnLoadGen && !signal.aborted && this.enumeratingFolderId === nodeRef(node)) {
        this.enumeratingFolderId = null;
        this.refreshFolderGlyph(nodeRef(node));
      }
    }

    if (gen !== this.columnLoadGen) return;
    this.renderPath();
    this.scrollColumnsToEnd();
    this.syncHistory();
    this.clearSpringTimer();
    this.paintDropTarget(nodeRef(node), false);
  }

  private isValidMoveTarget(id: NodeRef, destParent: NodeRef, fs: Catalog = this.vfs): boolean {
    if (this.dragCatalog && fs !== this.dragCatalog) return true;
    if (id === destParent) return false;
    const node =
      (this.dragNodeId === id ? this.dragNode : null) ??
      (fs === this.vfs ? this.findNodeAnywhere(id) : null);
    if (!node) return true;
    if (!node.isDir) return true;
    const seen = new Set<NodeRef>();
    let curId: NodeRef | null = destParent;
    while (curId != null && !seen.has(curId)) {
      if (curId === id) return false;
      seen.add(curId);
      if (fs === this.vfs) {
        const idx = this.pathStack.findIndex((p) => p.id === curId);
        if (idx > 0) {
          curId = this.pathStack[idx - 1]!.id;
          continue;
        }
        if (idx === 0) break;
        const n = this.findNodeAnywhere(curId);
        if (!n || parentRef(n) === nodeRef(n)) break;
        curId = parentRef(n);
        continue;
      }
      break;
    }
    return true;
  }

  private async planPlacement(
    fs: Catalog,
    parentId: NodeRef,
    name: string,
    isDir: boolean,
    ignoreId?: NodeRef,
    reserved?: Set<string>,
  ): Promise<PlacementPlan> {
    const plan = await planItemPlacement(fs, parentId, name, isDir, {
      ignoreId,
      reserved,
      resolveConflict: (info) => this.host.promptNameConflict(info),
    });
    if (!plan) throw new TransferCancelled();
    reserved?.add(plan.destName.toLowerCase());
    return plan;
  }

  private async moveNodeTo(id: NodeRef, destParent: NodeRef, fs: Catalog = this.vfs): Promise<void> {
    const cached =
      this.dragNodeId === id && this.dragNode && nodeRef(this.dragNode) === id ? this.dragNode : null;
    const node = cached ?? (await fs.get(id));
    if (!node) return;
    if (parentRef(node) === destParent) return;
    if (!this.isValidMoveTarget(id, destParent, fs)) {
      this.setStatus('Can’t move an item into itself');
      return;
    }
    const plan = await this.planPlacement(fs, destParent, node.name, node.isDir, id);
    await this.withOwnVfsMutation(async () => {
      if (plan.replaceId != null) await fs.remove(plan.replaceId);
      if (plan.destName !== node.name) await fs.rename(id, plan.destName);
      await fs.move(id, destParent);
    });
  }

  private async copyNodeAcross(
    src: Catalog,
    id: NodeRef,
    dest: Catalog,
    destParent: NodeRef,
  ): Promise<void> {
    const cached =
      this.dragNodeId === id && this.dragCatalog === src && this.dragNode && nodeRef(this.dragNode) === id
        ? this.dragNode
        : null;
    const node = cached ?? (await src.get(id));
    if (!node) return;
    const plan = await this.planPlacement(dest, destParent, node.name, node.isDir);
    const expected = node.isDir ? 0 : nodeByteSize(node);
    const jobId = this.startTransfer(plan.destName, node.isDir, expected, node.finderInfo);
    transferActivity.setDest(jobId, dest, destParent, plan.destName);
    const signal = transferActivity.signal(jobId);
    if (isCatalogWithBackend(src) && isCatalogWithBackend(dest) && src.api.backendId === dest.api.backendId) {
      try {
        await dest.copyFrom(src, id, destParent, {
          destName: plan.destName,
          replace: plan.replaceId != null,
          replaceId: plan.replaceId,
          signal,
          onProgress: (p) => {
            const cur = transferActivity.list().find((j) => j.id === jobId)?.bytesDone || 0;
            if (typeof p.bytesTotal === 'number') transferActivity.setTotal(jobId, p.bytesTotal);
            if (typeof p.bytesDone === 'number' && p.bytesDone > cur) transferActivity.addBytes(jobId, p.bytesDone - cur);
          },
        });
        await transferActivity.settle(jobId);
        return;
      } catch (err) {
        await transferActivity.settle(jobId, err);
        throw err;
      }
    }
    await this.withOwnVfsMutation(async () => {
      dest.beginBatch();
      try {
        await transferActivity.withCopySlot(jobId, async () => {
          throwIfAborted(signal);
          if (plan.replaceId != null) await dest.remove(plan.replaceId);
          const creditRead = !!src.reportsChunkedBytes && !dest.reportsChunkedBytes;
          const creditWrite = !!dest.reportsChunkedBytes || !creditRead;
          const snap = await this.snapshotNode(
            src,
            node,
            creditRead ? (n) => {
              throwIfAborted(signal);
              transferActivity.addBytes(jobId, n);
            } : undefined,
            signal,
          );
          throwIfAborted(signal);
          transferActivity.setTotal(jobId, clipByteSize(snap));
          await this.writeClipNode(
            dest,
            destParent,
            snap,
            creditWrite ? (n) => {
              throwIfAborted(signal);
              transferActivity.addBytes(jobId, n);
            } : undefined,
            plan.destName,
            jobId,
          );
          throwIfAborted(signal);
        });
        await transferActivity.settle(jobId);
      } catch (err) {
        await transferActivity.settle(jobId, err);
        throw err;
      } finally {
        dest.endBatch();
      }
    });
  }

  private async refreshAfterMutation(): Promise<void> {
    await this.pruneStalePath();
    await this.reload();
    this.renderPath();
    this.renderContent();
  }

  /** Drop path crumbs whose folders were moved/removed. */
  private async pruneStalePath(): Promise<void> {
    if (this.pathStack.length <= 1) return;
    const kept = [this.pathStack[0]!];
    for (let i = 1; i < this.pathStack.length; i++) {
      const step = this.pathStack[i]!;
      const node = await this.vfs.get(step.id);
      if (!node?.isDir || parentRef(node) !== kept[kept.length - 1]!.id) break;
      kept.push({ id: nodeRef(node), name: node.name });
    }
    this.pathStack = kept;
    this.cwd = kept[kept.length - 1]!.id;
  }

  private async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    const destInfo = this.resolveDropDest(e);
    const internalId = this.dragNodeId;
    const srcCat = this.dragCatalog;
    this.clearSpringTimer();
    this.clearDropUi();
    this.dragDepth = 0;
    this.dragNodeId = null;
    this.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    this.clearDragPortal();

    if (!destInfo) {
      this.dragNode = null;
      this.dragCatalog = null;
      return;
    }

    try {
      let destCat = destInfo.catalog ?? (destInfo.shareKey ? await this.ensureShareCatalog(destInfo.shareKey) : null);
      if (!destCat) {
        this.setStatus('Couldn’t open drop target');
        return;
      }
      let destParent = destInfo.parentId ?? destCat.rootId();
      if (isNetworkCatalog(destCat)) {
        const mapped = await this.resolveNative(destParent);
        destCat = mapped.cat;
        destParent = mapped.ref;
      }

      if (internalId != null) {
        if (!srcCat) return;
        const srcNode =
          (this.dragNode && nodeRef(this.dragNode) === internalId ? this.dragNode : null) ??
          (await srcCat.get(internalId));
        const srcParent = srcNode ? parentRef(srcNode) : undefined;
        if (srcCat === destCat) {
          await this.moveNodeTo(internalId, destParent, destCat);
          this.setStatus('Moved 1 item');
          await this.refreshIfDestVisible(
            destCat,
            destParent,
            ...(srcParent != null ? [srcParent] : []),
          );
        } else {
          await this.copyNodeAcross(srcCat, internalId, destCat, destParent);
          this.setStatus(`Copied 1 item to ${destInfo.label}`);
          await this.refreshIfDestVisible(destCat, destParent);
        }
        return;
      }

      const dt = e.dataTransfer;
      if (!dt) {
        this.setStatus('No files in drop');
        return;
      }
      this.setStatus('Scanning…', { busy: true });
      let lastPaint = 0;
      const count = await this.withOwnVfsMutation(() =>
        destCat.importDataTransfer(destParent, dt, {
          onScan: (total) => {
            this.setStatus(
              total > 0 ? `Importing… 0/${total} (0%)` : 'Importing…',
              { busy: true },
            );
          },
          onProgress: (done, total) => {
            const now = performance.now();
            if (done === 1 || done === total || now - lastPaint > 80) {
              lastPaint = now;
              const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
              this.setStatus(
                total > 0 ? `Importing… ${done}/${total} (${pct}%)` : `Importing… ${done} item(s)`,
                { busy: true },
              );
            }
          },
          onItem: (item) => this.trackImportItem(item, destCat, destParent),
          resolveConflict: (info) => this.host.promptNameConflict(info),
        }),
      );
      if (count === 0) {
        this.setStatus('No files in drop');
        return;
      }
      this.setStatus(`Imported ${count} item(s) into ${destInfo.label}`);
      if (this.vfs !== destCat || !this.changeImpactsVisibleFolders([destParent])) return;
      iconCache.clearDirectoryCache();
      this.iconUrls.clear();
      this.bumpIconLoadGen();
      await this.refreshAfterMutation();
    } catch (err) {
      if (isTransferCancelled(err)) {
        this.setStatus('Transfer cancelled');
        const cat = destInfo.catalog;
        if (cat) await this.refreshIfDestVisible(cat, destInfo.parentId || cat.rootId());
        return;
      }
      console.error(err);
      this.setStatus(`Drop failed: ${(err as Error).message}`);
    } finally {
      this.dragNode = null;
      this.dragCatalog = null;
    }
  }

  private async handleAction(act: string): Promise<void> {
    switch (act) {
      case 'connect':
        await this.onConnect();
        break;
      case 'refresh':
        await this.onRefresh();
        break;
      case 'mkdir':
        await this.onMkdir();
        break;
      case 'cut':
        await this.cutSelection();
        break;
      case 'copy':
        await this.copySelection();
        break;
      case 'paste':
        await this.pasteClipboard();
        break;
      case 'delete':
        await this.onDelete();
        break;
      case 'props':
        if (this.selectedId == null) {
          this.setStatus('Select an item for Get Info');
          break;
        }
        this.showProps = !this.showProps;
        this.syncPropsButton();
        this.refreshPropsPanel();
        break;
      case 'close-props':
        this.showProps = false;
        this.syncPropsButton();
        this.refreshPropsPanel();
        break;
      case 'apply-props':
        await this.applyProps();
        break;
      case 'resources':
        this.openResourceExplorer();
        break;
      case 'win-resources':
        this.openWinResourceExplorer();
        break;
      case 'copy-uri':
        await this.copyInfoUri();
        break;
      case 'download':
        await this.onDownload();
        break;
      case 'download-file':
      case 'download-data':
        await this.downloadSelectedFork('data');
        break;
      case 'download-resource':
        await this.downloadSelectedFork('resource');
        break;
      case 'preview':
        await this.openPreview();
        break;
      case 'close-preview':
        this.closePreview();
        break;
      case 'locations':
        this.sidebarOpen = !this.sidebarOpen;
        this.classList.toggle('sidebar-open', this.sidebarOpen);
        break;
      case 'close-sidebar':
        this.closeSidebar();
        break;
      case 'transfers':
        this.toggleCallout('transfers');
        break;
      case 'actions':
        this.toggleCallout('actions');
        break;
      case 'share-actions':
        this.toggleCallout('share');
        break;
      case 'import':
        this.querySelector<HTMLInputElement>('[data-import-files]')?.click();
        break;
      case 'zoom':
        this.toggleMaximized();
        break;
      case 'expand':
        await this.expandArchive();
        break;
    }
  }

  private async copyInfoUri(): Promise<void> {
    const el = this.getInfoWindow?.querySelector('.info-uri') ?? this.querySelector('.info-uri');
    const uri = el?.textContent?.trim() || '';
    if (!uri) return;
    try {
      await navigator.clipboard.writeText(uri);
      this.setStatus('Copied URI');
    } catch {
      this.setStatus('Couldn’t copy URI');
    }
  }

  private async applyProps(): Promise<void> {
    const sel = this.selectedNode();
    if (!sel) return;
    const caps = this.caps();
    const typeEl =
      (this.getInfoWindow?.querySelector('[data-prop="type"]') as HTMLInputElement | null) ??
      (this.querySelector('[data-prop="type"]') as HTMLInputElement | null);
    const creatorEl =
      (this.getInfoWindow?.querySelector('[data-prop="creator"]') as HTMLInputElement | null) ??
      (this.querySelector('[data-prop="creator"]') as HTMLInputElement | null);
    if (showsTypeCreator(caps, sel.isDir) && typeEl && creatorEl) {
      const type = typeEl.value.padEnd(4).slice(0, 4);
      const creator = creatorEl.value.padEnd(4).slice(0, 4);
      for (let i = 0; i < 4; i++) {
        sel.finderInfo[i] = type.charCodeAt(i);
        sel.finderInfo[4 + i] = creator.charCodeAt(i);
      }
      await this.withOwnVfsMutation(async () => {
        const dest = await this.nativeNode(sel);
        dest.node.finderInfo = sel.finderInfo;
        await dest.cat.put(dest.node);
      });
    }
    const patch: Record<string, boolean> = {};
    for (const a of caps.attributes) {
      const el =
        (this.getInfoWindow?.querySelector(`[data-attr="${CSS.escape(a.id)}"]`) as HTMLInputElement | null) ??
        (this.querySelector(`[data-attr="${CSS.escape(a.id)}"]`) as HTMLInputElement | null);
      if (el) patch[a.id] = el.checked;
    }
    if (Object.keys(patch).length) {
      const dest = await this.resolveNative(nodeRef(sel), sel);
      if (dest.cat.setAttrs) {
        await this.withOwnVfsMutation(() => dest.cat.setAttrs!(dest.ref, patch));
      }
    }
    this.setStatus('Info updated');
    await this.reload();
    this.refreshPropsPanel();
  }

  private async onConnect(): Promise<void> {
    if (!this.hasTransport()) return;
    if (this.host.isConnected()) {
      await this.host.disconnectTransport?.();
      this.unmountRemote('Disconnected');
      return;
    }
    try {
      await this.host.connectTransport?.();
      this.setStatus('Serial connected — claiming LocalTalk node…');
      this.render();
    } catch (e) {
      this.setStatus(`Connect failed: ${(e as Error).message}`);
    }
  }

  /** Select a sidebar row and show listing placeholders while a share connects. */
  private beginConnecting(ep: RemoteEndpoint, volume?: string, opts?: { keepListing?: boolean }): void {
    this.remoteBusy = true;
    const keep = opts?.keepListing || isNetworkCatalog(this.vfs);
    const label = volume?.trim() || ep.title;
    this.setStatus(volume?.trim() ? `Opening “${label}”…` : `Contacting ${ep.title}…`, { busy: true });
    if (keep) return;
    this.connectingEndpointId = ep.id;
    this.connectingVolume = volume?.trim() || null;
    this.folderOpening = true;
    this.nodes = [];
    this.clearSelection();
    if (this.view === 'column') {
      this.columnLoading = true;
      this.columnChildren = [];
    }
    this.renderSidebar();
    this.renderPath();
    this.renderContent();
  }

  private endConnecting(): void {
    const wiped = this.connectingEndpointId != null;
    this.connectingEndpointId = null;
    this.connectingVolume = null;
    this.remoteBusy = false;
    if (wiped && !this.remoteOpen) {
      this.folderOpening = false;
      this.columnLoading = false;
    }
    if (wiped) this.renderSidebar();
  }

  private async restoreAfterFailedConnect(): Promise<void> {
    if (isNetworkCatalog(this.vfs)) {
      this.folderOpening = false;
      this.columnLoading = false;
      this.loadingIds.clear();
      this.renderPath();
      this.renderContent();
      return;
    }
    if (this.hasLocalShare()) {
      this.showLocalShare();
      await this.reload();
    } else {
      this.nodes = [];
      this.folderOpening = false;
      this.columnLoading = false;
    }
  }

  /** After a connect that only lists volumes, put a usable listing back on screen. */
  private async restoreListingIfIdle(): Promise<void> {
    if (this.remoteOpen || this.nodes.length > 0) return;
    if (this.hasLocalShare() && this.source !== 'local') this.showLocalShare();
    if (this.vfs) await this.reload();
  }

  /** Show this server’s shares in the pane, or stay in Network Browser after login. */
  private async afterServerListed(s: RemoteEndpoint, opts?: OpenRemoteOptions): Promise<void> {
    if (isCatalogEndpoint(s)) {
      await this.openCatalogVolume(s);
      return;
    }
    if (opts?.listShares) {
      await this.showServerSharesFolder(s);
      return;
    }
    if (isNetworkCatalog(this.vfs)) {
      this.renderSidebar();
      return;
    }
    this.remoteOpen = false;
    this.renderSidebar();
    await this.restoreListingIfIdle();
  }

  private applyLocationOpts(opts?: OpenRemoteOptions): void {
    if (opts?.locationUri) {
      this.locationMode = 'url';
      this.locationUri = opts.locationUri;
      this.networkPrefix = [];
      return;
    }
    if (opts?.locationMode) {
      this.locationMode = opts.locationMode;
      if (opts.locationMode !== 'url') this.locationUri = '';
      if (opts.locationMode !== 'network') this.networkPrefix = [];
    }
  }

  private bindVolumeCatalog(key: string, cat: Catalog): void {
    this.catalogs.set(key, cat);
    if (this.volumeUnsubs.has(key)) return;
    this.volumeUnsubs.set(
      key,
      cat.subscribe(() => {
        if (isNetworkCatalog(this.vfs)) this.networkCatalog?.notify();
      }),
    );
  }

  /** Login if needed; skip when this client already has a session. */
  private async ensureLoggedIn(ep: RemoteEndpoint): Promise<boolean> {
    if (this.loggedInEndpoints.has(ep.id)) {
      this.adoptEndpoint(ep);
      this.remoteNbpName = ep.id;
      this.remoteLoggedIn = true;
      this.remoteVolumes = this.volumesFor(ep);
      return true;
    }
    return this.connectServerWithLogin(ep, undefined, {
      autoOpenSingle: false,
      listShares: false,
      attachOnly: true,
      locationMode: 'network',
    });
  }

  /** Open a volume catalog without leaving the Network Browser. */
  private async attachVolumeCatalog(ep: RemoteEndpoint, name: string): Promise<void> {
    const key = shareKeyForEndpoint(ep, name);
    if (this.catalogs.has(key)) {
      this.openedVolumeKeys.add(key);
      return;
    }
    this.adoptEndpoint(ep);
    this.remoteNbpName = ep.id;
    this.remoteLoggedIn = true;
    const cat = await this.host.openVolume(name);
    this.bindVolumeCatalog(key, cat);
    this.openedVolumeKeys.add(key);
  }

  private async ensureVolumeAttached(ep: RemoteEndpoint, name: string): Promise<boolean> {
    const key = shareKeyForEndpoint(ep, name);
    if (this.catalogs.has(key)) {
      this.openedVolumeKeys.add(key);
      return true;
    }
    const ok = await this.ensureLoggedIn(ep);
    if (!ok) return false;
    try {
      await this.attachVolumeCatalog(ep, name);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Open volume failed: ${msg}`, ep.kind);
      this.setStatus(`Couldn’t open “${name}”: ${msg}`);
      return false;
    }
  }

  /**
   * Before listing a server or share in Network Browser, prompt for login /
   * open the volume if this client has not already done so.
   */
  private async prepareNetworkListing(parentId: NodeRef, signal?: AbortSignal): Promise<boolean> {
    if (!isNetworkCatalog(this.vfs) || typeof parentId !== 'string') return true;
    if (signal?.aborted) return false;
    const info = parseNetworkPath(parentId, this.servers);
    if (info.role === 'server' && info.protocol && info.server) {
      const ep = matchNetworkServer(this.servers, info.protocol, info.neighborhood, info.server);
      if (!ep) return true;
      const ok = await this.ensureLoggedIn(ep);
      return ok && !signal?.aborted;
    }
    if (info.role === 'share' && info.protocol && info.server && info.share) {
      const ep = matchNetworkServer(this.servers, info.protocol, info.neighborhood, info.server);
      if (!ep) return true;
      if ((ep.services ?? []).some((s) => s.kind !== 'share' && s.name === info.share)) return true;
      const ok = await this.ensureVolumeAttached(ep, info.share);
      return ok && !signal?.aborted;
    }
    return true;
  }

  private async connectServerWithLogin(
    s: RemoteEndpoint,
    volume?: string,
    opts?: OpenRemoteOptions,
  ): Promise<boolean> {
    if (this.remoteBusy) return false;
    const wantVol = volume?.trim() || '';
    const attachOnly = !!opts?.attachOnly;
    const autoOpenSingle = opts?.autoOpenSingle !== false && !attachOnly;
    if (
      attachOnly &&
      this.loggedInEndpoints.has(s.id) &&
      (!wantVol || this.catalogs.has(shareKeyForEndpoint(s, wantVol)))
    ) {
      this.adoptEndpoint(s);
      this.remoteNbpName = s.id;
      this.remoteLoggedIn = true;
      this.remoteVolumes = this.volumesFor(s);
      this.renderSidebar();
      return true;
    }
    const alreadyViewing =
      this.viewingEndpoint(s) &&
      (!wantVol || (this.source === 'remote' && this.pathStack[0]?.name === wantVol));
    if (alreadyViewing && !attachOnly) {
      this.renderSidebar();
      return true;
    }

    this.beginConnecting(s, wantVol || undefined, { keepListing: attachOnly || isNetworkCatalog(this.vfs) });
    this.applyLocationOpts(opts);
    let ok = false;
    try {
      if (this.loggedInEndpoints.has(s.id)) {
        this.adoptEndpoint(s);
        this.remoteNbpName = s.id;
        this.remoteLoggedIn = true;
        if (!this.knownVolumes.has(s.id)) {
          try {
            const info = await this.host.beginRemote(s);
            if (info.volumes.length) this.knownVolumes.set(s.id, [...info.volumes]);
            this.adoptEndpoint(s, { title: connectedEndpointTitle(s, info.serverName) });
          } catch {
            /* keep cached volumes */
          }
        }
        this.remoteVolumes = this.volumesFor(s);
        if (wantVol && !this.remoteVolumes.some((v) => v.toLowerCase() === wantVol.toLowerCase())) {
          this.remoteVolumes = [...this.remoteVolumes, wantVol];
          this.knownVolumes.set(s.id, [...this.remoteVolumes]);
        }
          if (!wantVol) {
          if (isCatalogEndpoint(s)) {
            try {
              await this.openCatalogVolume(s);
              ok = true;
              return true;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.error(`Open volume failed: ${msg}`, s.kind);
              this.setStatus(`Open volume failed: ${msg}`);
              await this.restoreAfterFailedConnect();
              return false;
            }
          }
          await this.afterServerListed(s, opts);
          ok = true;
          return true;
        }
        try {
          if (attachOnly) await this.attachVolumeCatalog(s, wantVol);
          else await this.mountRemoteVolume(wantVol);
          ok = true;
          return true;
        } catch (err) {
          // The remembered login is no longer good — the server dropped the
          // session, or the host had to reopen it. Sign in again rather than
          // leaving the share unopenable until the user disconnects by hand.
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Cached session for “${s.title}” is stale (${msg}); signing in again`, s.kind);
          this.loggedInEndpoints.delete(s.id);
          await this.host.closeRemote().catch(() => undefined);
        }
      }

      log.info(`Connecting to ${s.kind} “${s.title}” (${s.id})`, s.kind);
      this.remoteLoggedIn = false;
      this.remoteVolumes = [];
      this.remoteOpen = false;
      const info: SessionInfo = await this.host.beginRemote(s);
      if (this.remoteNbpName === s.id) this.dropRemoteCatalogs(s.id);
      const uams = info.uams ?? [];
      const skipPrompt = info.allowGuest && uams.length === 0 && !opts?.credentials;
      this.setStatus(`Connected to ${info.serverName || s.title} — sign in`);
      let error: string | undefined;
      let usedInitial = false;
      for (;;) {
        let creds: Credentials | null;
        if (!usedInitial && opts?.credentials) {
          usedInitial = true;
          creds = opts.credentials;
        } else if (skipPrompt) {
          creds = { kind: 'guest' };
        } else {
          creds = await this.host.promptCredentials({
            serverName: info.serverName || s.title,
            uams,
            error,
            allowGuest: info.allowGuest,
            kind: s.kind,
          });
        }
        if (!creds) {
          await this.host.closeRemote().catch(() => undefined);
          this.remoteLoggedIn = false;
          this.remoteVolumes = [];
          this.remoteEndpoint = null;
          this.remoteNbpName = '';
          this.setStatus('Login cancelled');
          await this.restoreAfterFailedConnect();
          return false;
        }
        try {
          const vols = await this.host.loginRemote(creds);
          this.remoteLoggedIn = true;
          this.remoteVolumes = vols.length ? vols : info.volumes;
          if (wantVol && !this.remoteVolumes.some((v) => v.toLowerCase() === wantVol.toLowerCase())) {
            this.remoteVolumes = [...this.remoteVolumes, wantVol];
          }
          this.remoteNbpName = s.id;
          this.adoptEndpoint(s, { title: connectedEndpointTitle(s, info.serverName) });
          this.remoteOpen = false;
          this.knownVolumes.set(s.id, [...this.remoteVolumes]);
          this.loggedInEndpoints.add(s.id);
          this.setStatus(
            `Signed in to ${info.serverName || s.title} — ${this.remoteVolumes.length} volume(s)`,
          );
          log.info(
            `Authenticated to “${info.serverName || s.title}”; volumes: ${this.remoteVolumes.join(', ') || '(none)'}`,
            s.kind,
          );
          this.host.dismissLogin?.();
          if (wantVol) {
            if (attachOnly) await this.attachVolumeCatalog(s, wantVol);
            else await this.mountRemoteVolume(wantVol);
          } else if (autoOpenSingle && skipPrompt && this.remoteVolumes.length === 1) {
            await this.mountRemoteVolume(this.remoteVolumes[0]!);
          } else {
            await this.afterServerListed(s, opts);
          }
          ok = true;
          return true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          log.error(`Login failed: ${error}`, s.kind);
          if (skipPrompt) throw err;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Connect failed: ${msg}`, s.kind);
      this.setStatus(`Connect failed: ${msg}`);
      await this.host.closeRemote().catch(() => undefined);
      this.remoteLoggedIn = false;
      this.remoteVolumes = [];
      this.remoteEndpoint = null;
      this.remoteNbpName = '';
      await this.restoreAfterFailedConnect();
      return false;
    } finally {
      this.endConnecting();
      if (ok) this.renderSidebar();
    }
  }

  /** Keep the sidebar row and current session endpoint in sync (host name after login). */
  private adoptEndpoint(s: RemoteEndpoint, patch?: Partial<RemoteEndpoint>): RemoteEndpoint {
    const next = { ...s, ...patch };
    const i = this.servers.findIndex((x) => x.id === s.id);
    if (i >= 0) this.servers[i] = next;
    else this.servers = [next, ...this.servers];
    this.remoteEndpoint = next;
    return next;
  }

  /** Walk into a folder path on the currently mounted volume. */
  private async enterFolderPath(path: string): Promise<void> {
    const names = path.split('/').map((p) => p.trim()).filter(Boolean);
    if (!names.length) return;
    const volName = this.pathStack[0]?.name;
    this.pathStack = await this.resolvePathNames(names, volName);
    this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
  }

  private async mountRemoteVolume(name: string): Promise<void> {
    log.info(`Opening volume “${name}”`, 'afp');
    const key = this.catalogKeyForVolume(name);
    const cat = await this.ensureShareCatalog(key);
    if (!cat) throw new Error(`Couldn’t open volume “${name}”`);
    this.mountCatalog(cat, 'remote', name);
    this.remoteOpen = true;
    if (this.remoteEndpoint) this.openedVolumeKeys.add(shareKeyForEndpoint(this.remoteEndpoint, name));
    this.setStatus(
      this.remoteEndpoint?.kind === 'local' ? `Opened ${name}` : `Mounted ${this.remoteNbpName}:${name}`,
    );
  }

  private async disconnectRemote(): Promise<void> {
    log.info(`Disconnect “${this.remoteNbpName || 'remote'}”`, 'afp');
    const nbp = this.remoteNbpName;
    await this.host.closeRemote().catch(() => undefined);
    this.dropRemoteCatalogs(nbp);
    this.forgetEndpoint(nbp);
    this.resetToLocalShare();
    this.setStatus(this.isNoVolumeSelected() ? NO_VOLUME_HINT : 'Disconnected from server');
    await this.refreshSidebarEndpoints();
    await this.reload();
    this.syncHistory();
    this.render();
  }

  private async ejectVolume(name: string): Promise<void> {
    log.info(`Eject volume “${name}”`, 'afp');
    const viewing = this.source === 'remote' && this.pathStack[0]?.name === name;
    if (viewing) {
      this.abortAllListings();
      this.bumpIconLoadGen();
    }
    const key = this.catalogKeyForVolume(name);
    const cat = this.catalogs.get(key);
    if (this.clipboard && this.clipboard.source === cat) this.clipboard.source = null;
    this.catalogs.delete(key);
    this.volumeUnsubs.get(key)?.();
    this.volumeUnsubs.delete(key);
    if (viewing) {
      this.showLocalShare();
      this.remoteOpen = false;
    }
    await this.host.closeVolume?.(name).catch(() => undefined);
    if (!this.host.closeVolume) {
      const ep = this.remoteEndpoint;
      if (ep) await this.host.onSidebarAction?.(ep, 'unmount', name);
    }
    this.setStatus(viewing && this.isNoVolumeSelected() ? NO_VOLUME_HINT : `Ejected ${name}`);
    await this.refreshSidebarEndpoints();
    await this.reload();
    this.syncHistory();
    this.render();
  }

  private async ejectEndpoint(ep: RemoteEndpoint): Promise<void> {
    log.info(`Eject “${ep.title}”`, ep.kind);
    const current = this.remoteLoggedIn && this.remoteEndpoint?.id === ep.id;
    if (current) {
      const nbp = this.remoteNbpName;
      await this.host.closeRemote().catch(() => undefined);
      this.dropRemoteCatalogs(nbp);
      this.resetToLocalShare();
    } else if (this.remoteLoggedIn && ep.role === 'volume' && this.remoteEndpoint?.role !== 'volume') {
      await this.ejectVolume(ep.title);
      return;
    } else {
      await this.host.onSidebarAction?.(ep, 'eject');
    }
    this.setStatus(this.isNoVolumeSelected() ? NO_VOLUME_HINT : `Ejected ${ep.title}`);
    await this.refreshSidebarEndpoints();
    await this.reload();
    this.syncHistory();
    this.render();
  }

  private async refreshSidebarEndpoints(): Promise<void> {
    try {
      const list = this.host.cachedNetwork
        ? await this.host.cachedNetwork()
        : await this.host.refreshNetwork();
      this.setServers(list);
    } catch {
      this.renderSidebar();
    }
  }

  private async onRefresh(groupId?: string): Promise<void> {
    const groups = this.sidebarGroups();
    const title = groupId ? groups.find((g) => g.id === groupId)?.title : undefined;
    this.networkScanning = groupId || '*';
    this.renderSidebar();
    this.setStatus(
      title
        ? `Scanning ${title}…`
        : this.hasTransport()
          ? 'Looking up AFPServer…'
          : 'Looking up servers…',
    );
    try {
      if (this.host.cachedNetwork) {
        try {
          this.setServers(await this.host.cachedNetwork(groupId));
        } catch {
          /* scan still runs */
        }
      }
      const list = await this.host.refreshNetwork(groupId);
      this.setServers(list);
      const scoped = groupId
        ? list.filter((s) => assignSidebarGroup(s, groups) === groupId && s.kind !== 'local')
        : list.filter((s) => s.kind !== 'local');
      const n = scoped.length;
      this.setStatus(
        title
          ? n
            ? `${title}: found ${n} server(s)`
            : `${title}: none`
          : n
            ? `Found ${n} server(s)`
            : 'No servers',
      );
    } catch (e) {
      this.setStatus(`Lookup failed: ${(e as Error).message}`);
    } finally {
      this.networkScanning = null;
      this.renderSidebar();
    }
  }

  /**
   * Switch icon/list/column view. List clicks do not navigate, so a nested
   * selection is revealed in the destination view (parent folder for icons,
   * Miller path for columns, outline expands for list).
   */
  private async setView(next: ViewMode, replaceHistory = false): Promise<void> {
    if (this.view === next) return;
    this.view = next;
    const keep = this.selectedId;
    const keepIds = this.selectedIds;
    const node =
      keep != null ? (this.findNodeAnywhere(keep) ?? (await this.vfs.get(keep))) : null;
    if (node) {
      if (next === 'icon') await this.revealSelectionInIconView(node);
      else if (next === 'column') await this.revealSelectionInColumnView(node);
      else await this.revealSelectionInListView(node);
    } else if (next === 'column' && this.columnChildren.length === 0) {
      await this.refreshColumns(this.cwd);
    }
    this.selectedId = keep;
    this.selectedIds = keepIds;
    this.syncHistory(replaceHistory);
    this.render();
    this.scrollSelectedIntoView();
  }

  private scrollSelectedIntoView(): void {
    if (this.selectedId == null) return;
    const el = this.querySelector(`.content [data-id="${selRef(this.selectedId)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Icon view only shows cwd, so open the selected item's parent if needed. */
  private async revealSelectionInIconView(node: VNode): Promise<void> {
    if (nodeRef(node) === this.cwd) return;
    if (parentRef(node) === this.cwd || parentRef(node) === nodeRef(node)) return;
    const parent = this.findNodeAnywhere(parentRef(node)) ?? (await this.vfs.get(parentRef(node)));
    if (!parent?.isDir) return;
    await this.enterFolderKeepingSelection(parent);
  }

  /** Column view walks the path to the selection (folder contents in the next column). */
  private async revealSelectionInColumnView(node: VNode): Promise<void> {
    if (node.isDir) {
      await this.enterFolderKeepingSelection(node);
      return;
    }
    if (parentRef(node) === this.cwd || parentRef(node) === nodeRef(node)) {
      if (this.columnChildren.length === 0) await this.refreshColumns(this.cwd);
      return;
    }
    const parent = this.findNodeAnywhere(parentRef(node)) ?? (await this.vfs.get(parentRef(node)));
    if (!parent?.isDir) return;
    await this.enterFolderKeepingSelection(parent);
  }

  /** Re-expand outline ancestors so a nested list selection stays visible. */
  private async revealSelectionInListView(node: VNode): Promise<void> {
    if (this.nodes.some((n) => nodeRef(n) === nodeRef(node))) return;
    const expand: NodeRef[] = [];
    let pid = parentRef(node);
    const seen = new Set<NodeRef>();
    while (pid && pid !== this.cwd && !seen.has(pid)) {
      seen.add(pid);
      expand.push(pid);
      const parent = this.findNodeAnywhere(pid) ?? (await this.vfs.get(pid));
      if (!parent) return;
      pid = parentRef(parent);
    }
    if (pid !== this.cwd) return;
    expand.reverse();
    for (const id of expand) {
      this.expandedIds.add(id);
      if (!this.listChildCache.has(id)) {
        this.listChildCache.set(id, await this.streamChildren(id));
      }
    }
  }

  private async enterFolderKeepingSelection(folder: VNode): Promise<void> {
    const keep = this.selectedId;
    const keepIds = this.selectedIds;
    if (this.cwd === nodeRef(folder) && this.pathStack[this.pathStack.length - 1]?.id === nodeRef(folder)) {
      if (this.view === 'column' && this.columnChildren.length === 0) {
        await this.refreshColumns(this.cwd);
      }
      this.selectedId = keep;
      this.selectedIds = keepIds;
      return;
    }
    this.pathStack = await this.pathStackToFolder(nodeRef(folder));
    this.cwd = nodeRef(folder);
    this.expandedIds.clear();
    await this.reload();
    this.selectedId = keep;
    this.selectedIds = keepIds;
  }

  private async pathStackToFolder(folderId: NodeRef): Promise<{ id: NodeRef; name: string }[]> {
    const hit = this.pathStack.findIndex((p) => p.id === folderId);
    if (hit >= 0) return this.pathStack.slice(0, hit + 1);

    const suffix: { id: NodeRef; name: string }[] = [];
    let id: NodeRef | null = folderId;
    const seen = new Set<NodeRef>();
    while (id != null && !seen.has(id)) {
      seen.add(id);
      const inPath = this.pathStack.findIndex((p) => p.id === id);
      if (inPath >= 0) return [...this.pathStack.slice(0, inPath + 1), ...suffix.reverse()];
      const n: VNode | null | undefined =
        this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
      if (!n) break;
      suffix.push({ id: nodeRef(n), name: n.name });
      if (nodeRef(n) === this.vfs.rootId()) break;
      id = parentRef(n);
    }
    const root = this.pathStack[0] ?? { id: this.vfs.rootId(), name: this.localShareTitle() };
    const rest = suffix.reverse();
    if (rest[0]?.id === root.id) return rest;
    return [root, ...rest.filter((s) => s.id !== root.id)];
  }

  private async navigateToPathIndex(index: number): Promise<void> {
    if (index < 0 || index >= this.pathStack.length) return;
    if (index === this.pathStack.length - 1) return;
    this.pathStack = this.pathStack.slice(0, index + 1);
    const destId = this.pathStack[this.pathStack.length - 1]!.id;
    this.cwd = destId;
    this.clearSelection();
    await this.reload();
    if (this.cwd !== destId) return;
    this.renderPath();
    this.renderContent();
    this.syncClipboardButtons();
    this.syncHistory();
  }

  private async goUp(): Promise<void> {
    if (this.pathStack.length <= 1) return;
    await this.navigateToPathIndex(this.pathStack.length - 2);
  }

  private async goNavBack(): Promise<void> {
    if (this.navIndex <= 0) return;
    this.navIndex--;
    await this.applyNavEntry(this.navStack[this.navIndex]!);
  }

  private async goNavForward(): Promise<void> {
    if (this.navIndex < 0 || this.navIndex >= this.navStack.length - 1) return;
    this.navIndex++;
    await this.applyNavEntry(this.navStack[this.navIndex]!);
  }

  private async applyNavEntry(
    state: ReturnType<FinderWindow['historySnapshot']>,
  ): Promise<void> {
    this.navLock = true;
    try {
      await this.applyHistoryState(state);
      history.replaceState(state, '', this.buildLocationUrl(state));
      this.render();
    } finally {
      this.navLock = false;
    }
  }

  private startRename(): void {
    if (this.networkListingLocked() || !selectionAllowsMutate(this.selectionNodes())) return;
    // Renaming only makes sense for a single item — matches Finder, which
    // disables Rename whenever more than one item is selected.
    if (this.selectedId == null || this.selectedIds.size > 1) return;
    this.renamingId = this.selectedId;
    this.renderContent();
  }

  private isPreviewable(node: VNode | null | undefined): node is VNode {
    if (!node || node.isDir || isNetworkContainer(node)) return false;
    return previewKindFor(node) != null;
  }

  private isExpandableArchive(node: VNode | null | undefined): node is VNode {
    if (!node || node.isDir || isNetworkContainer(node)) return false;
    return isExpandableArchive(node.name, node.finderInfo, node.data);
  }

  /** Expand the given target — or, when it's part of the current multi-selection and every
   * selected item is an expandable archive, expand all of them in turn. */
  private async expandArchive(targetId: NodeRef | null = this.selectedId): Promise<void> {
    if (targetId == null) return;
    const ids =
      this.selectedIds.size > 1 && this.selectedIds.has(targetId) && this.allSelectedExpandable()
        ? [...this.selectedIds]
        : [targetId];
    for (const id of ids) {
      await this.expandOne(id);
    }
  }

  private async expandOne(id: NodeRef): Promise<void> {
    const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
    if (!node || node.isDir) return;
    const fail = (err?: unknown): void => {
      const text = expandFailureMessage(err);
      this.host.showAlert(`Couldn’t Expand “${node.name}”`, text);
      this.setStatus(`Couldn’t expand “${node.name}”`);
    };
    const { cat, node: native } = await this.nativeNode(node);
    const nativeId = nodeRef(native);
    const parent = await this.resolveNative(parentRef(node), this.findNodeAnywhere(parentRef(node)));
    const bytesTotal = nodeByteSize(native);
    const track = this.trackImportItem(
      { name: native.name, isDir: false, bytesTotal },
      cat,
      parent.ref,
      false,
    );
    this.setStatus(`Expanding “${node.name}”…`, { busy: true });
    try {
      if (isCatalogWithBackend(cat)) {
        let last = 0;
        await cat.expandNode(nativeId, {
          signal: track.signal,
          onProgress: (p) => {
            const next = p.bytesDone || 0;
            if (next > last) track.onBytes?.(next - last);
            last = next;
          },
        });
        track.onDone?.();
        this.setStatus(`Expanded “${node.name}”`);
        iconCache.clearDirectoryCache();
        this.iconUrls.clear();
        this.bumpIconLoadGen();
        await this.refreshAfterMutation();
        return;
      }
      const inPlace = await expandSitInPlace(cat, native, {
        fileSize: native.dataBytes ?? native.data.length,
        track,
        resolveConflict: (info) => this.host.promptNameConflict(info),
        wrapWrite: (fn) =>
          this.withOwnVfsMutation(async () => {
            cat.beginBatch();
            try {
              await fn();
            } finally {
              cat.endBatch();
            }
          }),
      });
      if (inPlace) {
        track.onDone();
        this.setStatus(`Expanded “${node.name}”`);
        iconCache.clearDirectoryCache();
        this.iconUrls.clear();
        this.bumpIconLoadGen();
        await this.refreshAfterMutation();
        return;
      }
      const full = (await cat.ensureContent(nativeId, track.onBytes, track.signal)) ?? native;
      let expanded;
      try {
        expanded = expandArchiveFile(full.name, full.data);
      } catch (err) {
        track.onDone(err instanceof Error ? err : new Error(expandFailureMessage(err)));
        fail(err);
        return;
      }
      const parentId = parentRef(full);
      const reserved = new Set<string>();
      const planned: { item: ExpandedNode; replaceId: NodeRef | null }[] = [];
      for (const item of expanded) {
        const plan = await planItemPlacement(cat, parentId, item.name, item.kind === 'dir', {
          reserved,
          resolveConflict: (info) => this.host.promptNameConflict(info),
        });
        if (!plan) throw new TransferCancelled();
        reserved.add(plan.destName.toLowerCase());
        planned.push({ item: { ...item, name: plan.destName }, replaceId: plan.replaceId });
      }
      await this.withOwnVfsMutation(async () => {
        cat.beginBatch();
        try {
          for (const row of planned) {
            if (row.replaceId != null) await cat.remove(row.replaceId);
          }
          await importExpandedTree(
            cat,
            parentId,
            planned.map((row) => row.item),
            track,
          );
        } finally {
          cat.endBatch();
        }
      });
      track.onDone();
      this.setStatus(`Expanded “${node.name}”`);
      iconCache.clearDirectoryCache();
      this.iconUrls.clear();
      this.bumpIconLoadGen();
      await this.refreshAfterMutation();
    } catch (err) {
      if (isTransferCancelled(err)) {
        track.onDone(err instanceof Error ? err : new Error(String(err)));
        this.setStatus('Transfer cancelled');
        await this.refreshAfterMutation();
        return;
      }
      track.onDone(err instanceof Error ? err : new Error(String(err)));
      fail(err);
    }
  }

  private async openPreview(id: NodeRef | null = this.selectedId): Promise<void> {
    if (id == null) return;
    const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
    if (!this.isPreviewable(node)) return;
    const kind = previewKindFor(node)!;
    const gen = ++this.previewGen;
    this.revokePreviewUrl();
    this.preview = { id: nodeRef(node), name: node.name, kind, text: null };
    this.renderPreview();
    try {
      const { cat, node: native } = await this.nativeNode(node);
      const full = (await cat.ensureContent(nodeRef(native))) ?? native;
      if (gen !== this.previewGen) return;
      if (!full.data.length) {
        this.preview = { id: nodeRef(full), name: full.name, kind, text: '' };
        this.renderPreview();
        return;
      }
      if (kind === 'text') {
        const truncated = full.data.length > PREVIEW_TEXT_MAX_BYTES;
        const slice = truncated ? full.data.subarray(0, PREVIEW_TEXT_MAX_BYTES) : full.data;
        this.preview = {
          id: nodeRef(full),
          name: full.name,
          kind,
          text: decodePreviewText(slice),
          truncated,
        };
        this.renderPreview();
        return;
      }
      if (kind === 'pict') {
        const picture = decodePict(full.data);
        const svg = picture ? await pictToSvg(picture) : null;
        if (gen !== this.previewGen) return;
        if (!svg) {
          this.preview = {
            id: nodeRef(full),
            name: full.name,
            kind,
            text: '',
            error: 'Could not decode this PICT (bitmap and QuickDraw opcodes only).',
          };
          this.renderPreview();
          return;
        }
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        if (gen !== this.previewGen) {
          URL.revokeObjectURL(url);
          return;
        }
        this.preview = { id: nodeRef(full), name: full.name, kind, text: 'ok', url };
        this.renderPreview();
        return;
      }
      const type = readTypeCreator(full.finderInfo).type;
      if (kind === 'image' && isBmpPreview(full.name, type)) {
        const decoded = decodeBmp(full.data);
        const dataUrl = decoded ? await decodedIconToDataUrl(decoded) : null;
        if (gen !== this.previewGen) return;
        if (dataUrl) {
          this.preview = { id: nodeRef(full), name: full.name, kind, text: 'ok', url: dataUrl };
          this.renderPreview();
          return;
        }
      }
      if (kind === 'image' && isIcoPreview(full.name, type)) {
        const icons = await decodeIco(full.data);
        const picked = pickIconNear(icons, 128);
        const dataUrl = picked ? await decodedIconToDataUrl(picked) : null;
        if (gen !== this.previewGen) return;
        if (dataUrl) {
          this.preview = { id: nodeRef(full), name: full.name, kind, text: 'ok', url: dataUrl };
          this.renderPreview();
          return;
        }
      }
      const mime = previewMime(kind, full.name, type);
      const copy = full.data.slice();
      const url = URL.createObjectURL(
        new Blob([copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer], {
          type: mime,
        }),
      );
      if (gen !== this.previewGen) {
        URL.revokeObjectURL(url);
        return;
      }
      this.preview = { id: nodeRef(full), name: full.name, kind, text: 'ok', url };
      this.renderPreview();
    } catch (err) {
      if (gen !== this.previewGen) return;
      this.preview = {
        id: nodeRef(node),
        name: node.name,
        kind,
        text: null,
        error: err instanceof Error ? err.message : String(err),
      };
      this.renderPreview();
    }
  }

  private revokePreviewUrl(): void {
    if (this.preview?.url?.startsWith('blob:')) URL.revokeObjectURL(this.preview.url);
  }

  private closePreview(): void {
    if (!this.preview) return;
    this.previewGen++;
    this.revokePreviewUrl();
    this.preview = null;
    this.renderPreview();
  }

  private renderPreview(): void {
    const root = this.querySelector('.quicklook-root');
    if (!root) return;
    const preview = this.preview;
    if (!preview) {
      root.innerHTML = '';
      return;
    }
    let body: string;
    let bodyClass = 'quicklook__body';
    if (preview.error) {
      body = `<p class="quicklook__empty">${this.escape(preview.error)}</p>`;
    } else if (preview.text == null) {
      body = `<div class="quicklook__loading">${this.spinnerHtml()}<span>Loading</span></div>`;
    } else if (preview.kind === 'image' && preview.url) {
      bodyClass += ' quicklook__body--media';
      body = `<img class="quicklook__image" alt="${this.escape(preview.name)}" src="${this.escape(preview.url)}" />`;
    } else if (preview.kind === 'audio' && preview.url) {
      bodyClass += ' quicklook__body--media';
      body = `<audio class="quicklook__audio" controls src="${this.escape(preview.url)}"></audio>`;
    } else if (preview.kind === 'video' && preview.url) {
      bodyClass += ' quicklook__body--media';
      body = `<video class="quicklook__video" controls src="${this.escape(preview.url)}"></video>`;
    } else if (preview.kind === 'pict' && preview.url) {
      bodyClass += ' quicklook__body--media';
      body = `<img class="quicklook__image" alt="${this.escape(preview.name)}" src="${this.escape(preview.url)}" />`;
    } else if (preview.kind === 'html' && preview.url) {
      bodyClass += ' quicklook__body--html';
      body = `<iframe class="quicklook__html" sandbox src="${this.escape(preview.url)}" title="${this.escape(preview.name)}" referrerpolicy="no-referrer"></iframe>`;
    } else if (preview.kind === 'pdf' && preview.url) {
      bodyClass += ' quicklook__body--pdf';
      body = `<iframe class="quicklook__pdf" src="${this.escape(preview.url)}" title="${this.escape(preview.name)}"></iframe>`;
    } else if (!preview.text) {
      body = `<p class="quicklook__empty">This file is empty</p>`;
    } else {
      const note = preview.truncated
        ? `<p class="quicklook__note">Showing the first ${formatBytes(PREVIEW_TEXT_MAX_BYTES)}</p>`
        : '';
      body = `${note}<pre class="quicklook__text">${this.escape(preview.text)}</pre>`;
    }
    root.innerHTML = `
      <div class="quicklook">
        <div class="quicklook__backdrop" data-act="close-preview"></div>
        <div class="quicklook__card" role="dialog" aria-labelledby="quicklook-title" aria-modal="true">
          <header class="quicklook__header">
            <h2 id="quicklook-title" aria-label="${this.escape(preview.name)}">${this.escape(preview.name)}</h2>
            <button type="button" class="btn" data-act="close-preview" aria-label="Close">✕</button>
          </header>
          <div class="${bodyClass}">${body}          </div>
        </div>
      </div>
    `;
  }

  private showPropertiesPanel(): void {
    if (this.selectedId == null) {
      this.setStatus('Select an item for Get Info');
      return;
    }
    this.showProps = true;
    this.syncPropsButton();
    this.refreshPropsPanel();
  }

  private async cutSelection(): Promise<void> {
    if (this.networkListingLocked() || !selectionAllowsMutate(this.selectionNodes())) return;
    await this.captureSelection('cut');
  }

  private async copySelection(): Promise<void> {
    if (this.networkListingLocked() || !selectionAllowsMutate(this.selectionNodes())) return;
    await this.captureSelection('copy');
  }

  private async captureSelection(mode: 'cut' | 'copy'): Promise<void> {
    if (this.selectedId == null) return;
    const ids = this.selectedIds.size > 1 ? [...this.selectedIds] : [this.selectedId];
    const nodes: VNode[] = [];
    for (const id of ids) {
      const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
      if (node) nodes.push(node);
    }
    if (!nodes.length) return;
    this.setStatus(mode === 'cut' ? 'Cutting…' : 'Copying…', { busy: true });
    const items: ClipNode[] = [];
    const sourceIds: NodeRef[] = [];
    let clipSource: Catalog = this.vfs;
    try {
      for (const node of nodes) {
        const { cat, node: native } = await this.nativeNode(node);
        const jobId = this.startTransfer(native.name, native.isDir, nodeByteSize(native), native.finderInfo);
        const signal = transferActivity.signal(jobId);
        try {
          const item = await transferActivity.withCopySlot(jobId, () =>
            this.snapshotNode(
              cat,
              native,
              cat.reportsChunkedBytes
                ? (n) => {
                    throwIfAborted(signal);
                    transferActivity.addBytes(jobId, n);
                  }
                : undefined,
              signal,
            ),
          );
          await transferActivity.settle(jobId);
          items.push(item);
          sourceIds.push(nodeRef(native));
          clipSource = cat;
        } catch (err) {
          await transferActivity.settle(jobId, err);
          throw err;
        }
      }
      this.clipboard = { mode, items, source: clipSource, sourceIds };
      this.syncClipboardButtons();
      this.setStatus(
        nodes.length === 1
          ? `${mode === 'cut' ? 'Cut' : 'Copied'} “${nodes[0]!.name}” — paste in this share or another`
          : `${mode === 'cut' ? 'Cut' : 'Copied'} ${nodes.length} items — paste in this share or another`,
      );
    } catch (err) {
      if (isTransferCancelled(err)) {
        this.setStatus('Transfer cancelled');
        return;
      }
      this.setStatus(`${mode === 'cut' ? 'Cut' : 'Copy'} failed: ${(err as Error).message}`);
    }
  }

  private async snapshotNode(
    fs: Catalog,
    node: VNode,
    onBytes?: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<ClipNode> {
    throwIfAborted(signal);
    if (node.isDir) {
      const kids = await fs.children(nodeRef(node), undefined, signal);
      const out: ClipNode[] = [];
      for (const k of kids) {
        throwIfAborted(signal);
        const full = k.isDir ? k : ((await fs.ensureContent(nodeRef(k), onBytes, signal)) ?? k);
        out.push(await this.snapshotNode(fs, full, onBytes, signal));
      }
      return {
        name: node.name,
        isDir: true,
        data: new Uint8Array(),
        resource: new Uint8Array(),
        finderInfo: node.finderInfo.slice(),
        kids: out,
      };
    }
    const full = (await fs.ensureContent(nodeRef(node), onBytes, signal)) ?? node;
    return {
      name: full.name,
      isDir: false,
      data: full.data.slice(),
      resource: full.resource.slice(),
      finderInfo: full.finderInfo.slice(),
    };
  }

  private catalogName(name: string): string {
    const caps = this.caps();
    let n = caps.nameCase === 'upper' ? name.toUpperCase() : name;
    const max = caps.maxNameBytes.long ?? caps.maxNameBytes.medium ?? caps.maxNameBytes.short ?? 255;
    const bytes = new TextEncoder().encode(n);
    if (bytes.length > max) n = new TextDecoder().decode(bytes.subarray(0, max));
    return n;
  }

  private async onMkdir(): Promise<void> {
    if (this.networkListingLocked() || this.caps().readOnly) return;
    const dest = await this.resolveNative(this.cwd);
    const name = await this.uniqueChildName(dest.ref, this.catalogName('New folder'), dest.cat);
    const node = await this.withOwnVfsMutation(() => dest.cat.mkdir(dest.ref, name));
    await this.reload();
    const overlay = this.nodes.find((n) => n.name === node.name);
    this.selectOnly(overlay ? nodeRef(overlay) : nodeRef(node));
    this.renamingId = overlay ? nodeRef(overlay) : nodeRef(node);
    this.renderContent();
  }

  private async uniqueChildName(parentId: NodeRef, base: string, fs: Catalog = this.vfs): Promise<string> {
    let name = base;
    let n = 2;
    while (await fs.lookup(parentId, name)) {
      name = `${base} ${n++}`;
    }
    return name;
  }

  private async onDelete(): Promise<void> {
    if (this.networkListingLocked() || !selectionAllowsMutate(this.selectionNodes())) return;
    if (this.selectedId == null) return;
    const ids = this.selectedIds.size > 1 ? [...this.selectedIds] : [this.selectedId];
    const nodes: { id: NodeRef; node: VNode }[] = [];
    for (const id of ids) {
      const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
      if (node) nodes.push({ id, node });
    }
    if (!nodes.length) return;
    const prompt =
      nodes.length === 1 ? `Delete “${nodes[0]!.node.name}”?` : `Delete ${nodes.length} items?`;
    if (!confirm(prompt)) return;
    try {
      for (const { id, node } of nodes) {
        const dest = await this.resolveNative(id, node);
        await this.withOwnVfsMutation(() => dest.cat.remove(dest.ref));
      }
    } catch (err) {
      this.setStatus(`Couldn’t delete: ${(err as Error).message}`);
      await this.reload();
      this.renderContent();
      return;
    }
    this.clearSelection();
    this.showProps = false;
    this.closePreview();
    this.syncPropsButton();
    this.syncClipboardButtons();
    await this.reload();
    this.renderContent();
  }

  /** Selected nodes to act on, or (when nothing's selected) the current folder itself. */
  private async downloadTargets(): Promise<VNode[]> {
    const ids = this.selectedIds.size > 1 ? [...this.selectedIds] : this.selectedId != null ? [this.selectedId] : [];
    const nodes: VNode[] = [];
    for (const id of ids) {
      const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
      if (node) nodes.push(node);
    }
    if (nodes.length) return nodes;
    const cur = await this.vfs.get(this.cwd);
    return cur ? [cur] : [];
  }

  private async downloadSelectedFork(fork: 'data' | 'resource'): Promise<void> {
    if (this.selectedId == null || this.selectedIds.size > 1) {
      this.setStatus('Select a file to download');
      return;
    }
    const node = this.findNodeAnywhere(this.selectedId) ?? (await this.vfs.get(this.selectedId));
    if (!node || node.isDir) {
      this.setStatus('Select a file to download');
      return;
    }
    try {
      const { cat, node: native } = await this.nativeNode(node);
      const full = (await cat.ensureContent(nodeRef(native))) ?? native;
      const bytes = fork === 'resource' ? full.resource : full.data;
      const filename = fork === 'resource' ? `${full.name}.rsrc` : full.name;
      downloadBytes(bytes, filename);
      this.setStatus(`Downloaded ${filename}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Download failed: ${msg}`);
    }
  }

  private async downloadNetworkShare(node: VNode): Promise<void> {
    const ep = this.endpointForNetworkNode(node);
    const name = node.name;
    if (!ep || !name) {
      this.setStatus('Can’t zip that volume');
      return;
    }
    const ok = await this.ensureVolumeAttached(ep, name);
    if (!ok) return;
    this.adoptEndpoint(ep);
    this.remoteNbpName = ep.id;
    const key = this.catalogKeyForVolume(name);
    const cat = this.catalogs.get(key);
    if (!cat) {
      this.setStatus(`Couldn’t zip “${name}”`);
      return;
    }
    const root = await cat.get(cat.rootId());
    if (!root) {
      this.setStatus(`Couldn’t zip “${name}”`);
      return;
    }
    const zipName = name;
    const jobId = this.startTransfer(zipName, true, 0);
    const signal = transferActivity.signal(jobId);
    try {
      const entries = await transferActivity.withCopySlot(jobId, async () => {
        transferActivity.setDetail(jobId, TRANSFER_DETAIL_SEARCHING);
        const listed = await enumerateZipFiles(
          cat,
          root,
          '',
          (p) => {
            throwIfAborted(signal);
            transferActivity.setFound(jobId, p.items, p.bytes);
          },
          signal,
        );
        transferActivity.setBytes(jobId, 0, listed.bytes, '');
        return collectZipEntries(
          cat,
          listed.files,
          loadPrefs().zipExportStyle,
          (n) => {
            throwIfAborted(signal);
            transferActivity.addBytes(jobId, n);
          },
          signal,
        );
      });
      throwIfAborted(signal);
      downloadZipEntries(zipName, entries);
      await transferActivity.settle(jobId);
      this.setStatus(`Downloaded ${zipName}.zip`);
    } catch (err) {
      await transferActivity.settle(jobId, err);
      if (isTransferCancelled(err)) {
        this.setStatus('Transfer cancelled');
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Download failed: ${msg}`);
    }
  }

  private async onDownload(): Promise<void> {
    const nodes = await this.downloadTargets();
    if (!nodes.length) {
      this.setStatus('Nothing to download');
      return;
    }
    if (nodes.some((n) => isNetworkContainer(n) && n.chrome?.networkRole !== 'share')) {
      this.setStatus('Can’t zip a network location');
      return;
    }
    const share = nodes.length === 1 && nodes[0]!.chrome?.networkRole === 'share' ? nodes[0]! : null;
    if (share) {
      await this.downloadNetworkShare(share);
      return;
    }
    const single = nodes.length === 1 ? nodes[0]! : null;
    const zipName = single?.name || 'Archive';
    const guessBytes = nodes.reduce((sum, n) => sum + (n.isDir ? 0 : nodeByteSize(n)), 0);
    const jobId = this.startTransfer(
      zipName,
      single ? single.isDir : true,
      single && !single.isDir ? guessBytes : 0,
      single?.finderInfo,
    );
    const signal = transferActivity.signal(jobId);
    try {
      const entries = await transferActivity.withCopySlot(jobId, async () => {
        throwIfAborted(signal);
        const mapped: { cat: Catalog; node: VNode }[] = [];
        for (const node of nodes) mapped.push(await this.nativeNode(node));
        let files: ZipFilePlan[];
        if (single && !single.isDir) {
          const n = mapped[0]!.node;
          files = [{ node: n, path: n.name, bytes: nodeByteSize(n) }];
          return collectZipEntries(
            mapped[0]!.cat,
            files,
            loadPrefs().zipExportStyle,
            (n) => {
              throwIfAborted(signal);
              transferActivity.addBytes(jobId, n);
            },
            signal,
          );
        }
        transferActivity.setDetail(jobId, TRANSFER_DETAIL_SEARCHING);
        files = [];
        let items = 0;
        let bytes = 0;
        for (const { cat, node } of mapped) {
          if (node.isDir) {
            const listed = await enumerateZipFiles(
              cat,
              node,
              '',
              (p) => {
                throwIfAborted(signal);
                transferActivity.setFound(jobId, items + p.items, bytes + p.bytes);
              },
              signal,
            );
            throwIfAborted(signal);
            files.push(...listed.files);
            items += listed.items;
            bytes += listed.bytes;
          } else {
            const size = nodeByteSize(node);
            files.push({ node, path: node.name, bytes: size });
            items++;
            bytes += size;
            transferActivity.setFound(jobId, items, bytes);
          }
        }
        transferActivity.setBytes(jobId, 0, bytes, '');
        const zipCat = mapped[0]!.cat;
        return collectZipEntries(
          zipCat,
          files,
          loadPrefs().zipExportStyle,
          (n) => {
            throwIfAborted(signal);
            transferActivity.addBytes(jobId, n);
          },
          signal,
        );
      });
      throwIfAborted(signal);
      downloadZipEntries(zipName, entries);
      await transferActivity.settle(jobId);
      this.setStatus(`Downloaded ${zipName}.zip`);
    } catch (err) {
      await transferActivity.settle(jobId, err);
      if (isTransferCancelled(err)) {
        this.setStatus('Transfer cancelled');
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Download failed: ${msg}`);
    }
  }

  private applyCompactView(): void {
    const compact = isCompactUi();
    if (compact) {
      if (this.desktopView == null) this.desktopView = this.view;
      this.restoreFinderLayout();
      if (this.view !== 'icon') {
        void this.setView('icon', true);
        return;
      }
    } else {
      this.sidebarOpen = false;
      this.classList.remove('sidebar-open');
      this.restoreFinderLayout();
      if (this.desktopView != null) {
        const restore = this.desktopView;
        this.desktopView = null;
        if (this.view !== restore) {
          this.openCallout = null;
          void this.setView(restore, true);
          return;
        }
      }
    }
    this.classList.toggle('sidebar-open', compact && this.sidebarOpen);
    this.syncTransferButton();
  }

  private closeSidebar(): void {
    if (!this.sidebarOpen) return;
    this.sidebarOpen = false;
    this.classList.remove('sidebar-open');
  }

  private toggleCallout(kind: 'transfers' | 'actions' | 'share'): void {
    this.openCallout = this.openCallout === kind ? null : kind;
    this.renderCallouts();
  }

  private onWinPointer = (e: PointerEvent): void => {
    if (!this.openCallout) return;
    const t = e.target as Node;
    if (this.querySelector('.callout')?.contains(t)) return;
    const triggers = this.querySelectorAll(
      '[data-act="transfers"], [data-act="actions"], [data-act="share-actions"]',
    );
    for (const el of triggers) {
      if (el.contains(t)) return;
    }
    this.openCallout = null;
    this.renderCallouts();
  };

  private syncTransferButton(): void {
    const btn = this.querySelector('[data-act="transfers"]') as HTMLButtonElement | null;
    if (!btn) return;
    const agg = transferActivity.aggregateProgress();
    const show = agg.running || this.openCallout === 'transfers' || this.transferBtnVisible;
    if (agg.running) {
      this.transferBtnVisible = true;
      if (!agg.indeterminate) this.lastTransferPct = agg.pct;
      if (this.transferIdleTimer) {
        clearTimeout(this.transferIdleTimer);
        this.transferIdleTimer = null;
      }
    } else if (this.transferBtnVisible && this.openCallout !== 'transfers' && !this.transferIdleTimer) {
      this.transferIdleTimer = setTimeout(() => {
        this.transferIdleTimer = null;
        this.transferBtnVisible = false;
        if (this.openCallout !== 'transfers') this.syncTransferButton();
        if (!transferActivity.hasRunning()) transferActivity.clearFinished();
      }, 1800);
    }
    btn.hidden = !show;
    btn.classList.toggle('indeterminate', agg.indeterminate);
    const pct = agg.running && !agg.indeterminate ? agg.pct : this.lastTransferPct;
    const label = agg.indeterminate ? 'File transfers in progress' : `File transfers, ${pct}%`;
    btn.textContent = agg.indeterminate ? '…' : `${pct}%`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    if (this.openCallout === 'transfers') this.paintTransferCallout();
  }

  private writingSignature(): string {
    const parts: string[] = [];
    for (const id of this.visibleFolderIds()) {
      for (const w of transferActivity.writesIn(this.vfs, id)) {
        parts.push(`${id}:${w.jobId}:${w.name}`);
      }
    }
    return parts.sort().join('|');
  }

  private syncWriteOverlays(): void {
    const sig = this.writingSignature();
    const overlays = [...this.querySelectorAll<HTMLElement>('[data-write-job]')];
    const jobs = new Map(transferActivity.list().map((j) => [j.id, j]));
    const missingOverlay = !!sig && overlays.length === 0;
    const staleOverlay = overlays.some((el) => {
      const job = jobs.get(el.getAttribute('data-write-job') ?? '');
      return !job || (job.status !== 'running' && job.status !== 'queued');
    });
    if (sig !== this.writeSig || missingOverlay || staleOverlay) {
      this.writeSig = sig;
      this.renderContent();
      return;
    }
    for (const el of overlays) {
      const job = jobs.get(el.getAttribute('data-write-job') ?? '');
      if (!job || (job.status !== 'running' && job.status !== 'queued')) continue;
      const pct =
        job.bytesTotal > 0 ? Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100)) : 0;
      const indeterminate = job.status === 'running' && job.bytesTotal <= 0;
      const overlay = el.querySelector('.icon-write') as HTMLElement | null;
      if (overlay) {
        overlay.style.setProperty('--write-pct', String(pct));
        overlay.classList.toggle('icon-write--indeterminate', indeterminate);
        const label = overlay.querySelector('.icon-write__pct');
        if (label) label.textContent = indeterminate ? '' : `${pct}%`;
      }
      const name = el.getAttribute('data-write-name') ?? job.name;
      el.setAttribute('aria-label', indeterminate ? `Copying ${name}` : `Copying ${name}, ${pct}%`);
    }
  }

  private paintTransferCallout(): void {
    const root = this.querySelector('.callout-root');
    if (!root) return;
    let el = root.querySelector('.callout--transfers') as HTMLElement | null;
    const created = !el;
    if (!el) {
      root.innerHTML = `<div class="callout callout--transfers"></div>`;
      el = root.querySelector('.callout--transfers') as HTMLElement;
    }
    if (!el) return;
    const rebuilt = paintTransferList(el);
    const anchor = this.querySelector('[data-act="transfers"]') as HTMLElement | null;
    if (anchor && (created || rebuilt)) {
      positionCallout(el, anchor);
    }
  }

  private renderCallouts(): void {
    const root = this.querySelector('.callout-root');
    if (!root) return;
    if (!this.openCallout) {
      root.innerHTML = '';
      return;
    }
    if (this.openCallout === 'transfers') {
      this.paintTransferCallout();
      return;
    }
    if (this.openCallout === 'share') {
      root.innerHTML = `<div class="callout">
        <button type="button" class="callout__item" data-callout-act="welcome-pack">Add Welcome Pack Items</button>
        <hr />
        <button type="button" class="callout__item callout__item--danger" data-callout-act="erase-local">Erase All Items…</button>
      </div>`;
      const el = root.querySelector('.callout') as HTMLElement;
      const anchor =
        (this.querySelector('[data-act="share-actions"]') as HTMLElement | null) ??
        (this.querySelector('[data-act="locations"]') as HTMLElement | null);
      if (el && anchor) positionCallout(el, anchor);
      return;
    }
    const sel = this.selectedNode();
    const multi = this.selectedIds.size > 1;
    const count = this.selectedIds.size;
    const items =
      sel != null
        ? isNetworkContainer(sel)
          ? [
              opsForNetworkNode(sel)?.downloadZip
                ? `<button type="button" class="callout__item" data-callout-act="download">Download Zip</button>`
                : '',
              `<button type="button" class="callout__item" data-callout-act="props">${multi ? `Get Info (${count} items)…` : 'Get Info…'}</button>`,
            ]
          : [
            (multi ? this.allSelectedExpandable() : this.isExpandableArchive(sel))
              ? `<button type="button" class="callout__item" data-callout-act="expand">Expand</button>`
              : '',
            !multi && this.isPreviewable(sel) ? `<button type="button" class="callout__item" data-callout-act="preview">Preview…</button>` : '',
            multi ? '' : `<button type="button" class="callout__item" data-callout-act="rename">Rename</button>`,
            `<button type="button" class="callout__item" data-callout-act="delete">${multi ? `Delete ${count} Items…` : 'Delete…'}</button>`,
            `<button type="button" class="callout__item" data-callout-act="props">${multi ? `Get Info (${count} items)…` : 'Get Info…'}</button>`,
            !multi && sel && !sel.isDir && showsResourceFork(this.caps())
              ? `<button type="button" class="callout__item" data-callout-act="resources">Resources…</button>`
              : '',
            !multi && sel && !sel.isDir && isWinResourceName(sel.name)
              ? `<button type="button" class="callout__item" data-callout-act="win-resources">Windows Resources…</button>`
              : '',
            `<hr/>`,
            `<button type="button" class="callout__item" data-callout-act="cut">Cut</button>`,
            `<button type="button" class="callout__item" data-callout-act="copy">Copy</button>`,
            this.clipboard ? `<button type="button" class="callout__item" data-callout-act="paste">Paste</button>` : '',
          ]
        : isNetworkCatalog(this.vfs) && this.networkListingLocked()
          ? [`<button type="button" class="callout__item" data-callout-act="props-blank">Get Info</button>`]
          : [
            `<button type="button" class="callout__item" data-callout-act="mkdir">New Folder</button>`,
            this.clipboard ? `<button type="button" class="callout__item" data-callout-act="paste">Paste</button>` : '',
            `<button type="button" class="callout__item" data-callout-act="props-blank">Get Info</button>`,
          ];
    root.innerHTML = `<div class="callout">${items.filter(Boolean).join('')}</div>`;
    const el = root.querySelector('.callout') as HTMLElement;
    const anchor = this.querySelector('[data-act="actions"]') as HTMLElement | null;
    if (el && anchor) positionCallout(el, anchor);
  }

  private async importPickedFiles(files: FileList): Promise<void> {
    const dt = new DataTransfer();
    for (const f of Array.from(files)) dt.items.add(f);
    const dest = await this.resolveNative(this.cwd);
    this.setStatus('Scanning…', { busy: true });
    try {
      const count = await this.withOwnVfsMutation(() =>
        dest.cat.importDataTransfer(dest.ref, dt, {
          onScan: (total) => {
            this.setStatus(total > 0 ? `Importing… 0/${total} (0%)` : 'Importing…', { busy: true });
          },
          onProgress: (done, total) => {
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
            this.setStatus(
              total > 0 ? `Importing… ${done}/${total} (${pct}%)` : `Importing… ${done} item(s)`,
              { busy: true },
            );
          },
          onItem: (item) => this.trackImportItem(item, dest.cat, dest.ref),
          resolveConflict: (info) => this.host.promptNameConflict(info),
        }),
      );
      if (count === 0) {
        this.setStatus('No files to import');
        return;
      }
      this.setStatus(`Imported ${count} item(s)`);
      iconCache.clearDirectoryCache();
      this.iconUrls.clear();
      this.bumpIconLoadGen();
      await this.refreshAfterMutation();
    } catch (err) {
      if (isTransferCancelled(err)) {
        this.setStatus('Transfer cancelled');
        await this.refreshAfterMutation();
        return;
      }
      this.setStatus(`Import failed: ${(err as Error).message}`);
    }
  }

  private async onContextMenu(e: MouseEvent): Promise<void> {
    if (isCompactUi()) {
      e.preventDefault();
      return;
    }
    const t = e.target as HTMLElement;
    if (t.closest('[data-local]')) {
      e.preventDefault();
      this.contextMenu = { x: e.clientX, y: e.clientY, targetId: null, local: true };
      this.renderContextMenu();
      return;
    }
    const volEl = t.closest('[data-vol]');
    const serverEl = t.closest('[data-server]');
    if (volEl || serverEl) {
      let index = -1;
      let volume: string | undefined;
      if (volEl) {
        index = Number(volEl.getAttribute('data-server-parent'));
        if (!Number.isFinite(index) || index < 0) {
          index = this.servers.findIndex((s) => s.id === (this.remoteEndpoint?.id || this.remoteNbpName));
        }
        const parent = this.servers[index];
        volume =
          volEl.getAttribute('data-vol-name') ||
          (parent ? this.volumesFor(parent)[Number(volEl.getAttribute('data-vol'))] : undefined);
      } else if (serverEl) {
        index = Number(serverEl.getAttribute('data-server'));
      }
      const ep = this.servers[index];
      const hostActions = ep ? (this.host.sidebarContextMenu?.(ep, volume) ?? []) : [];
      const actions: SidebarAction[] = [];
      if (ep && (volume || ep.role === 'volume')) {
        actions.push({ id: 'info', label: 'Get Info…' });
        if (this.volumeIsOpen(ep, volume) || ep.role === 'volume') {
          actions.push({ id: 'eject', label: 'Eject' });
        }
      } else if (ep) {
        actions.push({ id: 'info', label: 'Get Info…' });
        if (ep.kind === 'afp' || ep.kind === 'smb') {
          actions.push({ id: 'message', label: 'Send Message…' });
        }
        if (this.loggedInEndpoints.has(ep.id) || (this.remoteLoggedIn && (ep.id === this.remoteNbpName || ep.id === this.remoteEndpoint?.id))) {
          actions.push({ id: 'disconnect', label: 'Disconnect' });
        }
      }
      for (const a of hostActions) {
        if (actions.some((x) => x.id === a.id)) continue;
        actions.push(a);
      }
      if (!ep || !actions.length) return;
      e.preventDefault();
      this.contextMenu = {
        x: e.clientX,
        y: e.clientY,
        targetId: null,
        sidebar: { index, volume, actions },
      };
      this.renderContextMenu();
      return;
    }
    const content = this.querySelector('.content');
    if (!content?.contains(e.target as Node)) return;
    e.preventDefault();
    const item = this.itemFromEvent(e);
    if (item && (item.matches('[data-preview], .item-info') || item.closest('[data-preview], .item-info'))) {
      this.contextMenu = { x: e.clientX, y: e.clientY, targetId: this.selectedId };
    } else if (item) {
      const id = dataRef(item);
      // Right-clicking an item already in the multi-selection keeps the whole
      // selection (so actions apply to all of it); otherwise select just this item.
      if (id == null || !this.selectedIds.has(id)) {
        this.selectOnly(id);
        this.paintSelection(item);
        if (this.showProps) this.refreshPropsPanel();
      }
      this.contextMenu = { x: e.clientX, y: e.clientY, targetId: id };
    } else {
      this.contextMenu = { x: e.clientX, y: e.clientY, targetId: null };
    }
    this.renderContextMenu();
  }

  private renderContextMenu(): void {
    const root = this.querySelector('.ctx-root');
    if (!root) return;
    if (!this.contextMenu) {
      root.innerHTML = '';
      return;
    }
    const { x, y, targetId, local, sidebar } = this.contextMenu;
    const targetNode = targetId != null ? this.findNodeAnywhere(targetId) : null;
    const multi = this.selectedIds.size > 1 && targetId != null && this.selectedIds.has(targetId);
    const count = multi ? this.selectedIds.size : 1;
    const canPreview = !multi && this.isPreviewable(targetNode);
    const canExpand = multi ? this.allSelectedExpandable() : this.isExpandableArchive(targetNode);
    const items = sidebar
      ? sidebar.actions.map((a) => `<button type="button" data-ctx="${this.escape(a.id)}">${this.escape(a.label)}</button>`)
      : local
        ? [
            `<button type="button" data-ctx="welcome-pack">Add Welcome Pack Items</button>`,
            `<hr/>`,
            `<button type="button" data-ctx="erase-local">Erase All Items…</button>`,
          ]
        : targetId != null
          ? isNetworkContainer(targetNode)
            ? [
                opsForNetworkNode(targetNode)?.downloadZip
                  ? `<button type="button" data-ctx="download">Download Zip</button>`
                  : '',
                `<button type="button" data-ctx="props">${multi ? `Get Info (${count} items)…` : 'Get Info…'}</button>`,
              ]
            : [
              canExpand ? `<button type="button" data-ctx="expand">Expand</button>` : '',
              `<button type="button" data-ctx="download">Download Zip</button>`,
              canPreview ? `<button type="button" data-ctx="preview">Preview…</button>` : '',
              multi ? '' : `<button type="button" data-ctx="rename">Rename</button>`,
              `<button type="button" data-ctx="delete">${multi ? `Delete ${count} Items…` : 'Delete…'}</button>`,
              `<button type="button" data-ctx="props">${multi ? `Get Info (${count} items)…` : 'Get Info…'}</button>`,
              !multi && targetNode && !targetNode.isDir && showsResourceFork(this.caps())
                ? `<button type="button" data-ctx="resources">Resources…</button>`
                : '',
              !multi && targetNode && !targetNode.isDir && isWinResourceName(targetNode.name)
                ? `<button type="button" data-ctx="win-resources">Windows Resources…</button>`
                : '',
              `<hr/>`,
              `<button type="button" data-ctx="cut">Cut</button>`,
              `<button type="button" data-ctx="copy">Copy</button>`,
              this.clipboard ? `<button type="button" data-ctx="paste">Paste</button>` : '',
            ]
          : isNetworkCatalog(this.vfs) && this.networkListingLocked()
            ? [`<button type="button" data-ctx="props-blank">Get Info</button>`]
            : [
              `<button type="button" data-ctx="mkdir">New Folder</button>`,
              this.clipboard ? `<button type="button" data-ctx="paste">Paste</button>` : '',
              `<button type="button" data-ctx="props-blank">Get Info</button>`,
            ];
    root.innerHTML = `<div class="ctx-menu" style="left:${x}px;top:${y}px">${items.filter(Boolean).join('')}</div>`;
  }

  private async handleContextAction(action: string, targetId: NodeRef | null = null): Promise<void> {
    switch (action) {
      case 'expand':
        await this.expandArchive(targetId);
        break;
      case 'download':
        await this.onDownload();
        break;
      case 'preview':
        await this.openPreview(targetId);
        break;
      case 'rename':
        this.startRename();
        break;
      case 'delete':
        await this.onDelete();
        break;
      case 'props':
        this.showPropertiesPanel();
        break;
      case 'resources':
        this.openResourceExplorer(targetId);
        break;
      case 'win-resources':
        this.openWinResourceExplorer(targetId);
        break;
      case 'props-blank': {
        this.showProps = true;
        if (this.selectedId == null) {
          const folder = await this.vfs.get(this.cwd);
          if (folder) this.selectOnly(nodeRef(folder));
        }
        this.syncPropsButton();
        this.refreshPropsPanel();
        break;
      }
      case 'cut':
        await this.cutSelection();
        break;
      case 'copy':
        await this.copySelection();
        break;
      case 'paste':
        await this.pasteClipboard(await this.pasteDestFromTarget(targetId));
        break;
      case 'mkdir':
        await this.onMkdir();
        break;
      case 'erase-local':
        await this.eraseLocalShare();
        break;
      case 'welcome-pack':
        void this.runWelcomePack({ seed: false });
        break;
    }
  }

  private async runWelcomePack(opts: { seed: boolean }): Promise<void> {
    if (opts.seed && !this.host.seedWelcomePack) return;
    if (!opts.seed && !this.host.installWelcomePack) return;
    if (this.welcomePackBusy) {
      if (!opts.seed) this.setStatus('Welcome pack is already adding items');
      return;
    }
    this.welcomePackBusy = true;
    const progress: WelcomePackProgress = {
      onBegin: (fileCount) => {
        if (fileCount <= 0) return;
        this.setStatus('Adding Welcome Pack Items…', { busy: true });
      },
      onItem: (item) => {
        const dest = this.localVfs ?? this.host?.localCatalog() ?? this.vfs;
        return this.trackImportItem(item, dest, dest.rootId());
      },
    };
    try {
      const result = opts.seed
        ? await this.host.seedWelcomePack!(progress)
        : await this.host.installWelcomePack!(progress);
      if (!result) return;
      if (result.imported === 0 && result.skipped === 0) {
        this.setStatus('Welcome pack is empty');
        return;
      }
      if (result.imported === 0) {
        this.setStatus('Welcome pack items already present');
        return;
      }
      const extra = result.skipped > 0 ? ` (${result.skipped} already present)` : '';
      this.setStatus(`Added ${result.imported} welcome pack item${result.imported === 1 ? '' : 's'}${extra}`);
    } catch (err) {
      this.setStatus(`Welcome pack failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.welcomePackBusy = false;
    }
  }

  private async eraseLocalShare(): Promise<void> {
    const cat = this.localVfs ?? this.host?.localCatalog();
    if (!cat) return;
    const root = cat.rootId();
    const kids = await cat.children(root);
    if (!kids.length) {
      this.setStatus(`${this.localShareTitle()} is empty`);
      return;
    }
    if (!confirm(`Erase all items in ${this.localShareTitle()}? This cannot be undone.`)) {
      return;
    }
    this.setStatus(`Erasing ${this.localShareTitle()}…`, { busy: true });
    if (this.source === 'local') {
      this.cwd = root;
      this.pathStack = [{ id: root, name: this.localShareTitle() }];
      this.clearSelection();
      this.expandedIds.clear();
      this.loadingIds.clear();
      this.listChildCache.clear();
      this.columnChildren = [];
      this.showProps = false;
      this.syncPropsButton();
    }
    if (this.clipboard?.source === cat) {
      this.clipboard = null;
      this.syncClipboardButtons();
    }
    let failed = false;
    await this.withOwnVfsMutation(async () => {
      cat.beginBatch();
      try {
        for (const k of kids) await cat.remove(nodeRef(k));
      } catch (err) {
        failed = true;
        this.setStatus(`Erase failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        cat.endBatch();
      }
    });
    iconCache.clearDirectoryCache();
    this.iconUrls.clear();
    this.bumpIconLoadGen();
    if (this.source === 'local') {
      await this.reload();
      this.syncHistory();
      this.render();
    }
    if (!failed) this.setStatus(`Erased ${this.localShareTitle()}`);
  }

  private async pasteDestFromTarget(targetId: NodeRef | null): Promise<NodeRef> {
    if (targetId == null) return this.cwd;
    const node = this.findNodeAnywhere(targetId) ?? (await this.vfs.get(targetId));
    if (node?.isDir) return nodeRef(node);
    return node ? parentRef(node) : this.cwd;
  }

  private async pasteClipboard(destParent = this.cwd): Promise<void> {
    if (this.networkListingLocked()) return;
    if (!this.clipboard?.items.length) return;
    const clip = this.clipboard;
    this.setStatus('Pasting…', { busy: true });
    const srcParents: NodeRef[] = [];
    const dest = await this.resolveNative(destParent);
    const destCat = dest.cat;
    const destRef = dest.ref;
    try {
      const sameShare = clip.source === destCat;
      const reserved = new Set<string>();
      if (clip.mode === 'cut' && sameShare) {
        const moves: { id: NodeRef; name: string; plan: PlacementPlan }[] = [];
        for (const id of clip.sourceIds) {
          const src = await destCat.get(id);
          if (!src || parentRef(src) === destRef) continue;
          if (!this.isValidMoveTarget(id, destRef, destCat)) {
            this.setStatus('Can’t move an item into itself');
            return;
          }
          srcParents.push(parentRef(src));
          const plan = await this.planPlacement(destCat, destRef, src.name, src.isDir, id, reserved);
          moves.push({ id, name: src.name, plan });
        }
        for (const { id, name, plan } of moves) {
          await this.withOwnVfsMutation(async () => {
            if (plan.replaceId != null) await destCat.remove(plan.replaceId);
            if (plan.destName !== name) await destCat.rename(id, plan.destName);
            await destCat.move(id, destRef);
          });
        }
      } else {
        const planned: { item: ClipNode; plan: PlacementPlan }[] = [];
        for (const item of clip.items) {
          planned.push({
            item,
            plan: await this.planPlacement(destCat, destRef, item.name, item.isDir, undefined, reserved),
          });
        }
        await this.withOwnVfsMutation(async () => {
          destCat.beginBatch();
          try {
            for (const { item, plan } of planned) {
              if (plan.replaceId != null) await destCat.remove(plan.replaceId);
              const jobId = this.startTransfer(plan.destName, item.isDir, clipByteSize(item), item.finderInfo);
              transferActivity.setDest(jobId, destCat, destRef, plan.destName);
              const signal = transferActivity.signal(jobId);
              try {
                await transferActivity.withCopySlot(jobId, async () => {
                  await this.writeClipNode(
                    destCat,
                    destRef,
                    item,
                    (n) => {
                      throwIfAborted(signal);
                      transferActivity.addBytes(jobId, n);
                    },
                    plan.destName,
                    jobId,
                  );
                  throwIfAborted(signal);
                });
                await transferActivity.settle(jobId);
              } catch (err) {
                await transferActivity.settle(jobId, err);
                if (isTransferCancelled(err)) continue;
                throw err;
              }
            }
          } finally {
            destCat.endBatch();
          }
          if (clip.mode === 'cut' && clip.source) {
            for (const id of clip.sourceIds) {
              await clip.source.remove(id).catch(() => undefined);
            }
          }
        });
      }
      if (clip.mode === 'cut') this.clipboard = null;
      this.syncClipboardButtons();
      await this.refreshIfDestVisible(destCat, destRef, ...srcParents);
      this.setStatus('Paste complete');
    } catch (err) {
      if (isTransferCancelled(err)) {
        this.setStatus('Transfer cancelled');
        await this.refreshIfDestVisible(destCat, destRef, ...srcParents);
        return;
      }
      this.setStatus(`Paste failed: ${(err as Error).message}`);
    }
  }

  private async writeClipNode(
    fs: Catalog,
    parentId: NodeRef,
    item: ClipNode,
    onBytes?: (n: number) => void,
    destName = item.name,
    jobId?: string,
  ): Promise<void> {
    const signal = jobId ? transferActivity.signal(jobId) : undefined;
    throwIfAborted(signal);
    const clash = await fs.lookup(parentId, destName);
    const name = clash ? await uniqueCopyName(fs, parentId, destName) : destName;
    if (item.isDir) {
      const dir = await fs.mkdir(parentId, name);
      if (jobId) transferActivity.addDest(jobId, fs, parentId, name, 'folder');
      for (const kid of item.kids ?? []) {
        throwIfAborted(signal);
        await this.writeClipNode(fs, nodeRef(dir), kid, onBytes, kid.name, jobId);
      }
      return;
    }
    if (jobId) transferActivity.setWriteFile(jobId, fs, parentId, name);
    try {
      await fs.createFile(
        parentId,
        name,
        item.data.slice(),
        item.resource.slice(),
        item.finderInfo.slice(),
        onBytes,
        signal,
      );
      throwIfAborted(signal);
      if (jobId) transferActivity.clearPartial(jobId);
    } catch (err) {
      if (jobId && (isTransferCancelled(err) || transferActivity.isCancelled(jobId))) {
        await transferActivity.discardPartial(jobId);
      }
      throw err;
    }
  }

  private isEditingField(t: EventTarget | null): boolean {
    return (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    );
  }

  private finderHasFocus(): boolean {
    const ae = document.activeElement;
    if (!ae || ae === document.body || ae === document.documentElement) return false;
    return this.contains(ae);
  }

  private async onKeyDown(e: KeyboardEvent): Promise<void> {
    if (this.inert) return;
    const t = e.target as HTMLElement;

    if (t instanceof HTMLInputElement && t.hasAttribute('data-rename')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        await this.commitRename(t);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.renamingId = null;
        this.renderContent();
      }
      return;
    }
    if (t instanceof HTMLInputElement && t.hasAttribute('data-prop')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        await this.applyProps();
      }
      return;
    }

    if (!this.finderHasFocus()) return;
    if (this.isEditingField(t)) return;
    if (this.preview) {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        this.closePreview();
      }
      return;
    }
    if (this.contextMenu) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.contextMenu = null;
        this.renderContextMenu();
      }
      return;
    }
    if (this.openCallout) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.openCallout = null;
        this.renderCallouts();
      }
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    // View: ⌘1 / ⌘2 / ⌘3
    if (mod && !e.shiftKey && !e.altKey && (key === '1' || key === '2' || key === '3')) {
      e.preventDefault();
      const modes: ViewMode[] = ['icon', 'list', 'column'];
      await this.setView(modes[Number(key) - 1]!);
      return;
    }

    // Quick Look: Space
    if (key === ' ' && !mod && !e.altKey) {
      e.preventDefault();
      if (!this.selectionSupportsPreview()) return;
      await this.openPreview();
      return;
    }

    // Delete: Delete | ⌘⌫ | Ctrl+D
    if (
      key === 'Delete' ||
      (mod && key === 'Backspace') ||
      (e.ctrlKey && !e.metaKey && !e.altKey && lower === 'd')
    ) {
      e.preventDefault();
      await this.onDelete();
      return;
    }

    // Rename: Enter | F2
    if ((key === 'Enter' && !e.altKey && !mod) || key === 'F2') {
      e.preventDefault();
      this.startRename();
      return;
    }

    // Get Info: ⌘I | Alt+Enter
    if ((mod && lower === 'i' && !e.shiftKey) || (e.altKey && key === 'Enter')) {
      e.preventDefault();
      this.showPropertiesPanel();
      return;
    }

    // Back: ⌘[ | Backspace | Alt+←
    if ((mod && key === '[') || (key === 'Backspace' && !mod && !e.altKey) || (e.altKey && key === 'ArrowLeft')) {
      e.preventDefault();
      await this.goNavBack();
      return;
    }

    // Forward: ⌘] | Alt+→
    if ((mod && key === ']') || (e.altKey && key === 'ArrowRight')) {
      e.preventDefault();
      await this.goNavForward();
      return;
    }

    // Up: ⌘↑ | Alt+↑
    if ((mod || e.altKey) && key === 'ArrowUp') {
      e.preventDefault();
      await this.goUp();
      return;
    }

    // Cut / Copy / Paste
    if (mod && !e.shiftKey && !e.altKey && lower === 'x') {
      e.preventDefault();
      await this.cutSelection();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && lower === 'c') {
      e.preventDefault();
      await this.copySelection();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && lower === 'v') {
      e.preventDefault();
      await this.pasteClipboard();
      return;
    }

    // New folder: ⌘⇧N | Ctrl⇧N
    if (mod && e.shiftKey && !e.altKey && lower === 'n') {
      e.preventDefault();
      await this.onMkdir();
    }
  }

  private renameBusy = false;
  private async commitRename(input: HTMLInputElement): Promise<void> {
    if (this.renameBusy || !input.hasAttribute('data-rename')) return;
    this.renameBusy = true;
    const id = parseRefKey(input.getAttribute('data-rename'));
    const name = this.catalogName(input.value.trim());
    input.removeAttribute('data-rename');
    this.renamingId = null;
    try {
      if (!name || id == null) {
        this.renderContent();
        return;
      }
      const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
      if (!node) return;
      if (node.name !== name) {
        const parent = await this.resolveNative(parentRef(node), this.findNodeAnywhere(parentRef(node)));
        const dest = await this.resolveNative(id, node);
        const clash = await parent.cat.lookup(parent.ref, name);
        if (clash && nodeRef(clash) !== dest.ref) {
          this.setStatus(`“${name}” already exists`);
          this.renamingId = id;
          this.renderContent();
          return;
        }
        await this.withOwnVfsMutation(() => dest.cat.rename(dest.ref, name));
      }
      await this.reload();
      this.renderContent();
      if (this.showProps) this.refreshPropsPanel();
    } finally {
      this.renameBusy = false;
    }
  }

  // Commit rename on blur via delegated listener once
  private renameBlurBound = false;
  private ensureRenameBlur(): void {
    if (this.renameBlurBound) return;
    this.renameBlurBound = true;
    this.addEventListener(
      'focusout',
      (e) => {
        const t = e.target as HTMLElement;
        if (t instanceof HTMLInputElement && t.hasAttribute('data-rename')) {
          // Replacing innerHTML disconnects the input; don't treat that as a commit.
          if (!t.isConnected) return;
          void this.commitRename(t);
        }
      },
      true,
    );
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  }
}

function decodePreviewText(data: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    text = decodeMacRoman(data);
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

customElements.define('finder-window', FinderWindow);

export function downloadAppleDoubleZip(
  name: string,
  data: Uint8Array,
  resource: Uint8Array,
  finderInfo: Uint8Array,
  style: ZipExportStyle = loadPrefs().zipExportStyle,
): void {
  downloadZipEntries(name, [
    { name, data },
    { name: zipSidecarPath(name, style), data: buildAppleDouble(finderInfo, resource) },
  ]);
}

export function downloadZipEntries(zipName: string, files: { name: string; data: Uint8Array }[]): void {
  const zip = zipStore(files);
  const blob = new Blob([zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer], {
    type: 'application/zip',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = zipName.endsWith('.zip') ? zipName : `${zipName}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}
