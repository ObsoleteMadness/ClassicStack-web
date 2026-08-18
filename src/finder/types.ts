/** Shared Finder VFS job progress (Go SSE and in-browser AFP). */

export type OpPhase = 'copying' | 'moving' | 'expanding' | 'listing';

export type OpProgress = {
  phase?: OpPhase;
  path?: string;
  bytesDone?: number;
  bytesTotal?: number;
  destName?: string;
  destParentId?: number;
  done?: boolean;
  error?: string;
};

export type FinderNodeDto = {
  id: number;
  parentId: number;
  name: string;
  isDir: boolean;
  dataBytes?: number;
  resourceBytes?: number;
  finderInfo?: string;
  createDate?: number;
  modDate?: number;
};

export type FinderSessionDto = {
  sessionId: string;
  serverName: string;
  kind: string;
  volumes: string[];
  allowGuest: boolean;
  uams?: string[];
  rootId?: number;
  volume?: string;
  target?: string;
  transport?: string;
};

export type TransferOptions = {
  destName: string;
  replace?: boolean;
  replaceId?: number | null;
  signal?: AbortSignal;
  onProgress?: (p: OpProgress) => void;
};

export type CrossTransferRequest = {
  srcSession: string;
  destSession: string;
  srcId: number;
  destParentId: number;
  destName: string;
  replace?: boolean;
};
