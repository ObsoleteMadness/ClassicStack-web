import type { CatalogWithBackend, FinderAPI } from './api';
import type { FinderNodeDto, FinderSessionDto, OpProgress, CrossTransferRequest } from './types';
import { bindCatalog } from './bind-catalog';
import { copyBetweenCatalogs, expandOnCatalog, moveBetweenCatalogs } from './catalog-copy';
import type { Catalog } from '../fs/virtual-fs';

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

  async getNode(sessionId: string, id: number): Promise<FinderNodeDto> {
    const node = await this.catalogFor(sessionId).get(id);
    if (!node) throw new Error('not found');
    return this.toNode(node);
  }
  async children(sessionId: string, parentId: number): Promise<FinderNodeDto[]> {
    return (await this.catalogFor(sessionId).children(parentId)).map((n) => this.toNode(n));
  }
  async lookup(sessionId: string, parentId: number, name: string): Promise<FinderNodeDto | null> {
    const node = await this.catalogFor(sessionId).lookup(parentId, name);
    return node ? this.toNode(node) : null;
  }
  async mkdir(sessionId: string, parentId: number, name: string): Promise<FinderNodeDto> {
    return this.toNode(await this.catalogFor(sessionId).mkdir(parentId, name));
  }
  async create(
    sessionId: string,
    parentId: number,
    name: string,
    body?: { data?: Uint8Array; resource?: Uint8Array; finderInfo?: Uint8Array },
  ): Promise<FinderNodeDto> {
    return this.toNode(
      await this.catalogFor(sessionId).createFile(
        parentId,
        name,
        body?.data ?? new Uint8Array(),
        body?.resource ?? new Uint8Array(),
        body?.finderInfo,
      ),
    );
  }
  async rename(sessionId: string, id: number, name: string): Promise<void> {
    await this.catalogFor(sessionId).rename(id, name);
  }
  async move(sessionId: string, id: number, parentId: number): Promise<void> {
    await this.catalogFor(sessionId).move(id, parentId);
  }
  async remove(sessionId: string, id: number): Promise<void> {
    await this.catalogFor(sessionId).remove(id);
  }
  async readFork(sessionId: string, id: number, resource: boolean): Promise<Uint8Array> {
    const node = await this.catalogFor(sessionId).ensureContent(id);
    if (!node) throw new Error('not found');
    return resource ? node.resource : node.data;
  }
  async writeFork(sessionId: string, id: number, resource: boolean, _off: number, data: Uint8Array): Promise<void> {
    const cat = this.catalogFor(sessionId);
    const node = await cat.ensureContent(id);
    if (!node || node.isDir) throw new Error('not found');
    if (resource) node.resource = data;
    else node.data = data;
    await cat.put(node);
  }
  async writeFinderInfo(sessionId: string, id: number, finderInfo: Uint8Array): Promise<void> {
    const cat = this.catalogFor(sessionId);
    const node = await cat.get(id);
    if (!node) throw new Error('not found');
    node.finderInfo = finderInfo;
    await cat.put(node);
  }

  copy(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress> {
    return this.runCopy(req, signal);
  }
  moveAcross(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress> {
    return this.runMove(req, signal);
  }
  expand(sessionId: string, id: number, signal?: AbortSignal): AsyncIterable<OpProgress> {
    return expandOnCatalog(this.catalogFor(sessionId), id, signal);
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

  private toNode(node: import('../fs/virtual-fs').VNode): FinderNodeDto {
    return {
      id: node.id,
      parentId: node.parentId,
      name: node.name,
      isDir: node.isDir,
      dataBytes: node.dataBytes ?? node.data.length,
      resourceBytes: node.resourceBytes ?? node.resource.length,
      createDate: node.createDate,
      modDate: node.modDate,
    };
  }
}
