/** No-op Catalog used when the Finder has no local share (ClassicStack Go SPA). */

import type { ByteRangeReader } from './byte-range';
import type { ResourceFork } from './resource-fork';
import type {
  Catalog,
  ChildrenBatchListener,
  VfsChangeListener,
  VNode,
} from './virtual-fs';

const ROOT_ID = 2;

function emptyRoot(): VNode {
  return {
    id: ROOT_ID,
    parentId: 1,
    name: '',
    isDir: true,
    data: new Uint8Array(),
    resource: new Uint8Array(),
    finderInfo: new Uint8Array(32),
    createDate: 0,
    modDate: 0,
  };
}

function unsupported(op: string): never {
  throw new Error(`empty catalog: ${op} is not supported`);
}

/** Catalog with an empty root; mutations throw. */
export class EmptyCatalog implements Catalog {
  rootId(): number {
    return ROOT_ID;
  }

  subscribe(_fn: VfsChangeListener): () => void {
    return () => undefined;
  }

  beginBatch(): void {}
  endBatch(): void {}

  async get(id: number): Promise<VNode | undefined> {
    return id === ROOT_ID ? emptyRoot() : undefined;
  }

  async ensureContent(id: number): Promise<VNode | undefined> {
    return this.get(id);
  }

  async children(
    _parentId: number,
    onBatch?: ChildrenBatchListener,
    _signal?: AbortSignal,
  ): Promise<VNode[]> {
    onBatch?.([]);
    return [];
  }

  async lookup(): Promise<VNode | undefined> {
    return undefined;
  }

  async loadResourceFork(): Promise<ResourceFork | null> {
    return null;
  }

  async loadIconResources(): Promise<ResourceFork | null> {
    return null;
  }

  async withRangeReader<T>(
    _node: VNode,
    fn: (read: ByteRangeReader) => Promise<T>,
  ): Promise<T> {
    const read: ByteRangeReader = async () => new Uint8Array();
    return fn(read);
  }

  mkdir(): Promise<VNode> {
    return unsupported('mkdir');
  }
  ensureDir(): Promise<VNode> {
    return unsupported('ensureDir');
  }
  createFile(): Promise<VNode> {
    return unsupported('createFile');
  }
  put(): Promise<void> {
    return unsupported('put');
  }
  rename(): Promise<void> {
    return unsupported('rename');
  }
  move(): Promise<void> {
    return unsupported('move');
  }
  remove(): Promise<void> {
    return unsupported('remove');
  }
  importDataTransfer(): Promise<number> {
    return unsupported('importDataTransfer');
  }
}
