import type { Catalog, VNode } from '../fs/virtual-fs';
import type { LookupResult } from '../services/nbp';
import type { AfpCredentials, AfpServerInfo } from '../services/afp-client/client';
import { fromMacTime } from '../protocol/afp/constants';
import { buildAppleDouble, zipStore } from '../fs/appledouble';
import { formatBytes } from './format-bytes';
import { iconCache, readTypeCreator, isCustomFolderIconName, isFinderInvisible, type IconUrls } from '../fs/icon-cache';
import { loadPrefs, savePrefs } from '../util/prefs';
import { log } from '../util/logger';

export type ViewMode = 'icon' | 'list' | 'column';
export type SortKey = 'name' | 'modified' | 'size';

export interface FinderHost {
  connectSerial(): Promise<void>;
  disconnectSerial(): Promise<void>;
  refreshNetwork(): Promise<LookupResult[]>;
  beginRemote(host: LookupResult): Promise<AfpServerInfo>;
  loginRemote(creds: AfpCredentials): Promise<string[]>;
  openRemoteVolume(name: string): Promise<Catalog>;
  findServer(nbpName: string): Promise<LookupResult | null>;
  promptCredentials(opts: {
    serverName: string;
    uams: string[];
    error?: string;
    allowGuest: boolean;
  }): Promise<AfpCredentials | null>;
  dismissLogin(): void;
  closeRemote(): Promise<void>;
  localCatalog(): Catalog;
  remoteMeta(): {
    nbpName: string;
    serverName: string;
    volumeName: string;
    volumes: string[];
    loggedIn: boolean;
  } | null;
  isConnected(): boolean;
  nodeLabel(): string;
}

interface ListItem {
  key: string;
  name: string;
  isDir: boolean;
  size: number;
  mod: Date;
  node: VNode | null;
  finderInfo?: Uint8Array;
}

/** On-disk size for Finder lists: data fork + resource fork. */
function nodeByteSize(n: VNode): number {
  if (n.isDir) return 0;
  return (n.dataBytes ?? n.data.length) + (n.resourceBytes ?? n.resource.length);
}

export class FinderWindow extends HTMLElement {
  private vfs!: Catalog;
  private localVfs: Catalog | null = null;
  private host!: FinderHost;
  private view: ViewMode = 'icon';
  private cwd = 2;
  private pathStack: { id: number; name: string }[] = [{ id: 2, name: 'Browser Share' }];
  /** For column view: one column of children per pathStack entry. */
  private columnChildren: VNode[][] = [];
  private selectedId: number | null = null;
  private nodes: VNode[] = [];
  private servers: LookupResult[] = [];
  private source: 'local' | 'remote' = 'local';
  private status = 'Connect a TashTalk adaptor to begin.';
  private statusBusy = false;
  private showProps = false;
  private remoteOpen = false;
  /** True after AFP login; volumes listed under the server until eject. */
  private remoteLoggedIn = false;
  private remoteVolumes: string[] = [];
  private remoteBusy = false;
  private remoteNbpName = '';
  private remoteLookup: LookupResult | null = null;
  private eventsBound = false;
  private dragDepth = 0;
  /** Folder ids expanded in list-view outline. */
  private expandedIds = new Set<number>();
  private listChildCache = new Map<number, VNode[]>();
  /** Skip pushState while applying browser back/forward. */
  private historyQuiet = false;
  /** In-app navigation stack for ⌘[/]/ shortcuts (separate from leaving the page). */
  private navStack: ReturnType<FinderWindow['historySnapshot']>[] = [];
  private navIndex = -1;
  private navLock = false;
  private sortKey: SortKey = 'name';
  private sortDir: 'asc' | 'desc' = 'asc';
  private renamingId: number | null = null;
  private clipboard: { mode: 'cut' | 'copy'; ids: number[] } | null = null;
  private contextMenu: { x: number; y: number; targetId: number | null } | null = null;
  /** Show Finder-invisible / Icon\\r items (persisted via prefs). */
  private showHiddenFiles = loadPrefs().showHiddenFiles;
  /** Local item being dragged (null for external file drops). */
  private dragNodeId: number | null = null;
  private dropHoverFolderId: number | null = null;
  private springTimer: ReturnType<typeof setTimeout> | null = null;
  private springFolderId: number | null = null;
  private vfsUnsub: (() => void) | null = null;
  private vfsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Parent folder ids coalesced from VFS change events until the debounced refresh. */
  private pendingVfsParents = new Set<number>();
  /** Resolved icon URLs keyed by ListItem.key (or type|creator). */
  private iconUrls = new Map<string, IconUrls>();
  private iconLoadGen = 0;

  /** Drop resolved icons after Advanced → Clear icon cache. */
  invalidateIcons(): void {
    this.iconUrls.clear();
    this.iconLoadGen++;
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

  bind(vfs: Catalog, host: FinderHost): void {
    this.localVfs = vfs;
    this.attachCatalog(vfs);
    this.host = host;
    this.ensureShellEvents();
    void this.bootstrapFromLocation();
  }

  private attachCatalog(next: Catalog): void {
    if (this.vfs === next) return;
    this.vfsUnsub?.();
    this.vfs = next;
    this.vfsUnsub = next.subscribe((change) => this.onVfsChanged(change));
    this.expandedIds.clear();
    this.listChildCache.clear();
    this.columnChildren = [];
    this.clipboard = null;
    this.iconUrls.clear();
    this.iconLoadGen++;
  }

  private mountCatalog(cat: Catalog, source: 'local' | 'remote', rootName: string): void {
    this.attachCatalog(cat);
    this.source = source;
    this.cwd = cat.rootId();
    this.pathStack = [{ id: this.cwd, name: rootName }];
    this.selectedId = null;
    this.renamingId = null;
    this.showProps = false;
  }

  /** Drop a remote mount (server CloseSession / disconnect attention). */
  unmountRemote(status?: string): void {
    const local = this.localVfs ?? this.host?.localCatalog();
    if (local) this.mountCatalog(local, 'local', 'Browser Share');
    this.remoteOpen = false;
    this.remoteLoggedIn = false;
    this.remoteVolumes = [];
    this.remoteNbpName = '';
    this.remoteLookup = null;
    if (status) this.setStatus(status);
    void this.reload().then(() => {
      this.syncHistory();
      this.render();
    });
  }

  disconnectedCallback(): void {
    this.vfsUnsub?.();
    this.vfsUnsub = null;
    if (this.vfsRefreshTimer) {
      clearTimeout(this.vfsRefreshTimer);
      this.vfsRefreshTimer = null;
    }
  }

  /** AFP / local mutations land here; debounce so fork writes don't thrash the UI. */
  private onVfsChanged(change: { parentIds: number[] }): void {
    for (const id of change.parentIds) this.pendingVfsParents.add(id);
    if (this.vfsRefreshTimer) clearTimeout(this.vfsRefreshTimer);
    this.vfsRefreshTimer = setTimeout(() => {
      this.vfsRefreshTimer = null;
      const parents = [...this.pendingVfsParents];
      this.pendingVfsParents.clear();
      if (!this.changeImpactsVisibleFolders(parents)) return;
      iconCache.clearDirectoryCache();
      this.iconUrls.clear();
      this.iconLoadGen++;
      void this.refreshAfterMutation();
    }, 150);
  }

  /** True when a mutation's parent is a folder whose children are currently shown. */
  private changeImpactsVisibleFolders(parentIds: number[]): boolean {
    if (parentIds.length === 0) return true;
    const visible = this.visibleFolderIds();
    return parentIds.some((id) => visible.has(id));
  }

  private visibleFolderIds(): Set<number> {
    const ids = new Set<number>();
    ids.add(this.cwd);
    for (const p of this.pathStack) ids.add(p.id);
    for (const id of this.expandedIds) ids.add(id);
    return ids;
  }

  private async bootstrapFromLocation(): Promise<void> {
    await this.applyHistoryState(this.stateFromLocation());
    this.syncHistory(true);
    this.render();
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

  setServers(list: LookupResult[]): void {
    this.servers = list;
    if (
      this.remoteLoggedIn &&
      this.remoteLookup &&
      !list.some((s) => s.object === this.remoteLookup!.object && s.node === this.remoteLookup!.node)
    ) {
      this.servers = [this.remoteLookup, ...list];
    }
    this.renderSidebar();
  }

  connectedCallback(): void {
    this.ensureShellEvents();
    if (this.vfs && this.host) this.render();
  }

  private ensureShellEvents(): void {
    if (this.eventsBound) return;
    this.eventsBound = true;
    this.addEventListener('click', (e) => void this.onClick(e));
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
    if (state.source === 'remote' && state.share) {
      params.set('share', state.share);
      if (state.vol) params.set('vol', state.vol);
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
      viewParam === 'list' || viewParam === 'column' || viewParam === 'icon' ? viewParam : 'icon';
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
    const meta = this.host.remoteMeta();
    return {
      view: this.view,
      source: this.source,
      share: this.source === 'remote' ? this.remoteNbpName || meta?.nbpName || '' : '',
      vol: this.source === 'remote' ? meta?.volumeName || this.pathStack[0]?.name || '' : '',
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
    try {
      this.view = state.view;
      this.selectedId = null;
      if (state.source === 'remote' && state.share) {
        if (!this.host.isConnected()) {
          this.setStatus(`Connect serial to open share “${state.share}”`);
          this.resetToLocalShare();
          await this.reload();
          return;
        }
        const metaNow = this.host.remoteMeta();
        const already =
          !!metaNow?.loggedIn && metaNow.nbpName.toLowerCase() === state.share.toLowerCase();
        if (!already) {
          const hit = await this.host.findServer(state.share);
          if (!hit) {
            this.setStatus(`Could not find AFP server “${state.share}”`);
            this.resetToLocalShare();
            await this.reload();
            return;
          }
          const ok = await this.connectServerWithLogin(hit);
          if (!ok) {
            this.resetToLocalShare();
            await this.reload();
            return;
          }
        } else {
          this.remoteNbpName = metaNow!.nbpName;
          this.remoteLoggedIn = true;
          this.remoteVolumes = metaNow!.volumes;
        }
        if (state.vol) {
          await this.mountRemoteVolume(state.vol);
          this.pathStack = await this.resolvePathNames(state.path, state.vol);
          this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
          await this.reload();
        } else {
          this.resetToLocalShare();
          await this.reload();
        }
      } else {
        await this.host.closeRemote();
        this.resetToLocalShare();
        this.pathStack = await this.resolvePathNames(state.path, 'Browser Share');
        this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
        await this.reload();
      }
    } finally {
      this.historyQuiet = false;
    }
  }

  private resetToLocalShare(): void {
    const local = this.localVfs ?? this.host.localCatalog();
    this.mountCatalog(local, 'local', 'Browser Share');
    this.remoteOpen = false;
    this.remoteLoggedIn = false;
    this.remoteVolumes = [];
    this.remoteLookup = null;
    this.remoteNbpName = '';
  }

  private async resolvePathNames(names: string[], rootName?: string): Promise<{ id: number; name: string }[]> {
    const rootId = this.vfs.rootId();
    const stack: { id: number; name: string }[] = [
      { id: rootId, name: rootName ?? this.pathStack[0]?.name ?? 'Browser Share' },
    ];
    let parent = rootId;
    for (const name of names) {
      const node = await this.vfs.lookup(parent, name);
      if (!node?.isDir) break;
      stack.push({ id: node.id, name: node.name });
      parent = node.id;
    }
    return stack;
  }

  private async reload(): Promise<void> {
    if (!this.vfs) return;
    this.nodes = this.sortNodes(await this.vfs.children(this.cwd));
    this.listChildCache.set(this.cwd, this.nodes);
    for (const id of [...this.expandedIds]) {
      this.listChildCache.set(id, this.sortNodes(await this.vfs.children(id)));
    }
    await this.refreshColumns();
  }

  private async refreshColumns(): Promise<void> {
    this.columnChildren = [];
    for (const step of this.pathStack) {
      this.columnChildren.push(this.sortNodes(await this.vfs.children(step.id)));
    }
  }

  private sortNodes(nodes: VNode[]): VNode[] {
    const list = nodes.filter((n) => this.isVisibleInFinder(n.name, n.finderInfo));
    const dir = this.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
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
  private isVisibleInFinder(name: string, finderInfo?: Uint8Array): boolean {
    if (this.showHiddenFiles) return true;
    if (isCustomFolderIconName(name)) return false;
    if (finderInfo && isFinderInvisible(finderInfo)) return false;
    return true;
  }

  private currentItems(): ListItem[] {
    return this.nodes.map((n) => ({
      key: String(n.id),
      name: n.name,
      isDir: n.isDir,
      size: nodeByteSize(n),
      mod: fromMacTime(n.modDate),
      node: n,
      finderInfo: n.finderInfo,
    }));
  }

  private selectedNode(): VNode | null {
    if (this.selectedId == null) return null;
    return this.findNodeAnywhere(this.selectedId);
  }

  private findNodeAnywhere(id: number): VNode | null {
    const direct = this.nodes.find((n) => n.id === id);
    if (direct) return direct;
    for (const kids of this.listChildCache.values()) {
      const n = kids.find((x) => x.id === id);
      if (n) return n;
    }
    return this.findInColumns(id) ?? null;
  }

  private render(): void {
    if (!this.host) return;
    this.innerHTML = `
      <div class="titlebar">
        <div class="brand">ClassicStack</div>
        <div class="spacer"></div>
        <span class="node-label" style="font-size:12px;color:var(--text-muted)">${this.escape(this.host.nodeLabel())}</span>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-act="connect">${this.host.isConnected() ? 'Disconnect' : 'Connect Serial'}</button>
        <button class="btn" data-act="refresh" ${this.host.isConnected() ? '' : 'disabled'}>Refresh Network</button>
        <button class="btn" data-act="mkdir">New Folder</button>
        <button class="btn" data-act="delete">Delete</button>
        <button class="btn ${this.showProps ? 'active' : ''}" data-act="props" aria-pressed="${this.showProps}">Properties</button>
        <button class="btn" data-act="download">Download Zip</button>
        <label class="sort-wrap">
          <span>Sort</span>
          <select data-sort>
            <option value="name" ${this.sortKey === 'name' ? 'selected' : ''}>Name</option>
            <option value="modified" ${this.sortKey === 'modified' ? 'selected' : ''}>Date Modified</option>
            <option value="size" ${this.sortKey === 'size' ? 'selected' : ''}>Size</option>
          </select>
        </label>
        <div class="spacer"></div>
        <div class="view-toggle">
          <button type="button" data-view="icon" class="${this.view === 'icon' ? 'active' : ''}">Icons</button>
          <button type="button" data-view="list" class="${this.view === 'list' ? 'active' : ''}">List</button>
          <button type="button" data-view="column" class="${this.view === 'column' ? 'active' : ''}">Columns</button>
        </div>
      </div>
      <div class="body">
        <aside class="sidebar"></aside>
        <section class="main">
          <div class="pathbar"></div>
          <div class="content" tabindex="0"></div>
        </section>
      </div>
      <div class="status${this.statusBusy ? ' status--busy' : ''}">${
        this.statusBusy
          ? `<span class="status-spinner" aria-hidden="true"></span><span>${this.escape(this.status)}</span>`
          : this.escape(this.status)
      }</div>
      <div class="ctx-root"></div>
      <div class="drag-portal" aria-hidden="true"></div>
    `;
    this.renderSidebar();
    this.renderPath();
    this.renderContent();
    this.renderContextMenu();
    this.bindToolbarExtras();
  }

  private syncPropsButton(): void {
    const btn = this.querySelector('[data-act="props"]');
    btn?.classList.toggle('active', this.showProps);
    btn?.setAttribute('aria-pressed', String(this.showProps));
  }

  private bindToolbarExtras(): void {
    const sel = this.querySelector('[data-sort]') as HTMLSelectElement | null;
    sel?.addEventListener('change', () => {
      this.sortKey = (sel.value as SortKey) || 'name';
      this.sortDir = 'asc';
      void this.reload().then(() => this.renderContent());
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
    const localSel = this.source === 'local' ? 'selected' : '';
    const meta = this.host?.remoteMeta?.() ?? null;
    const connectedName = this.remoteNbpName || meta?.nbpName || '';
    const volumes = this.remoteVolumes.length ? this.remoteVolumes : (meta?.volumes ?? []);
    const openVol = this.source === 'remote' && this.remoteOpen ? (meta?.volumeName || this.pathStack[0]?.name || '') : '';
    const servers = this.servers
      .map((s, i) => {
        const connected =
          this.remoteLoggedIn &&
          (s.object === connectedName ||
            (this.remoteLookup != null && s.node === this.remoteLookup.node && s.socket === this.remoteLookup.socket));
        const serverSel = connected && !openVol ? 'selected' : '';
        const kids =
          connected && volumes.length
            ? volumes
                .map(
                  (v, vi) => `
      <div class="side-item side-item--child ${openVol === v ? 'selected' : ''}" data-vol="${vi}" data-server="${i}">
        <span class="dot"></span>
        <span class="side-item-label">${this.escape(v)}</span>
      </div>`,
                )
                .join('')
            : '';
        const eject = connected
          ? `<button type="button" class="side-eject" data-eject="${i}" title="Disconnect">Eject</button>`
          : '';
        return `
      <div class="side-item ${serverSel}" data-server="${i}">
        <span class="dot"></span>
        <span class="side-item-label">${this.escape(s.object)}</span>
        ${eject}
      </div>${kids}`;
      })
      .join('');
    side.innerHTML = `
      <div class="side-label">Favorites</div>
      <div class="side-item ${localSel}" data-local>
        <span class="dot"></span>
        <span>Browser Share</span>
      </div>
      <div class="side-label">LocalTalk</div>
      ${servers || '<div class="side-item"><span class="dot off"></span><span>No AFP servers</span></div>'}
    `;
  }

  private renderPath(): void {
    const bar = this.querySelector('.pathbar');
    if (!bar) return;
    type Crumb = { name: string; id?: number; index: number };
    const crumbs: Crumb[] = this.pathStack.map((p, i) => ({
      name:
        i === 0 && this.source === 'remote' && this.remoteNbpName
          ? `${this.remoteNbpName}:${p.name}`
          : p.name || 'Browser Share',
      id: p.id,
      index: i,
    }));

    bar.innerHTML = crumbs
      .map((p, i) => {
        const label = this.escape(p.name);
        const current = i === crumbs.length - 1;
        const dropAttr = p.id != null ? `data-path-id="${p.id}"` : '';
        const sep = i > 0 ? `<span class="crumb-sep" aria-hidden="true">&gt;</span>` : '';
        const urls = p.id != null ? this.iconUrls.get(String(p.id)) : undefined;
        const icon = urls
          ? `<img class="crumb-icon-img" src="${this.escape(urls.small)}" alt="" width="16" height="16" draggable="false" />`
          : `<span class="crumb-icon ${i === 0 ? 'root' : 'folder'}" aria-hidden="true"></span>`;
        return `${sep}<button type="button" class="crumb${current ? ' current' : ''}" data-path-index="${p.index}" ${dropAttr} title="${label}">
          ${icon}
          <span class="crumb-label">${label}</span>
        </button>`;
      })
      .join('');

    this.prefetchPathIcons(crumbs);
  }

  /** Load 16px folder icons for path crumbs (local share). */
  private prefetchPathIcons(crumbs: { id?: number }[]): void {
    const gen = this.iconLoadGen;
    for (const c of crumbs) {
      if (c.id == null) continue;
      const key = String(c.id);
      if (this.iconUrls.has(key)) continue;
      void (async () => {
        try {
          await iconCache.init();
          const node = await this.vfs.get(c.id!);
          if (!node) {
            const urls = { small: '/icons/DIR16.png', large: '/icons/DIR32.png' };
            if (gen !== this.iconLoadGen) return;
            this.iconUrls.set(key, urls);
            this.patchIconInDom(key, urls);
            return;
          }
          const urls = await iconCache.getForNode(node, (id, name) => this.vfs.lookup(id, name));
          if (gen !== this.iconLoadGen) return;
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

    let iconItems: ListItem[] = [];

    if (this.view === 'column') {
      content.innerHTML = this.renderColumnView();
      iconItems = this.columnIconItems();
    } else {
      const items = this.currentItems();
      iconItems = items;
      if (items.length === 0) {
        content.innerHTML = `<div class="empty">Drop files or folders here, or browse the LocalTalk network.</div>`;
      } else if (this.view === 'icon') {
        content.innerHTML = `<div class="icon-grid">${items.map((it) => this.iconHtml(it)).join('')}</div>`;
      } else if (this.view === 'list') {
        const rows = this.buildOutlineRows(this.nodes, 0);
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
          .map((it) => this.colItemHtml(it, 0, this.selectedId))
          .join('')}</div></div>`;
      }

      if (this.showProps) {
        const sel = this.selectedNode();
        if (sel) content.insertAdjacentHTML('beforeend', this.itemInfoHtml(sel, { variant: 'dialog' }));
      }
    }

    if (this.view === 'column') {
      this.scrollColumnsToEnd();
    }
    this.focusRenameInput();
    if (iconItems.length) this.prefetchIcons(iconItems);
  }

  private columnIconItems(): ListItem[] {
    const out: ListItem[] = [];
    for (const kids of this.columnChildren) {
      for (const n of kids) {
        out.push({
          key: String(n.id),
          name: n.name,
          isDir: n.isDir,
          size: nodeByteSize(n),
          mod: fromMacTime(n.modDate),
          node: n,
          finderInfo: n.finderInfo,
        });
      }
    }
    return out;
  }

  /** Update only the floating properties card so item DOM (and dblclick) survives. */
  private refreshPropsPanel(): void {
    if (this.view === 'column') {
      this.renderContent();
      return;
    }
    const content = this.querySelector('.content');
    if (!content) return;
    content.querySelectorAll('.item-info--dialog').forEach((el) => el.remove());
    if (this.showProps) {
      const sel = this.selectedNode();
      if (sel) content.insertAdjacentHTML('beforeend', this.itemInfoHtml(sel, { variant: 'dialog' }));
    }
  }

  private focusRenameInput(): void {
    if (this.renamingId == null) return;
    requestAnimationFrame(() => {
      const input = this.querySelector(`input[data-rename="${this.renamingId}"]`) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    });
  }

  private nameLabelHtml(it: ListItem): string {
    if (this.renamingId != null && it.key === String(this.renamingId)) {
      return `<input class="rename-input" data-rename="${it.key}" value="${this.escape(it.name)}" />`;
    }
    return `<span class="row-name item-label">${this.escape(it.name)}</span>`;
  }

  private scrollColumnsToEnd(): void {
    const scroller = this.querySelector('.column-view') as HTMLElement | null;
    if (!scroller) return;
    requestAnimationFrame(() => {
      scroller.scrollLeft = scroller.scrollWidth;
    });
  }

  private buildOutlineRows(nodes: VNode[], depth: number): { item: ListItem; depth: number }[] {
    const rows: { item: ListItem; depth: number }[] = [];
    for (const n of nodes) {
      const item: ListItem = {
        key: String(n.id),
        name: n.name,
        isDir: n.isDir,
        size: nodeByteSize(n),
        mod: fromMacTime(n.modDate),
        node: n,
        finderInfo: n.finderInfo,
      };
      rows.push({ item, depth });
      if (n.isDir && this.expandedIds.has(n.id)) {
        const kids = this.listChildCache.get(n.id) ?? [];
        rows.push(...this.buildOutlineRows(kids, depth + 1));
      }
    }
    return rows;
  }

  private iconHtml(it: ListItem): string {
    const sel = this.selectedId != null && it.key === String(this.selectedId) ? 'selected' : '';
    const drag = 'draggable="true"';
    return `<div class="icon-item ${sel}" data-id="${it.key}" data-dir="${it.isDir ? '1' : '0'}" ${drag}>
      ${this.glyphHtml(it, 'large', 'icon')}
      <div class="icon-name">${this.nameLabelHtml(it)}</div>
    </div>`;
  }

  private listRowHtml(it: ListItem, depth = 0): string {
    const sel = this.selectedId != null && it.key === String(this.selectedId) ? 'selected' : '';
    const id = Number(it.key);
    const expanded = it.isDir && this.expandedIds.has(id);
    const drag = 'draggable="true"';
    const disclose = it.isDir
      ? `<button type="button" class="disclose ${expanded ? 'open' : ''}" data-disclose="${it.key}" aria-label="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '▾' : '▸'}</button>`
      : `<span class="disclose spacer"></span>`;
    return `<tr data-id="${it.key}" data-dir="${it.isDir ? '1' : '0'}" class="${sel}" style="--depth:${depth}" ${drag}>
      <td class="name-cell">${disclose}${this.glyphHtml(it, 'small', 'row')}${this.nameLabelHtml(it)}</td>
      <td>${it.isDir ? '—' : formatBytes(it.size)}</td>
      <td>${it.mod.toLocaleString()}</td>
    </tr>`;
  }

  private colItemHtml(it: ListItem, colIndex: number, selectedInColumn: number | null): string {
    const sel = selectedInColumn != null && it.key === String(selectedInColumn) ? 'selected' : '';
    const drag = 'draggable="true"';
    const label =
      this.renamingId != null && it.key === String(this.renamingId)
        ? `<input class="rename-input" data-rename="${it.key}" value="${this.escape(it.name)}" />`
        : `<span class="col-name item-label">${this.escape(it.name)}</span>`;
    return `<div class="col-item ${sel}" data-id="${it.key}" data-dir="${it.isDir ? '1' : '0'}" data-col="${colIndex}" ${drag}>
      ${this.glyphHtml(it, 'small', 'col')}${label}
    </div>`;
  }

  private glyphHtml(it: ListItem, size: 'small' | 'large', kind: 'icon' | 'row' | 'col'): string {
    const urls = this.iconUrls.get(it.key);
    const px = size === 'large' ? 32 : 16;
    if (urls) {
      const src = size === 'large' ? urls.large : urls.small;
      const imgCls = kind === 'icon' ? 'icon-glyph-img' : kind === 'col' ? 'col-icon-img' : 'row-icon-img';
      return `<img class="${imgCls}" src="${this.escape(src)}" alt="" width="${px}" height="${px}" draggable="false" />`;
    }
    if (kind === 'icon') {
      return `<div class="icon-glyph ${it.isDir ? 'folder' : ''}">${it.isDir ? 'DIR' : 'DOC'}</div>`;
    }
    const cls = kind === 'col' ? (it.isDir ? 'col-icon folder' : 'col-icon file') : it.isDir ? 'row-icon folder' : 'row-icon file';
    return `<span class="${cls}" aria-hidden="true"></span>`;
  }

  /** Kick off icon resolution for visible items; patches DOM when ready. */
  private prefetchIcons(items: ListItem[]): void {
    const gen = ++this.iconLoadGen;
    void (async () => {
      await iconCache.init();
      let changed = false;
      await Promise.all(
        items.map(async (it) => {
          if (this.iconUrls.has(it.key)) return;
          try {
            let urls: IconUrls;
            if (it.node) {
              urls = await iconCache.getForNode(it.node, (id, name) => this.vfs.lookup(id, name));
            } else if (it.isDir) {
              urls = {
                small: '/icons/DIR16.png',
                large: '/icons/DIR32.png',
              };
            } else {
              const fi = it.finderInfo ?? new Uint8Array(32);
              const { type, creator } = readTypeCreator(fi);
              urls = await iconCache.getForTypeCreator(type, creator);
            }
            if (gen !== this.iconLoadGen) return;
            this.iconUrls.set(it.key, urls);
            changed = true;
            this.patchIconInDom(it.key, urls);
          } catch {
            /* keep placeholder */
          }
        }),
      );
      if (changed && gen === this.iconLoadGen) {
        /* patches already applied */
      }
    })();
  }

  private patchIconInDom(key: string, urls: IconUrls): void {
    const nodes = this.querySelectorAll(`[data-id="${key}"], [data-path-id="${key}"]`);
    for (const el of nodes) {
      const large = el.querySelector('.icon-glyph, .icon-glyph-img');
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
      const preview = el.querySelector('.preview-glyph, .preview-glyph-img');
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
      const crumb = el.querySelector('.crumb-icon, .crumb-icon-img');
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
      const small = el.querySelector('.row-icon, .col-icon, .row-icon-img, .col-icon-img');
      if (small) {
        const img = document.createElement('img');
        img.className =
          small.classList.contains('col-icon') || small.classList.contains('col-icon-img')
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

  /** Id to highlight in a column: path crumb, or leaf file selection in the deepest list column. */
  private columnSelectionId(colIndex: number, kids: VNode[], listColCount: number): number | null {
    const pathSel = this.pathStack[colIndex + 1]?.id ?? null;
    if (pathSel != null) return pathSel;
    if (colIndex === listColCount - 1 && this.selectedId != null) {
      const leaf = kids.find((k) => k.id === this.selectedId);
      if (leaf && !leaf.isDir) return this.selectedId;
    }
    return null;
  }

  private columnPreviewNode(): VNode | null {
    if (this.selectedId == null) return null;
    const node = this.findNodeAnywhere(this.selectedId);
    if (!node) return null;
    // Files always show preview when selected; folders when Properties is open
    if (!node.isDir) {
      for (const kids of this.columnChildren) {
        if (kids.some((k) => k.id === node.id)) return node;
      }
      return null;
    }
    if (this.showProps) return node;
    return null;
  }

  /** Shared item info card — used by column-view preview and Properties. */
  private itemInfoHtml(node: VNode, opts: { variant: 'column' | 'dialog' }): string {
    const fi = node.finderInfo;
    const type = String.fromCharCode(...fi.subarray(0, 4));
    const creator = String.fromCharCode(...fi.subarray(4, 8));
    const kind = node.isDir ? 'Folder' : 'File';
    const glyphClass = node.isDir ? 'folder' : 'file';
    const urls = this.iconUrls.get(String(node.id));
    const glyph = urls
      ? `<img class="preview-glyph-img" src="${this.escape(urls.large)}" alt="" width="32" height="32" draggable="false" />`
      : `<div class="preview-glyph ${glyphClass}"></div>`;
    const closeBtn =
      opts.variant === 'dialog'
        ? `<button type="button" class="btn item-info-close" data-act="close-props">Close</button>`
        : '';
    const shellClass =
      opts.variant === 'column'
        ? 'column column-preview item-info'
        : 'item-info item-info--dialog';
    if (!urls) this.ensureNodeIcon(node);
    const typeCreatorFields = node.isDir
      ? ''
      : `<div class="preview-fields">
        <label>Type</label>
        <input data-prop="type" maxlength="4" value="${this.escape(type)}" />
        <label>Creator</label>
        <input data-prop="creator" maxlength="4" value="${this.escape(creator)}" />
        <div class="preview-actions">
          <button type="button" class="btn primary" data-act="apply-props">Apply</button>
          ${closeBtn}
        </div>
      </div>`;
    const folderActions = node.isDir && closeBtn
      ? `<div class="preview-actions">${closeBtn}</div>`
      : '';
    return `<div class="${shellClass}" data-preview data-id="${node.id}">
      <div class="preview-hero">
        ${glyph}
        <div class="preview-title">${this.escape(node.name)}</div>
      </div>
      <div class="preview-meta">
        <div class="preview-row"><span>Kind</span><span>${kind}</span></div>
        <div class="preview-row"><span>Size</span><span>${node.isDir ? '—' : formatBytes(nodeByteSize(node))}</span></div>
        ${node.isDir ? '' : `<div class="preview-row"><span>Resource</span><span>${formatBytes(node.resourceBytes ?? node.resource.length)}</span></div>`}
        <div class="preview-row"><span>Created</span><span>${fromMacTime(node.createDate).toLocaleString()}</span></div>
        <div class="preview-row"><span>Modified</span><span>${fromMacTime(node.modDate).toLocaleString()}</span></div>
      </div>
      ${typeCreatorFields}
      ${folderActions}
    </div>`;
  }

  /** Resolve icon for a single node and patch list + properties glyphs. */
  private ensureNodeIcon(node: VNode): void {
    const key = String(node.id);
    if (this.iconUrls.has(key)) return;
    const gen = this.iconLoadGen;
    void (async () => {
      try {
        await iconCache.init();
        const urls = await iconCache.getForNode(node, (id, name) => this.vfs.lookup(id, name));
        if (gen !== this.iconLoadGen) return;
        this.iconUrls.set(key, urls);
        this.patchIconInDom(key, urls);
      } catch {
        /* keep placeholder */
      }
    })();
  }

  private renderColumnView(): string {
    if (this.columnChildren.length === 0) {
      return `<div class="column-view"><div class="column"><div class="empty">Drop files or folders here</div></div></div>`;
    }
    const listColCount = this.columnChildren.length;
    const cols = this.columnChildren
      .map((kids, colIndex) => {
        const selectedInColumn = this.columnSelectionId(colIndex, kids, listColCount);
        const items = kids.map((n) => ({
          key: String(n.id),
          name: n.name,
          isDir: n.isDir,
          size: nodeByteSize(n),
          mod: fromMacTime(n.modDate),
          node: n,
        }));
        const body =
          items.length === 0
            ? `<div class="empty" style="padding:16px;font-size:12px">Empty</div>`
            : items.map((it) => this.colItemHtml(it, colIndex, selectedInColumn)).join('');
        return `<div class="column" data-col-index="${colIndex}">${body}</div>`;
      })
      .join('');

    const preview = this.columnPreviewNode();
    const previewCol = preview ? this.itemInfoHtml(preview, { variant: 'column' }) : '';
    return `<div class="column-view">${cols}${previewCol}</div>`;
  }

  private itemFromEvent(e: Event): HTMLElement | null {
    const t = e.target as HTMLElement | null;
    return t?.closest?.('[data-id]') as HTMLElement | null;
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const t = e.target as HTMLElement;

    // Ignore clicks inside rename field (handled by blur/enter)
    if (t.closest('[data-rename]')) return;

    const ctxItem = t.closest('[data-ctx]') as HTMLElement | null;
    if (ctxItem) {
      e.preventDefault();
      const action = ctxItem.getAttribute('data-ctx')!;
      this.contextMenu = null;
      this.renderContextMenu();
      await this.handleContextAction(action);
      return;
    }
    if (this.contextMenu) {
      this.contextMenu = null;
      this.renderContextMenu();
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

    const act = t.closest('[data-act]')?.getAttribute('data-act');
    if (act) {
      await this.handleAction(act);
      return;
    }
    const viewBtn = t.closest('[data-view]');
    if (viewBtn) {
      this.view = (viewBtn.getAttribute('data-view') as ViewMode) || 'icon';
      this.syncHistory();
      this.render();
      return;
    }
    if (t.closest('[data-local]')) {
      this.resetToLocalShare();
      await this.reload();
      this.syncHistory();
      this.render();
      return;
    }
    const ejectEl = t.closest('[data-eject]');
    if (ejectEl) {
      e.preventDefault();
      e.stopPropagation();
      await this.ejectRemote();
      return;
    }
    const volEl = t.closest('[data-vol]');
    if (volEl) {
      const vi = Number(volEl.getAttribute('data-vol'));
      const name = this.remoteVolumes[vi];
      if (!name) return;
      try {
        await this.mountRemoteVolume(name);
        await this.reload();
        this.syncHistory();
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
      if (this.remoteLoggedIn && this.remoteNbpName === s.object) {
        this.renderSidebar();
        return;
      }
      await this.connectServerWithLogin(s);
      this.render();
      return;
    }

    const disclose = t.closest('[data-disclose]') as HTMLElement | null;
    if (disclose && this.view === 'list') {
      e.preventDefault();
      e.stopPropagation();
      const id = Number(disclose.getAttribute('data-disclose'));
      await this.toggleExpand(id);
      return;
    }

    const item = this.itemFromEvent(e);
    if (!item || !this.querySelector('.content')?.contains(item)) return;

    const id = Number(item.getAttribute('data-id'));
    const isDir = item.getAttribute('data-dir') === '1';
    this.selectedId = id;

    if (this.view === 'column') {
      const colIndex = Number(item.getAttribute('data-col') ?? '0');
      const beforePath = this.pathNamesForUrl().join('/');
      this.pathStack = this.pathStack.slice(0, colIndex + 1);
      if (isDir) {
        const node = this.findInColumns(id) ?? this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
        if (node?.isDir) {
          this.pathStack.push({ id: node.id, name: node.name });
          this.cwd = node.id;
        }
      } else {
        this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
      }
      this.nodes = this.sortNodes(await this.vfs.children(this.cwd));
      await this.refreshColumns();
      this.renderPath();
      this.renderContent();
      if (beforePath !== this.pathNamesForUrl().join('/')) this.syncHistory();
      return;
    }

    this.paintSelection(item);
    // Don't remount the file plane when Properties is open — preserves dblclick.
    if (this.showProps) this.refreshPropsPanel();
  }

  private async toggleExpand(id: number): Promise<void> {
    if (this.expandedIds.has(id)) {
      this.expandedIds.delete(id);
      this.collapseDescendants(id);
    } else {
      this.expandedIds.add(id);
      const kids = this.sortNodes(await this.vfs.children(id));
      this.listChildCache.set(id, kids);
    }
    this.renderContent();
  }

  private collapseDescendants(id: number): void {
    const kids = this.listChildCache.get(id) ?? [];
    for (const k of kids) {
      if (k.isDir && this.expandedIds.has(k.id)) {
        this.expandedIds.delete(k.id);
        this.collapseDescendants(k.id);
      }
    }
  }

  private findInColumns(id: number): VNode | undefined {
    for (const col of this.columnChildren) {
      const n = col.find((x) => x.id === id);
      if (n) return n;
    }
    return this.nodes.find((n) => n.id === id);
  }

  private paintSelection(item: HTMLElement): void {
    this.querySelectorAll('.selected').forEach((el) => {
      if (el.classList.contains('side-item')) return;
      el.classList.remove('selected');
    });
    item.classList.add('selected');
  }

  private async onDblClick(e: MouseEvent): Promise<void> {
    const item = this.itemFromEvent(e);
    if (!item || !this.querySelector('.content')?.contains(item)) return;
    if (item.getAttribute('data-dir') !== '1') return;
    if (this.view === 'column') return;
    if ((e.target as HTMLElement).closest?.('[data-disclose]')) return;

    e.preventDefault();
    const id = Number(item.getAttribute('data-id'));

    const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
    if (!node?.isDir) return;
    await this.openFolder(node);
  }

  private async openFolder(node: VNode): Promise<void> {
    this.cwd = node.id;
    this.pathStack.push({ id: node.id, name: node.name });
    this.selectedId = null;
    this.expandedIds.clear();
    await this.reload();
    this.renderPath();
    this.renderContent();
    this.syncHistory();
  }

  private contentEl(): HTMLElement | null {
    return this.querySelector('.content');
  }

  private onDragStart(e: DragEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('[data-rename], [data-disclose]')) {
      e.preventDefault();
      return;
    }
    const item = this.itemFromEvent(e);
    if (!item || !this.contentEl()?.contains(item)) {
      e.preventDefault();
      return;
    }
    const id = Number(item.getAttribute('data-id'));
    this.dragNodeId = id;
    this.selectedId = id;
    e.dataTransfer?.setData('application/x-cs-node', String(id));
    e.dataTransfer!.effectAllowed = 'move';
    item.classList.add('dragging');
  }

  private onDragEnd(): void {
    this.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    this.dragNodeId = null;
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
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = this.isInternalDrag() ? 'move' : 'copy';
    }
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
    const id = Number(item.getAttribute('data-id'));
    if (this.dragNodeId === id) return null;
    return item;
  }

  /** Parent folder id represented by the column under the pointer. */
  private columnParentFromEvent(e: DragEvent): number | null {
    if (this.view !== 'column') return null;
    const t = e.target as HTMLElement | null;
    const col = t?.closest?.('[data-col-index]') as HTMLElement | null;
    if (!col || !this.contentEl()?.contains(col)) return null;
    const idx = Number(col.getAttribute('data-col-index'));
    if (!Number.isFinite(idx) || idx < 0) return null;
    return this.pathStack[idx]?.id ?? null;
  }

  /** Folder id from a path-bar crumb under the pointer, if any. */
  private pathDropIdFromEvent(e: DragEvent): number | null {
    const t = e.target as HTMLElement | null;
    const crumb = t?.closest?.('[data-path-id]') as HTMLElement | null;
    const bar = this.querySelector('.pathbar');
    if (!crumb || !bar?.contains(crumb)) return null;
    const id = Number(crumb.getAttribute('data-path-id'));
    return Number.isFinite(id) ? id : null;
  }

  private columnIndexFromEvent(e: DragEvent): number | null {
    if (this.view !== 'column') return null;
    const t = e.target as HTMLElement | null;
    const col = t?.closest?.('[data-col-index]') as HTMLElement | null;
    if (!col) return null;
    const idx = Number(col.getAttribute('data-col-index'));
    return Number.isFinite(idx) ? idx : null;
  }

  /** Destination parent id for a drop, or null if invalid. */
  private resolveDropParent(e: DragEvent): number | null {
    const pathId = this.pathDropIdFromEvent(e);
    if (pathId != null) return pathId;

    const content = this.contentEl();
    if (!content) return null;
    const item = this.itemFromEvent(e);
    if (item && content.contains(item)) {
      const id = Number(item.getAttribute('data-id'));
      if (this.dragNodeId === id) return null;
      if (item.getAttribute('data-dir') === '1') return id;
      const node = this.findNodeAnywhere(id);
      if (node) return node.parentId;
      return this.columnParentFromEvent(e) ?? this.cwd;
    }
    const colParent = this.columnParentFromEvent(e);
    if (colParent != null) return colParent;
    const t = e.target as Node | null;
    if (t && content.contains(t)) return this.cwd;
    return null;
  }

  private async updateDropHover(e: DragEvent): Promise<void> {
    const pathId = this.pathDropIdFromEvent(e);
    if (pathId != null) {
      if (this.isInternalDrag() && this.dragNodeId != null) {
        if (!(await this.isValidMoveTarget(this.dragNodeId, pathId))) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
          this.clearSpringTimer();
          this.paintDropTarget(null, false, null, null);
          return;
        }
      }
      this.clearSpringTimer();
      this.paintDropTarget(null, false, null, pathId);
      return;
    }

    const dest = this.resolveDropParent(e);
    const folderEl = this.folderUnderPointer(e);
    const folderId = folderEl ? Number(folderEl.getAttribute('data-id')) : null;
    const colIndex = this.columnIndexFromEvent(e);

    if (this.isInternalDrag() && dest != null && this.dragNodeId != null) {
      if (!(await this.isValidMoveTarget(this.dragNodeId, dest))) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        this.clearSpringTimer();
        this.paintDropTarget(null, false, null, null);
        return;
      }
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
    folderId: number | null,
    blankActive: boolean,
    columnIndex: number | null = null,
    pathId: number | null = null,
  ): void {
    this.dropHoverFolderId = folderId;
    this.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    this.querySelectorAll('.drop-target-col').forEach((el) => el.classList.remove('drop-target-col'));
    const content = this.contentEl();
    content?.classList.remove('drop-active');

    if (pathId != null) {
      this.querySelector(`.crumb[data-path-id="${pathId}"]`)?.classList.add('drop-target');
      return;
    }

    if (folderId != null) {
      const el =
        this.querySelector(`.col-item[data-id="${folderId}"]`) ??
        this.querySelector(`.icon-item[data-id="${folderId}"]`) ??
        this.querySelector(`tr[data-id="${folderId}"]`) ??
        this.querySelector(`[data-id="${folderId}"]`);
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
  }

  private async springLoadFolder(id: number): Promise<void> {
    this.springTimer = null;
    if (this.dropHoverFolderId !== id && this.springFolderId !== id) return;
    const node = (await this.vfs.get(id)) ?? this.findNodeAnywhere(id);
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
  private async springExpandList(id: number): Promise<void> {
    if (this.expandedIds.has(id)) return;
    this.expandedIds.add(id);
    const kids = this.sortNodes(await this.vfs.children(id));
    this.listChildCache.set(id, kids);
    const row = this.querySelector(`tr[data-id="${id}"]`) as HTMLTableRowElement | null;
    if (!row?.parentElement) {
      this.parkDragSource();
      this.renderContent();
      this.paintDropTarget(id, false);
      return;
    }
    const depth = Number(String(row.style.getPropertyValue('--depth') || '0'));
    const html = kids
      .map((n) =>
        this.listRowHtml(
          {
            key: String(n.id),
            name: n.name,
            isDir: n.isDir,
            size: nodeByteSize(n),
            mod: fromMacTime(n.modDate),
            node: n,
          },
          depth + 1,
        ),
      )
      .join('');
    row.insertAdjacentHTML('afterend', html);
    const disclose = row.querySelector('[data-disclose]');
    if (disclose) {
      disclose.classList.add('open');
      disclose.setAttribute('aria-label', 'Collapse');
      disclose.textContent = '▾';
    }
    this.paintDropTarget(id, false);
  }

  /** Navigate into a folder in icon view; park drag source so the gesture survives. */
  private async springOpenIcon(node: VNode): Promise<void> {
    if (this.cwd === node.id) return;
    // Only spring-open folders visible in the current directory.
    if (!this.nodes.some((n) => n.id === node.id)) {
      const visible = this.querySelector(`.icon-item[data-id="${node.id}"]`);
      if (!visible) return;
    }

    this.parkDragSource();
    this.cwd = node.id;
    this.pathStack.push({ id: node.id, name: node.name });
    this.selectedId = null;
    this.expandedIds.clear();
    await this.reload();
    this.renderPath();
    this.renderContent();
    this.syncHistory();
    this.clearSpringTimer();
    this.clearDropUi();
  }

  /** Open a folder into the next Miller column without remounting earlier columns (keeps drag alive). */
  private async springOpenColumn(node: VNode): Promise<void> {
    const colItem = this.querySelector(`.col-item[data-id="${node.id}"]`) as HTMLElement | null;
    if (!colItem) return;
    const colIndex = Number(colItem.getAttribute('data-col') ?? '0');
    if (this.pathStack[colIndex + 1]?.id === node.id) return;

    this.parkDragSource();

    this.pathStack = this.pathStack.slice(0, colIndex + 1);
    this.pathStack.push({ id: node.id, name: node.name });
    this.cwd = node.id;
    this.selectedId = null;

    const kids = this.sortNodes(await this.vfs.children(node.id));
    this.columnChildren = this.columnChildren.slice(0, colIndex + 1);
    this.columnChildren.push(kids);
    this.nodes = kids;

    const view = this.querySelector('.column-view');
    if (!view) {
      this.renderPath();
      this.renderContent();
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

    const body =
      kids.length === 0
        ? `<div class="empty" style="padding:16px;font-size:12px">Empty</div>`
        : kids
            .map((n) =>
              this.colItemHtml(
                {
                  key: String(n.id),
                  name: n.name,
                  isDir: n.isDir,
                  size: nodeByteSize(n),
                  mod: fromMacTime(n.modDate),
                  node: n,
                },
                colIndex + 1,
                null,
              ),
            )
            .join('');
    const newCol = document.createElement('div');
    newCol.className = 'column';
    newCol.setAttribute('data-col-index', String(colIndex + 1));
    newCol.innerHTML = body;
    parentCol?.after(newCol);

    this.renderPath();
    this.scrollColumnsToEnd();
    this.syncHistory();
    this.clearSpringTimer();
    this.paintDropTarget(node.id, false);
  }

  private async isValidMoveTarget(id: number, destParent: number): Promise<boolean> {
    if (id === destParent) return false;
    const node = await this.vfs.get(id);
    if (!node) return false;
    if (!node.isDir) return true;
    let cur: VNode | undefined = await this.vfs.get(destParent);
    while (cur) {
      if (cur.id === id) return false;
      if (!cur.parentId || cur.parentId === cur.id) break;
      cur = await this.vfs.get(cur.parentId);
    }
    return true;
  }

  private async moveNodeTo(id: number, destParent: number): Promise<void> {
    const node = await this.vfs.get(id);
    if (!node) return;
    if (node.parentId === destParent) return;
    if (!(await this.isValidMoveTarget(id, destParent))) {
      this.setStatus('Can’t move an item into itself');
      return;
    }
    const clash = await this.vfs.lookup(destParent, node.name);
    if (clash && clash.id !== id) {
      const name = await this.uniqueChildName(destParent, node.name);
      await this.vfs.rename(id, name);
    }
    await this.vfs.move(id, destParent);
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
      if (!node?.isDir || node.parentId !== kept[kept.length - 1]!.id) break;
      kept.push({ id: node.id, name: node.name });
    }
    this.pathStack = kept;
    this.cwd = kept[kept.length - 1]!.id;
  }

  private async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    const dest = this.resolveDropParent(e);
    const internalId = this.dragNodeId;
    this.clearSpringTimer();
    this.clearDropUi();
    this.dragDepth = 0;
    this.dragNodeId = null;
    this.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    this.clearDragPortal();

    if (!this.vfs || dest == null) return;

    try {
      if (internalId != null) {
        await this.moveNodeTo(internalId, dest);
        this.setStatus('Moved 1 item');
        await this.refreshAfterMutation();
        return;
      }

      const dt = e.dataTransfer;
      if (!dt) {
        this.setStatus('No files in drop');
        return;
      }
      this.setStatus('Scanning…', { busy: true });
      let lastPaint = 0;
      const count = await this.vfs.importDataTransfer(dest, dt, {
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
      });
      if (count === 0) {
        this.setStatus('No files in drop');
        return;
      }
      const destNode = await this.vfs.get(dest);
      const where = destNode?.name ?? 'folder';
      this.setStatus(`Imported ${count} item(s) into ${where}`);
      if (this.view === 'list' && dest !== this.cwd && !this.expandedIds.has(dest)) {
        this.expandedIds.add(dest);
      }
      // Consume the batched VFS notify so we don't double-refresh.
      if (this.vfsRefreshTimer) {
        clearTimeout(this.vfsRefreshTimer);
        this.vfsRefreshTimer = null;
      }
      const parents = [...this.pendingVfsParents];
      this.pendingVfsParents.clear();
      if (this.changeImpactsVisibleFolders(parents.length ? parents : [dest])) {
        iconCache.clearDirectoryCache();
        this.iconUrls.clear();
        this.iconLoadGen++;
        await this.refreshAfterMutation();
      }
    } catch (err) {
      console.error(err);
      this.setStatus(`Drop failed: ${(err as Error).message}`);
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
      case 'delete':
        await this.onDelete();
        break;
      case 'props':
        if (this.selectedId == null && !this.showProps) {
          this.setStatus('Select an item for Properties');
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
      case 'download':
        await this.onDownload();
        break;
    }
  }

  private async applyProps(): Promise<void> {
    const sel = this.selectedNode();
    if (!sel || sel.isDir) return;
    const type = (this.querySelector('[data-prop="type"]') as HTMLInputElement)?.value.padEnd(4).slice(0, 4) ?? '????';
    const creator =
      (this.querySelector('[data-prop="creator"]') as HTMLInputElement)?.value.padEnd(4).slice(0, 4) ?? '????';
    for (let i = 0; i < 4; i++) {
      sel.finderInfo[i] = type.charCodeAt(i);
      sel.finderInfo[4 + i] = creator.charCodeAt(i);
    }
    await this.vfs.put(sel);
    this.setStatus('Finder info updated');
    await this.reload();
    this.refreshPropsPanel();
  }

  private async onConnect(): Promise<void> {
    if (this.host.isConnected()) {
      await this.host.disconnectSerial();
      this.unmountRemote('Disconnected');
      return;
    }
    try {
      await this.host.connectSerial();
      this.setStatus('Serial connected — claiming LocalTalk node…');
      this.render();
    } catch (e) {
      this.setStatus(`Connect failed: ${(e as Error).message}`);
    }
  }

  private async connectServerWithLogin(s: LookupResult): Promise<boolean> {
    if (this.remoteBusy) return false;
    this.remoteBusy = true;
    try {
      this.setStatus(`Contacting ${s.object}…`, { busy: true });
      log.info(
        `Connecting to AFP “${s.object}” at ${s.network}.${s.node}:${s.socket}`,
        'afp',
      );
      this.remoteLoggedIn = false;
      this.remoteVolumes = [];
      this.remoteOpen = false;
      if (this.source === 'remote') this.resetToLocalShare();
      const info = await this.host.beginRemote(s);
      const allowGuest = info.uams.some((u) => /no user authent/i.test(u));
      this.setStatus(`Connected to ${info.serverName || s.object} — sign in`);
      let error: string | undefined;
      for (;;) {
        const creds = await this.host.promptCredentials({
          serverName: info.serverName || s.object,
          uams: info.uams,
          error,
          allowGuest,
        });
        if (!creds) {
          await this.host.closeRemote().catch(() => undefined);
          this.remoteLoggedIn = false;
          this.remoteVolumes = [];
          this.remoteLookup = null;
          this.setStatus('Login cancelled');
          return false;
        }
        try {
          const vols = await this.host.loginRemote(creds);
          this.remoteLoggedIn = true;
          this.remoteVolumes = vols;
          this.remoteNbpName = s.object;
          this.remoteLookup = s;
          this.remoteOpen = false;
          this.setStatus(
            `Signed in to ${info.serverName || s.object} — ${vols.length} volume(s)`,
          );
          log.info(
            `Authenticated to “${info.serverName || s.object}”; volumes: ${vols.join(', ') || '(none)'}`,
            'afp',
          );
          this.host.dismissLogin();
          return true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          log.error(`AFP login failed: ${error}`, 'afp');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`AFP connect failed: ${msg}`, 'afp');
      this.setStatus(`Connect failed: ${msg}`);
      await this.host.closeRemote().catch(() => undefined);
      this.remoteLoggedIn = false;
      this.remoteVolumes = [];
      this.remoteLookup = null;
      return false;
    } finally {
      this.remoteBusy = false;
    }
  }

  private async mountRemoteVolume(name: string): Promise<void> {
    log.info(`Opening volume “${name}”`, 'afp');
    const cat = await this.host.openRemoteVolume(name);
    const meta = this.host.remoteMeta();
    this.mountCatalog(cat, 'remote', meta?.volumeName || name);
    this.remoteOpen = true;
    this.setStatus(`Mounted ${meta?.serverName || this.remoteNbpName}:${name}`);
  }

  private async ejectRemote(): Promise<void> {
    log.info(`Eject “${this.remoteNbpName || 'remote'}”`, 'afp');
    await this.host.closeRemote().catch(() => undefined);
    this.resetToLocalShare();
    this.setStatus('Disconnected from AFP server');
    await this.reload();
    this.syncHistory();
    this.render();
  }

  private async onRefresh(): Promise<void> {
    this.setStatus('Looking up AFPServer…');
    const list = await this.host.refreshNetwork();
    this.servers = list;
    this.setStatus(`Found ${list.length} AFP server(s)`);
    this.renderSidebar();
  }

  private async navigateToPathIndex(index: number): Promise<void> {
    if (index < 0 || index >= this.pathStack.length) return;
    if (index === this.pathStack.length - 1) return;
    this.pathStack = this.pathStack.slice(0, index + 1);
    this.cwd = this.pathStack[this.pathStack.length - 1]!.id;
    this.selectedId = null;
    await this.reload();
    this.renderPath();
    this.renderContent();
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
    if (this.selectedId == null) return;
    this.renamingId = this.selectedId;
    this.renderContent();
  }

  private showPropertiesPanel(): void {
    if (this.selectedId == null) {
      this.setStatus('Select an item for Properties');
      return;
    }
    this.showProps = true;
    this.syncPropsButton();
    this.refreshPropsPanel();
  }

  private cutSelection(): void {
    if (this.selectedId == null) return;
    this.clipboard = { mode: 'cut', ids: [this.selectedId] };
    this.setStatus('Cut 1 item');
  }

  private copySelection(): void {
    if (this.selectedId == null) return;
    this.clipboard = { mode: 'copy', ids: [this.selectedId] };
    this.setStatus('Copied 1 item');
  }

  private async onMkdir(): Promise<void> {
    const name = await this.uniqueChildName(this.cwd, 'New folder');
    const node = await this.vfs.mkdir(this.cwd, name);
    this.selectedId = node.id;
    this.renamingId = node.id;
    await this.reload();
    this.renderContent();
  }

  private async uniqueChildName(parentId: number, base: string): Promise<string> {
    let name = base;
    let n = 2;
    while (await this.vfs.lookup(parentId, name)) {
      name = `${base} ${n++}`;
    }
    return name;
  }

  private async onDelete(): Promise<void> {
    if (this.selectedId == null) return;
    const node = this.findNodeAnywhere(this.selectedId) ?? (await this.vfs.get(this.selectedId));
    if (!node) return;
    if (!confirm(`Delete “${node.name}”?`)) return;
    await this.vfs.remove(this.selectedId);
    this.selectedId = null;
    this.showProps = false;
    this.syncPropsButton();
    await this.reload();
    this.renderContent();
  }

  private async onDownload(): Promise<void> {
    if (this.selectedId == null) {
      this.setStatus('Select an item to download');
      return;
    }
    const node = await this.vfs.get(this.selectedId);
    if (!node) return;
    const entries = await collectFsZipEntries(this.vfs, node);
    downloadZipEntries(node.name, entries);
    this.setStatus(`Downloaded ${node.name}.zip`);
  }

  private async onContextMenu(e: MouseEvent): Promise<void> {
    const content = this.querySelector('.content');
    if (!content?.contains(e.target as Node)) return;
    e.preventDefault();
    const item = this.itemFromEvent(e);
    if (item) {
      const id = Number(item.getAttribute('data-id'));
      this.selectedId = id;
      this.paintSelection(item);
      if (this.showProps) this.refreshPropsPanel();
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
    const { x, y, targetId } = this.contextMenu;
    const items =
      targetId != null
        ? [
            `<button type="button" data-ctx="rename">Rename</button>`,
            `<button type="button" data-ctx="delete">Delete…</button>`,
            `<button type="button" data-ctx="props">Properties…</button>`,
            `<hr/>`,
            `<button type="button" data-ctx="cut">Cut</button>`,
            `<button type="button" data-ctx="copy">Copy</button>`,
          ]
        : [
            `<button type="button" data-ctx="mkdir">New Folder</button>`,
            this.clipboard ? `<button type="button" data-ctx="paste">Paste</button>` : '',
            `<button type="button" data-ctx="props-blank">Properties</button>`,
          ];
    root.innerHTML = `<div class="ctx-menu" style="left:${x}px;top:${y}px">${items.filter(Boolean).join('')}</div>`;
  }

  private async handleContextAction(action: string): Promise<void> {
    switch (action) {
      case 'rename':
        this.startRename();
        break;
      case 'delete':
        await this.onDelete();
        break;
      case 'props':
        this.showPropertiesPanel();
        break;
      case 'props-blank': {
        this.showProps = true;
        if (this.selectedId == null) {
          const folder = await this.vfs.get(this.cwd);
          if (folder) this.selectedId = folder.id;
        }
        this.syncPropsButton();
        this.refreshPropsPanel();
        break;
      }
      case 'cut':
        this.cutSelection();
        break;
      case 'copy':
        this.copySelection();
        break;
      case 'paste':
        await this.pasteClipboard();
        break;
      case 'mkdir':
        await this.onMkdir();
        break;
    }
  }

  private async pasteClipboard(): Promise<void> {
    if (!this.clipboard) return;
    for (const id of this.clipboard.ids) {
      const src = await this.vfs.get(id);
      if (!src) continue;
      if (this.clipboard.mode === 'cut') {
        if (src.parentId === this.cwd) continue;
        await this.vfs.move(id, this.cwd);
      } else {
        await this.duplicateNode(src, this.cwd);
      }
    }
    if (this.clipboard.mode === 'cut') this.clipboard = null;
    await this.reload();
    this.renderContent();
    this.setStatus('Paste complete');
  }

  private async duplicateNode(src: VNode, parentId: number): Promise<void> {
    const name = await this.uniqueChildName(parentId, src.name);
    if (src.isDir) {
      const dir = await this.vfs.mkdir(parentId, name);
      const kids = await this.vfs.children(src.id);
      for (const k of kids) await this.duplicateNode(k, dir.id);
    } else {
      await this.vfs.createFile(parentId, name, src.data.slice(), src.resource.slice(), src.finderInfo.slice());
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
    if (!ae || ae === document.body || ae === document.documentElement) return true;
    return this.contains(ae);
  }

  private async onKeyDown(e: KeyboardEvent): Promise<void> {
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

    if (!this.finderHasFocus()) return;
    if (this.isEditingField(t)) return;
    if (this.contextMenu) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.contextMenu = null;
        this.renderContextMenu();
      }
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

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

    // Properties: ⌘I | Alt+Enter
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
      this.cutSelection();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && lower === 'c') {
      e.preventDefault();
      this.copySelection();
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
    const id = Number(input.getAttribute('data-rename'));
    const name = input.value.trim();
    input.removeAttribute('data-rename');
    this.renamingId = null;
    try {
      if (!name || !id) {
        this.renderContent();
        return;
      }
      const node = this.findNodeAnywhere(id) ?? (await this.vfs.get(id));
      if (!node) return;
      if (node.name !== name) {
        const clash = await this.vfs.lookup(node.parentId, name);
        if (clash && clash.id !== id) {
          this.setStatus(`“${name}” already exists`);
          this.renamingId = id;
          this.renderContent();
          return;
        }
        await this.vfs.rename(id, name);
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

customElements.define('finder-window', FinderWindow);

export function downloadAppleDoubleZip(
  name: string,
  data: Uint8Array,
  resource: Uint8Array,
  finderInfo: Uint8Array,
): void {
  downloadZipEntries(name, [
    { name, data },
    { name: `._${name}`, data: buildAppleDouble(finderInfo, resource) },
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

/** Recursively collect AppleDouble pairs for a virtual FS subtree. */
export async function collectFsZipEntries(
  vfs: Catalog,
  node: VNode,
  prefix = '',
): Promise<{ name: string; data: Uint8Array }[]> {
  const out: { name: string; data: Uint8Array }[] = [];
  if (node.isDir) {
    const kids = await vfs.children(node.id);
    const dirPrefix = prefix ? `${prefix}${node.name}/` : `${node.name}/`;
    for (const kid of kids) {
      const full = kid.isDir ? kid : ((await vfs.get(kid.id)) ?? kid);
      out.push(...(await collectFsZipEntries(vfs, full, dirPrefix)));
    }
    return out;
  }
  const base = prefix ? `${prefix}${node.name}` : node.name;
  out.push({ name: base, data: node.data });
  out.push({
    name: prefix ? `${prefix}._${node.name}` : `._${node.name}`,
    data: buildAppleDouble(node.finderInfo, node.resource),
  });
  return out;
}
