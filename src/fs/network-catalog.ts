/** Path catalog: Browse Network → protocol → zone → server → share → volume overlay. */

import { bufferRangeReader, type ByteRangeReader } from './byte-range';
import type { ResourceFork, ResourceForkLoadOpts } from './resource-fork';
import type { ImportProgress } from './import-transfer';
import {
  joinStorePath,
  leafName,
  parentPathOf,
  type CatalogCapabilities,
  type NodeRef,
} from './catalog-caps';
import { networkGlyphSrc } from './volume-chrome';
import type {
  Catalog,
  ChildrenBatchListener,
  PathVNode,
  VfsChangeListener,
  VNode,
  VNodeChrome,
} from './virtual-fs';
import { nodeRef } from './virtual-fs';
import type { RemoteEndpoint, ShareKind } from '../ui/finder-host';
import {
  endpointSkipsNeighborhood,
  isNetworkServer,
  matchNetworkServer,
  neighborhoodFor,
  NETWORK_ROOT_NAME,
  parseNetworkPath,
  PROTOCOL_FOLDER,
  shareNetworkPath,
  treeNeighborhood,
  type NetworkPathInfo,
  type NetworkRole,
  type RemoteShareKind,
} from './network-tree';

const EMPTY = new Uint8Array();
const NOW = 0;

export type NetworkSource = {
  endpoints(): readonly RemoteEndpoint[];
  schemes(): readonly ShareKind[];
  volumes(ep: RemoteEndpoint): readonly string[];
  /** Already-open volume catalog for this share, if the client has mounted it. */
  volumeCatalog?(ep: RemoteEndpoint, volume: string): Catalog | undefined;
  volumeCatalogKey?(ep: RemoteEndpoint, volume: string): string | undefined;
};

export const networkVolumeCaps: CatalogCapabilities = {
  identity: { shareKind: 'afp', protocol: 'afp', filesystem: 'network' },
  addressBy: 'path',
  readOnly: true,
  resourceFork: false,
  finderInfo: false,
  desktopIcons: false,
  resourceIcons: false,
  names: ['long'],
  maxNameBytes: { long: 255 },
  nameCase: 'preserve',
  dates: [],
  attributes: [],
  pathFormat: 'mac',
};

function unsupported(op: string): never {
  throw new Error(`network catalog: ${op} is not supported`);
}

function asPath(ref: NodeRef): string | undefined {
  return typeof ref === 'string' ? ref : undefined;
}

function containerNode(path: string, name: string, chrome: VNodeChrome, isDir: boolean): PathVNode {
  return {
    addr: 'path',
    path,
    parentPath: parentPathOf(path),
    name: path === '' ? NETWORK_ROOT_NAME : name,
    isDir,
    data: EMPTY,
    resource: EMPTY,
    finderInfo: new Uint8Array(32),
    createDate: NOW,
    modDate: NOW,
    chrome: { ...chrome, container: true },
  };
}

function chromeFor(
  role: NetworkRole,
  protocol?: string,
  endpointId?: string,
  serviceKind?: string,
  catalogKey?: string,
  nativeRef?: NodeRef,
): VNodeChrome {
  return {
    iconSrc: networkGlyphSrc(role, protocol, serviceKind),
    networkRole: role,
    endpointId,
    container: true,
    serviceKind,
    catalogKey,
    nativeRef,
  };
}

function remoteSchemes(schemes: readonly ShareKind[]): RemoteShareKind[] {
  const out: RemoteShareKind[] = [];
  const seen = new Set<string>();
  for (const s of schemes) {
    if (s === 'local' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function uniqueSorted(names: Iterable<string>): string[] {
  return [...new Set([...names].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

type Overlay = {
  vol: Catalog;
  native: NodeRef;
  sharePath: string;
  catalogKey: string;
};

/** Path-addressed virtual folders over discovered servers, with volume overlay. */
export class NetworkCatalog implements Catalog {
  /**
   * Overlay volume catalogs (ApiCatalog) report fork progress. Discovery nodes
   * are never zipped; zip/copy walk the volume catalog via native refs.
   */
  readonly reportsChunkedBytes = true;
  private listeners = new Set<VfsChangeListener>();
  private nativeByPath = new Map<string, NodeRef>();

  constructor(private readonly source: NetworkSource) {}

  capabilities(): CatalogCapabilities {
    return networkVolumeCaps;
  }

  rootId(): NodeRef {
    return '';
  }

  subscribe(fn: VfsChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Discovery changed — Finder reloads any open Network Browser folder. */
  notify(): void {
    this.nativeByPath.clear();
    this.listeners.forEach((fn) => fn({ parentIds: [] }));
  }

  beginBatch(): void {}
  endBatch(): void {}

  async get(ref: NodeRef): Promise<VNode | undefined> {
    const path = asPath(ref);
    if (path == null) return undefined;
    return this.nodeAt(path);
  }

  async ensureContent(ref: NodeRef, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<VNode | undefined> {
    const overlay = await this.overlayOf(ref);
    if (!overlay) return this.get(ref);
    const native = await overlay.vol.ensureContent(overlay.native, onBytes, signal);
    if (!native) return undefined;
    const path = asPath(ref);
    return path != null ? this.wrapKnown(native, overlay, path) : this.wrapChild(native, overlay, overlay.sharePath);
  }

  async children(
    parent: NodeRef,
    onBatch?: ChildrenBatchListener,
    signal?: AbortSignal,
  ): Promise<VNode[]> {
    const path = asPath(parent);
    if (path == null) {
      onBatch?.([]);
      return [];
    }
    const overlay = await this.overlayOf(parent);
    if (overlay) {
      const wrapBatch = onBatch
        ? async (raw: VNode[]) => {
            await onBatch(this.wrapAll(raw, overlay, path));
          }
        : undefined;
      const raw = await overlay.vol.children(overlay.native, wrapBatch, signal);
      return this.wrapAll(raw, overlay, path);
    }
    const kids = this.childrenAt(path);
    onBatch?.(kids);
    return kids;
  }

  async lookup(parent: NodeRef, name: string, signal?: AbortSignal): Promise<VNode | undefined> {
    const path = asPath(parent);
    if (path == null || !name || name.includes('/')) return undefined;
    const overlay = await this.overlayOf(parent);
    if (overlay) {
      const native = await overlay.vol.lookup(overlay.native, name, signal);
      return native ? this.wrapChild(native, overlay, path) : undefined;
    }
    return this.nodeAt(joinStorePath(path, name));
  }

  async resolvePath(path: string): Promise<VNode | undefined> {
    const trimmed = path.replace(/^\/+|\/+$/g, '');
    return this.nodeAt(trimmed);
  }

  async pathOf(ref: NodeRef): Promise<string> {
    return asPath(ref) ?? '';
  }

  async loadResourceFork(node: VNode, opts?: ResourceForkLoadOpts): Promise<ResourceFork | null> {
    const overlay = await this.overlayOf(nodeRef(node));
    if (!overlay) return null;
    const native = await overlay.vol.get(overlay.native);
    if (!native) return null;
    return overlay.vol.loadResourceFork(native, opts);
  }

  async loadIconResources(node: VNode, signal?: AbortSignal): Promise<ResourceFork | null> {
    const overlay = await this.overlayOf(nodeRef(node));
    if (!overlay) return null;
    const native = await overlay.vol.get(overlay.native);
    if (!native) return null;
    return overlay.vol.loadIconResources(native, signal);
  }

  async loadDesktopIcons(
    type: string,
    creator: string,
    signal?: AbortSignal,
  ): Promise<{ iconType: number; data: Uint8Array }[] | null> {
    const overlay = await this.overlayOf('');
    if (!overlay?.vol.loadDesktopIcons) return null;
    return overlay.vol.loadDesktopIcons(type, creator, signal);
  }

  async withRangeReader<T>(
    node: VNode,
    fn: (read: ByteRangeReader) => Promise<T>,
    opts?: { resource?: boolean; signal?: AbortSignal; priority?: number },
  ): Promise<T> {
    const overlay = await this.overlayOf(nodeRef(node));
    if (!overlay) return fn(bufferRangeReader(EMPTY));
    const native = await overlay.vol.get(overlay.native);
    if (!native) return fn(bufferRangeReader(EMPTY));
    return overlay.vol.withRangeReader(native, fn, opts);
  }

  async mkdir(parent: NodeRef, name: string): Promise<VNode> {
    const overlay = await this.requireOverlay(parent, 'mkdir');
    const created = await overlay.vol.mkdir(overlay.native, name);
    const parentPath = asPath(parent) ?? overlay.sharePath;
    const wrapped = this.wrapChild(created, overlay, parentPath);
    this.notify();
    return wrapped;
  }

  async ensureDir(parent: NodeRef, name: string): Promise<VNode> {
    const overlay = await this.requireOverlay(parent, 'ensureDir');
    const created = await overlay.vol.ensureDir(overlay.native, name);
    const parentPath = asPath(parent) ?? overlay.sharePath;
    const wrapped = this.wrapChild(created, overlay, parentPath);
    this.notify();
    return wrapped;
  }

  async createFile(
    parent: NodeRef,
    name: string,
    data: Uint8Array,
    resource?: Uint8Array,
    finderInfo?: Uint8Array,
    onBytes?: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<VNode> {
    const overlay = await this.requireOverlay(parent, 'createFile');
    const created = await overlay.vol.createFile(
      overlay.native,
      name,
      data,
      resource,
      finderInfo,
      onBytes,
      signal,
    );
    this.notify();
    const parentPath = asPath(parent) ?? overlay.sharePath;
    return this.wrapChild(created, overlay, parentPath);
  }

  async put(node: VNode): Promise<void> {
    const overlay = await this.requireOverlay(nodeRef(node), 'put');
    const native = await overlay.vol.get(overlay.native);
    if (!native) throw new Error('not found');
    native.data = node.data;
    native.resource = node.resource;
    native.finderInfo = node.finderInfo;
    native.createDate = node.createDate;
    native.modDate = node.modDate;
    native.dataBytes = node.dataBytes;
    native.resourceBytes = node.resourceBytes;
    native.attributes = node.attributes;
    native.attrs = node.attrs;
    native.accessDate = node.accessDate;
    native.backupDate = node.backupDate;
    await overlay.vol.put(native);
    this.notify();
  }

  async rename(ref: NodeRef, newName: string): Promise<void> {
    const overlay = await this.requireOverlay(ref, 'rename');
    await overlay.vol.rename(overlay.native, newName);
    this.notify();
  }

  async move(ref: NodeRef, newParent: NodeRef): Promise<void> {
    const overlay = await this.requireOverlay(ref, 'move');
    const dest = await this.requireOverlay(newParent, 'move');
    if (overlay.vol !== dest.vol) unsupported('move across volumes');
    await overlay.vol.move(overlay.native, dest.native);
    this.notify();
  }

  async remove(ref: NodeRef): Promise<void> {
    const overlay = await this.requireOverlay(ref, 'remove');
    await overlay.vol.remove(overlay.native);
    this.notify();
  }

  async importDataTransfer(parent: NodeRef, dt: DataTransfer, opts?: ImportProgress): Promise<number> {
    const overlay = await this.requireOverlay(parent, 'importDataTransfer');
    const n = await overlay.vol.importDataTransfer(overlay.native, dt, opts);
    this.notify();
    return n;
  }

  async setAttrs(ref: NodeRef, patch: Record<string, boolean>): Promise<void> {
    const overlay = await this.requireOverlay(ref, 'setAttrs');
    if (!overlay.vol.setAttrs) unsupported('setAttrs');
    await overlay.vol.setAttrs(overlay.native, patch);
    this.notify();
  }

  private schemes(): RemoteShareKind[] {
    const fromHost = remoteSchemes(this.source.schemes());
    if (fromHost.length) return fromHost;
    const seen = new Set<RemoteShareKind>();
    for (const ep of this.source.endpoints()) {
      if (!isNetworkServer(ep) || ep.kind === 'local') continue;
      seen.add(ep.kind);
    }
    return [...seen];
  }

  private servers(): RemoteEndpoint[] {
    return this.source.endpoints().filter(isNetworkServer);
  }

  private parse(path: string): NetworkPathInfo {
    return parseNetworkPath(path, this.servers());
  }

  private serverAt(info: NetworkPathInfo): RemoteEndpoint | undefined {
    if (!info.protocol || !info.server) return undefined;
    return matchNetworkServer(this.servers(), info.protocol, info.neighborhood, info.server);
  }

  private serviceAt(ep: RemoteEndpoint, name: string) {
    return (ep.services ?? []).find((s) => s.kind !== 'share' && s.name === name);
  }

  private sharePathOf(info: NetworkPathInfo): string {
    return shareNetworkPath(info.protocol!, info.neighborhood, info.server!, info.share!);
  }

  private async overlayOf(ref: NodeRef): Promise<Overlay | undefined> {
    const path = asPath(ref);
    if (path == null) return undefined;
    const info = this.parse(path);
    if (info.role !== 'share' || !info.share || !info.protocol || !info.server) return undefined;
    const ep = this.serverAt(info);
    if (!ep || this.serviceAt(ep, info.share)) return undefined;
    const vol = this.source.volumeCatalog?.(ep, info.share);
    if (!vol) return undefined;
    const catalogKey = this.source.volumeCatalogKey?.(ep, info.share) || '';
    const sharePath = this.sharePathOf(info);
    if (!info.volumePath) {
      return { vol, native: vol.rootId(), sharePath, catalogKey };
    }
    const cached = this.nativeByPath.get(path);
    if (cached != null) {
      return { vol, native: cached, sharePath, catalogKey };
    }
    const nativeNode = await vol.resolvePath(info.volumePath);
    if (!nativeNode) return undefined;
    const native = nodeRef(nativeNode);
    this.nativeByPath.set(path, native);
    return { vol, native, sharePath, catalogKey };
  }

  private async requireOverlay(ref: NodeRef, op: string): Promise<Overlay> {
    const overlay = await this.overlayOf(ref);
    if (!overlay) unsupported(op);
    const path = asPath(ref);
    const info = path != null ? this.parse(path) : undefined;
    if (
      info?.role === 'share' &&
      !info.volumePath &&
      (op === 'rename' || op === 'remove' || op === 'move')
    ) {
      unsupported(op);
    }
    return overlay;
  }

  /**
   * Overlay identity is the Network Browser path. Do not use volume `pathOf`:
   * CNID catalogs may return `''`, which collapsed every child onto the share
   * root and made zip walks / deletes hit the volume node.
   */
  private wrapKnown(n: VNode, overlay: Overlay, path: string): PathVNode {
    this.nativeByPath.set(path, nodeRef(n));
    return {
      addr: 'path',
      path,
      parentPath: parentPathOf(path),
      name: n.name,
      isDir: n.isDir,
      data: n.data,
      resource: n.resource,
      finderInfo: n.finderInfo,
      createDate: n.createDate,
      modDate: n.modDate,
      dataBytes: n.dataBytes,
      resourceBytes: n.resourceBytes,
      attributes: n.attributes,
      shortName: n.shortName,
      mediumName: n.mediumName,
      accessDate: n.accessDate,
      backupDate: n.backupDate,
      attrs: n.attrs,
      chrome: {
        iconSrc: n.chrome?.iconSrc,
        catalogKey: overlay.catalogKey,
        nativeRef: nodeRef(n),
      },
    };
  }

  private wrapChild(n: VNode, overlay: Overlay, parentPath: string): PathVNode {
    return this.wrapKnown(n, overlay, joinStorePath(parentPath, n.name));
  }

  private wrapAll(nodes: VNode[], overlay: Overlay, parentPath: string): PathVNode[] {
    return nodes.map((n) => this.wrapChild(n, overlay, parentPath));
  }

  private shareNode(path: string, ep: RemoteEndpoint, protocol: RemoteShareKind, share: string): PathVNode {
    const vol = this.source.volumeCatalog?.(ep, share);
    const catalogKey = vol ? this.source.volumeCatalogKey?.(ep, share) : undefined;
    return containerNode(
      path,
      leafName(path),
      chromeFor('share', protocol, ep.id, undefined, catalogKey, vol?.rootId()),
      true,
    );
  }

  private async nodeAt(path: string): Promise<PathVNode | undefined> {
    const info = this.parse(path);
    if (path === '') return containerNode('', NETWORK_ROOT_NAME, chromeFor('root'), true);
    if (!info.protocol) return undefined;
    if (!this.schemes().includes(info.protocol)) return undefined;
    const protoFolder = PROTOCOL_FOLDER[info.protocol];
    if (info.role === 'protocol') {
      return containerNode(protoFolder, protoFolder, chromeFor('protocol', info.protocol), true);
    }
    if (info.role === 'neighborhood' && info.neighborhood) {
      if (!this.neighborhoods(info.protocol).includes(info.neighborhood)) return undefined;
      return containerNode(path, info.neighborhood, chromeFor('neighborhood', info.protocol), true);
    }
    if (info.role === 'server' && info.server) {
      const ep = this.serverAt(info);
      if (!ep) return undefined;
      return containerNode(path, info.server, chromeFor('server', info.protocol, ep.id), true);
    }
    if (info.role === 'share' && info.server && info.share) {
      const ep = this.serverAt(info);
      if (!ep) return undefined;
      const svc = this.serviceAt(ep, info.share);
      if (svc) {
        if (info.volumePath) return undefined;
        return containerNode(path, leafName(path), chromeFor('service', info.protocol, ep.id, svc.kind), false);
      }
      if (info.volumePath) {
        const overlay = await this.overlayOf(path);
        if (!overlay) return undefined;
        const native = await overlay.vol.get(overlay.native);
        return native ? this.wrapKnown(native, overlay, path) : undefined;
      }
      if (!this.source.volumes(ep).includes(info.share)) return undefined;
      return this.shareNode(path, ep, info.protocol, info.share);
    }
    return undefined;
  }

  private childrenAt(path: string): PathVNode[] {
    const info = this.parse(path);
    if (path === '' || info.role === 'root') {
      return this.schemes().map((kind) => {
        const name = PROTOCOL_FOLDER[kind];
        return containerNode(name, name, chromeFor('protocol', kind), true);
      });
    }
    if (!info.protocol) return [];
    if (info.role === 'protocol') {
      return this.protocolChildren(path, info.protocol);
    }
    if (info.role === 'neighborhood' && info.neighborhood) {
      const names = uniqueSorted(
        this.servers()
          .filter((ep) => ep.kind === info.protocol && treeNeighborhood(ep) === info.neighborhood)
          .map((ep) => ep.title.trim()),
      );
      return names.map((title) => {
        const ep = matchNetworkServer(this.servers(), info.protocol!, info.neighborhood, title);
        return containerNode(joinStorePath(path, title), title, chromeFor('server', info.protocol, ep?.id), true);
      });
    }
    if (info.role === 'server' && info.server) {
      const ep = this.serverAt(info);
      if (!ep) return [];
      const vols = this.source.volumes(ep);
      const shares = vols.map((vol) => this.shareNode(joinStorePath(path, vol), ep, info.protocol!, vol));
      const extras = (ep.services ?? [])
        .filter((s) => s.kind !== 'share' && !vols.includes(s.name))
        .map((s) =>
          containerNode(
            joinStorePath(path, s.name),
            s.name,
            chromeFor('service', info.protocol, ep.id, s.kind),
            false,
          ),
        );
      return [...shares, ...extras];
    }
    return [];
  }

  private protocolChildren(path: string, protocol: RemoteShareKind): PathVNode[] {
    const nbs = this.neighborhoods(protocol);
    const nested = nbs.map((nb) =>
      containerNode(joinStorePath(path, nb), nb, chromeFor('neighborhood', protocol), true),
    );
    const flats = uniqueSorted(
      this.servers()
        .filter((ep) => ep.kind === protocol && endpointSkipsNeighborhood(ep))
        .map((ep) => ep.title.trim()),
    ).map((title) => {
      const ep = matchNetworkServer(this.servers(), protocol, undefined, title);
      return containerNode(joinStorePath(path, title), title, chromeFor('server', protocol, ep?.id), true);
    });
    return [...nested, ...flats];
  }

  private neighborhoods(protocol: RemoteShareKind): string[] {
    return uniqueSorted(
      this.servers()
        .filter((ep) => ep.kind === protocol && !endpointSkipsNeighborhood(ep))
        .map((ep) => neighborhoodFor(ep)),
    );
  }
}

export function isNetworkCatalog(cat: Catalog | null | undefined): boolean {
  return !!cat && cat.capabilities().identity.filesystem === 'network';
}
