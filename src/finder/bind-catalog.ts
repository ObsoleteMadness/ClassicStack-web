/** Attach FinderAPI copy/move/expand onto an existing Catalog (VirtualFS / RemoteVfs). */

import type { Catalog } from '../fs/virtual-fs';
import { consumeProgress } from './progress';
import type { CatalogWithBackend, FinderAPI } from './api';
import type { TransferOptions } from './types';

/** Wrap `cat` so FinderWindow can call copyFrom / moveFrom / expandNode. */
export function bindCatalog<T extends Catalog>(cat: T, api: FinderAPI, sessionId: string): T & CatalogWithBackend {
  const bound = cat as T & CatalogWithBackend;
  Object.defineProperty(bound, 'sessionId', { value: sessionId, enumerable: true, configurable: true });
  Object.defineProperty(bound, 'api', { value: api, enumerable: true, configurable: true });
  bound.copyFrom = async (src, srcId, destParent, opts: TransferOptions) => {
    await consumeProgress(
      api.copy(
        {
          srcSession: src.sessionId,
          destSession: sessionId,
          srcId,
          destParentId: destParent,
          destName: opts.destName,
          replace: !!opts.replace,
        },
        opts.signal,
      ),
      opts.onProgress,
      opts.signal,
    );
  };
  bound.moveFrom = async (src, srcId, destParent, opts: TransferOptions) => {
    if (src.api.backendId === api.backendId && src.sessionId === sessionId) {
      if (opts.replaceId != null) await bound.remove(opts.replaceId);
      if (opts.destName) await src.rename(srcId, opts.destName);
      await src.move(srcId, destParent);
      return;
    }
    await consumeProgress(
      api.moveAcross(
        {
          srcSession: src.sessionId,
          destSession: sessionId,
          srcId,
          destParentId: destParent,
          destName: opts.destName,
          replace: !!opts.replace,
        },
        opts.signal,
      ),
      opts.onProgress,
      opts.signal,
    );
  };
  bound.expandNode = async (id, opts) => {
    await consumeProgress(api.expand(sessionId, id, opts?.signal), opts?.onProgress, opts?.signal);
  };
  return bound;
}
