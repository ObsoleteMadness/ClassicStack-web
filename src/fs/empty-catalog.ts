/** No-op Catalog used when the Finder has no local share (ClassicStack Go SPA). */

import type { ByteRangeReader } from './byte-range';
import type { ResourceFork } from './resource-fork';
import { afpVolumeCaps, type CatalogCapabilities, type NodeRef } from './catalog-caps';
import type {
  Catalog,
  ChildrenBatchListener,
  CnidVNode,
  VfsChangeListener,
  VNode,
} from './virtual-fs';

const ROOT_ID = 2;

function emptyRoot(): CnidVNode {
  return {
    addr: 'cnid',
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
  capabilities(): CatalogCapabilities {
    return {
      ...afpVolumeCaps,
      readOnly: true,
      resourceFork: false,
      finderInfo: false,
      desktopIcons: false,
      resourceIcons: false,
    };
  }

  rootId(): NodeRef {
    return ROOT_ID;
  }

  subscribe(_fn: VfsChangeListener): () => void {
    return () => undefined;
  }

  beginBatch(): void {}
  endBatch(): void {}

  async get(ref: NodeRef): Promise<VNode | undefined> {
    return ref === ROOT_ID ? emptyRoot() : undefined;
  }

  async ensureContent(ref: NodeRef): Promise<VNode | undefined> {
    return this.get(ref);
  }

  async children(
    _parent: NodeRef,
    onBatch?: ChildrenBatchListener,
    _signal?: AbortSignal,
  ): Promise<VNode[]> {
    onBatch?.([]);
    return [];
  }

  async lookup(): Promise<VNode | undefined> {
    return undefined;
  }

  async resolvePath(path: string): Promise<VNode | undefined> {
    return path === '' || path === '/' ? emptyRoot() : undefined;
  }

  async pathOf(): Promise<string> {
    return '';
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
