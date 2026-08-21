/** Shared Finder VFS job progress (Go SSE and in-browser AFP). */

import type { CatalogCapabilities, NodeRef } from '../fs/catalog-caps';

export type OpPhase = 'copying' | 'moving' | 'expanding' | 'listing';

export type OpProgress = {
  phase?: OpPhase;
  path?: string;
  bytesDone?: number;
  bytesTotal?: number;
  destName?: string;
  destParentId?: NodeRef;
  done?: boolean;
  error?: string;
};

export type CnidNodeDto = {
  addr: 'cnid';
  id: number;
  parentId: number;
};

export type PathNodeDto = {
  addr: 'path';
  path: string;
  parentPath: string;
};

export type FinderNodeDto = (CnidNodeDto | PathNodeDto) & {
  name: string;
  isDir: boolean;
  dataBytes?: number;
  resourceBytes?: number;
  finderInfo?: string;
  createDate?: number;
  modDate?: number;
  accessDate?: number;
  backupDate?: number;
  shortName?: string;
  mediumName?: string;
  attrs?: Record<string, boolean>;
};

export type FinderSessionDto = {
  sessionId: string;
  serverName: string;
  kind: string;
  volumes: string[];
  allowGuest: boolean;
  uams?: string[];
  rootId?: number;
  rootPath?: string;
  volume?: string;
  target?: string;
  transport?: string;
  protocol?: string;
  os?: string;
  dialect?: string;
  capabilities?: CatalogCapabilities;
};

export type TransferOptions = {
  destName: string;
  replace?: boolean;
  replaceId?: NodeRef | null;
  signal?: AbortSignal;
  onProgress?: (p: OpProgress) => void;
};

export type CrossTransferRequest = {
  srcSession: string;
  destSession: string;
  srcId: NodeRef;
  destParentId: NodeRef;
  destName: string;
  replace?: boolean;
};
