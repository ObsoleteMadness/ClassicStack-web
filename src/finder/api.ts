/** Protocol-neutral Finder backend (ClassicStack-web AFP or ClassicStack-go HTTP). */

import type { Catalog } from '../fs/virtual-fs';
import type { NodeRef } from '../fs/catalog-caps';
import type { FinderNodeDto, FinderSessionDto, OpProgress, TransferOptions, CrossTransferRequest } from './types';

export type ConnectRequest = {
  kind: string;
  id: string;
  target?: string;
  user?: string;
  password?: string;
  guest?: boolean;
};

export interface FinderAPI {
  readonly backendId: string;

  getNode(sessionId: string, ref: NodeRef): Promise<FinderNodeDto>;
  children(sessionId: string, parent: NodeRef): Promise<FinderNodeDto[]>;
  lookup(sessionId: string, parent: NodeRef, name: string): Promise<FinderNodeDto | null>;
  mkdir(sessionId: string, parent: NodeRef, name: string): Promise<FinderNodeDto>;
  create(
    sessionId: string,
    parent: NodeRef,
    name: string,
    body?: { data?: Uint8Array; resource?: Uint8Array; finderInfo?: Uint8Array },
  ): Promise<FinderNodeDto>;
  rename(sessionId: string, ref: NodeRef, name: string): Promise<void>;
  move(sessionId: string, ref: NodeRef, parent: NodeRef): Promise<void>;
  remove(sessionId: string, ref: NodeRef): Promise<void>;
  readFork(sessionId: string, ref: NodeRef, resource: boolean, off?: number, len?: number): Promise<Uint8Array>;
  writeFork(sessionId: string, ref: NodeRef, resource: boolean, off: number, data: Uint8Array): Promise<void>;
  writeFinderInfo(sessionId: string, ref: NodeRef, finderInfo: Uint8Array): Promise<void>;
  writeAttrs?(sessionId: string, ref: NodeRef, patch: Record<string, boolean>): Promise<void>;
  resolvePath(sessionId: string, path: string): Promise<FinderNodeDto | null>;
  pathOf(sessionId: string, ref: NodeRef): Promise<string>;

  copy(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress>;
  moveAcross(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress>;
  expand(sessionId: string, ref: NodeRef, signal?: AbortSignal): AsyncIterable<OpProgress>;

  openCatalog(session: FinderSessionDto): Catalog;
  connect?(req: ConnectRequest): Promise<FinderSessionDto>;
  openVolume?(sessionId: string, volume: string): Promise<FinderSessionDto>;
  close?(sessionId: string): Promise<void>;
  closeVolume?(sessionId: string, volume: string): Promise<void>;
}

export type CatalogWithBackend = Catalog & {
  readonly sessionId: string;
  readonly api: FinderAPI;
  copyFrom(src: CatalogWithBackend, srcId: NodeRef, destParent: NodeRef, opts: TransferOptions): Promise<void>;
  moveFrom(src: CatalogWithBackend, srcId: NodeRef, destParent: NodeRef, opts: TransferOptions): Promise<void>;
  expandNode(id: NodeRef, opts?: Pick<TransferOptions, 'signal' | 'onProgress'>): Promise<void>;
};

export function isCatalogWithBackend(c: Catalog): c is CatalogWithBackend {
  return 'sessionId' in c && 'api' in c && typeof (c as CatalogWithBackend).copyFrom === 'function';
}
