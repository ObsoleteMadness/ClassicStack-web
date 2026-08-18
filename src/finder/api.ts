/** Protocol-neutral Finder backend (ClassicStack-web AFP or ClassicStack-go HTTP). */

import type { Catalog } from '../fs/virtual-fs';
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

  getNode(sessionId: string, id: number): Promise<FinderNodeDto>;
  children(sessionId: string, parentId: number): Promise<FinderNodeDto[]>;
  lookup(sessionId: string, parentId: number, name: string): Promise<FinderNodeDto | null>;
  mkdir(sessionId: string, parentId: number, name: string): Promise<FinderNodeDto>;
  create(
    sessionId: string,
    parentId: number,
    name: string,
    body?: { data?: Uint8Array; resource?: Uint8Array; finderInfo?: Uint8Array },
  ): Promise<FinderNodeDto>;
  rename(sessionId: string, id: number, name: string): Promise<void>;
  move(sessionId: string, id: number, parentId: number): Promise<void>;
  remove(sessionId: string, id: number): Promise<void>;
  readFork(sessionId: string, id: number, resource: boolean, off?: number, len?: number): Promise<Uint8Array>;
  writeFork(sessionId: string, id: number, resource: boolean, off: number, data: Uint8Array): Promise<void>;
  writeFinderInfo(sessionId: string, id: number, finderInfo: Uint8Array): Promise<void>;

  copy(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress>;
  moveAcross(req: CrossTransferRequest, signal?: AbortSignal): AsyncIterable<OpProgress>;
  expand(sessionId: string, id: number, signal?: AbortSignal): AsyncIterable<OpProgress>;

  openCatalog(session: FinderSessionDto): Catalog;
  connect?(req: ConnectRequest): Promise<FinderSessionDto>;
  openVolume?(sessionId: string, volume: string): Promise<FinderSessionDto>;
  close?(sessionId: string): Promise<void>;
  closeVolume?(sessionId: string, volume: string): Promise<void>;
}

export type CatalogWithBackend = Catalog & {
  readonly sessionId: string;
  readonly api: FinderAPI;
  copyFrom(src: CatalogWithBackend, srcId: number, destParent: number, opts: TransferOptions): Promise<void>;
  moveFrom(src: CatalogWithBackend, srcId: number, destParent: number, opts: TransferOptions): Promise<void>;
  expandNode(id: number, opts?: Pick<TransferOptions, 'signal' | 'onProgress'>): Promise<void>;
};

export function isCatalogWithBackend(c: Catalog): c is CatalogWithBackend {
  return 'sessionId' in c && 'api' in c && typeof (c as CatalogWithBackend).copyFrom === 'function';
}
