import type { CatalogWithBackend, FinderAPI } from './api';
import type { FinderNodeDto, FinderSessionDto, OpProgress, CrossTransferRequest, CnidNodeDto } from './types';
import { bindCatalog } from './bind-catalog';
import { copyBetweenCatalogs, expandOnCatalog, moveBetweenCatalogs } from './catalog-copy';
import type { Catalog, VNode } from '../fs/virtual-fs';
import type { NodeRef } from '../fs/catalog-caps';

const LOCAL_SESSION = 'local';

/**
 * In-browser FinderAPI over VirtualFS / RemoteVfs. Copy, move, and expand stay
 * in the client (TashTalk owns the AFP session). Same-server files use FPCopyFile.
 */
export class AfpFinderAPI implements FinderAPI {
  readonly backendId = 'afp';
  private readonly catalogs = new Map<string, Catalog>();

  bindLocal(vfs: Catalog): CatalogWithBackend {
    return this.register(LOCAL_SESSION, vfs);
  }

  bindRemote(sessionId: string, cat: Catalog): CatalogWithBackend {
    return this.register(sessionId, cat);
  }

  unbind(sessionId: string): void {
    this.catalogs.delete(sessionId);
  }

  localCatalog(): CatalogWithBackend | undefined {
    const cat = this.catalogs.get(LOCAL_SESSION);
    return cat ? bindCatalog(cat, this, LOCAL_SESSION) : undefined;
  }

  register(sessionId: string, cat: Catalog): CatalogWithBackend {
    this.catalogs.set(sessionId, cat);
    return bindCatalog(cat, this, sessionId);
  }

  openCatalog(session: FinderSessionDto): Catalog {
    const cat = this.catalogs.get(session.sessionId);
    if (!cat) throw new Error(`no catalog for session ${session.sessionId}`);
    return bindCatalog(cat, this, session.sessionId);
  }

  async getNode(sessionId: string, ref: NodeRef): Promise<FinderNodeDto> {
    const node = await this.catalogFor(sessionId).get(ref);
    if (!node) throw new Error('not found');
    return this.toNode(node);
  }
  async children(sessionId: string, parent: NodeRef): Promise<FinderNodeDto[]> {
    return (await this.catalogFor(sessionId).children(parent)).map((n) => this.toNode(n));
  }
  async lookup(sessionId: string, parent: NodeRef, name: string): Promise<FinderNodeDto | null> {
    const node = await this.catalogFor(sessionId).lookup(parent, name);
    return node ? this.toNode(node) : null;
  }
  async mkdir(sessionId: string, parent: NodeRef, name: string): Promise<FinderNodeDto> {
    return this.toNode(await this.catalogFor(sessionId).mkdir(parent, name));
  }
  async create(
    sessionId: string,
    parent: NodeRef,
    name: string,
    body?: { data?: Uint8Array; resource?: Uint8Array; finderInfo?: Uint8Array },
  ): Promise<FinderNodeDto> {
    return this.toNode(
      await this.catalogFor(sessionId).createFile(
        parent,
        name,
        body?.data ?? new Uint8Array(),
        body?.resource ?? new Uint8Array(),
        body?.finderInfo,
      ),
    );
  }
  async rename(sessionId: string, ref: NodeRef, name: string): Promise<void> {
    await this.catalogFor(sessionId).rename(ref, name);
  }
  async move(sessionId: string, ref: NodeRef, parent: NodeRef): Promise<void> {
    await this.catalogFor(sessionId).move(ref, parent);
  }
  async remove(sessionId: string, ref: NodeRef): Promise<void> {
    await this.catalogFor(sessionId).remove(ref);
  }
  async readFork(sessionId: string, ref: NodeRef, resource: boolean): Promise<Uint8Array> {
    const node = await this.catalogFor(sessionId).ensureContent(ref);
    if (!node) throw new Error('not found');
    return resource ? node.resource : node.data;
  }
  async writeFork(sessionId: string, ref: NodeRef, resource: boolean, _off: number, data: Uint8Array): Promise<void> {
    const cat = this.catalogFor(sessionId);
    const node = await cat.ensureContent(ref);
    if (!node || node.isDir) throw new Error('not found');
    if (resource) node.resource = data;
    else node.data = data;
    await cat.put(node);
  }
  async writeFinderInfo(sessionId: string, ref: NodeRef, finderInfo: Uint8Array): Promise<void> {
    const cat = this.catalogFor(sessionId);
    const node = await cat.get(ref);
    if (!node) throw new Error('not found');
    node.finderInfo = finderInfo;
    await cat.put(node);
  }
  async writeAttrs(sessionId: string, ref: NodeRef, patch: Record<string, boolean>): Promise<void> {
    const cat = this.catalogFor(sessionId);
    if (cat.setAttrs) {
      await cat.setAttrs(ref, patch);
      return;
    }
    throw new Error('setAttrs not supported');
  }
  async resolvePath(sessionId: string, path: string): Promise<FinderNodeDto | null> {
    const node = await this.catalogFor(sessionId).resolvePath(path);
    return node ? this.toNode(node) : null;
  }
  async pathOf(sessionId: string, ref: NodeRef): Promise<string> {
    return this.catalogFor(sessionId).pathOf(ref);
  }

  copy(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress> {
    return this.runCopy(req, signal);
  }
  moveAcross(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress> {
    return this.runMove(req, signal);
  }
  expand(sessionId: string, ref: NodeRef, signal?: AbortSignal): AsyncIterable<OpProgress> {
    return expandOnCatalog(this.catalogFor(sessionId), ref, signal);
  }

  private async *runCopy(req: CrossTransferRequest, signal?: AbortSignal): AsyncGenerator<OpProgress> {
    yield* copyBetweenCatalogs(this.catalogFor(req.srcSession), this.catalogFor(req.destSession), req, signal);
    yield { phase: 'copying', destName: req.destName, destParentId: req.destParentId, done: true };
  }

  private async *runMove(req: CrossTransferRequest, signal?: AbortSignal): AsyncGenerator<OpProgress> {
    yield* moveBetweenCatalogs(this.catalogFor(req.srcSession), this.catalogFor(req.destSession), req, signal);
    yield { phase: 'moving', destName: req.destName, destParentId: req.destParentId, done: true };
  }

  private catalogFor(sessionId: string): Catalog {
    const cat = this.catalogs.get(sessionId);
    if (!cat) throw new Error(sessionId === LOCAL_SESSION ? 'no local catalog' : 'no AFP session');
    return cat;
  }

  private toNode(node: VNode): FinderNodeDto {
    if (node.addr === 'path') {
      return {
        addr: 'path',
        path: node.path,
        parentPath: node.parentPath,
        name: node.name,
        isDir: node.isDir,
        dataBytes: node.dataBytes ?? node.data.length,
        resourceBytes: node.resourceBytes ?? node.resource.length,
        createDate: node.createDate,
        modDate: node.modDate,
        accessDate: node.accessDate,
        backupDate: node.backupDate,
        shortName: node.shortName,
        mediumName: node.mediumName,
        attrs: node.attrs,
      };
    }
    const cnid: CnidNodeDto & FinderNodeDto = {
      addr: 'cnid',
      id: node.id,
      parentId: node.parentId,
      name: node.name,
      isDir: node.isDir,
      dataBytes: node.dataBytes ?? node.data.length,
      resourceBytes: node.resourceBytes ?? node.resource.length,
      createDate: node.createDate,
      modDate: node.modDate,
      accessDate: node.accessDate,
      backupDate: node.backupDate,
      shortName: node.shortName,
      mediumName: node.mediumName,
      attrs: node.attrs,
    };
    return cnid;
  }
}
