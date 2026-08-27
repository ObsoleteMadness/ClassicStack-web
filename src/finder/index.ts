/** Public Finder VFS contract: AFP (PWA) and HTTP (ClassicStack-go SPA) share these types. */

export type { FinderAPI, CatalogWithBackend, ConnectRequest } from './api';
export { isCatalogWithBackend } from './api';
export { ApiCatalog } from './api-catalog';
export { AfpFinderAPI } from './afp-finder-api';
export { bindCatalog } from './bind-catalog';
export { consumeProgress, readSSEProgress } from './progress';
export type {
  OpProgress,
  OpPhase,
  FinderNodeDto,
  FinderSessionDto,
  TransferOptions,
  CrossTransferRequest,
} from './types';
export type { CatalogCapabilities, NodeRef, VolumeIdentity } from '../fs/catalog-caps';
export {
  afpVolumeCaps,
  smbVolumeCaps,
  ncpVolumeCaps,
  edfsVolumeCaps,
  localShareCaps,
  catalogCapsForSession,
  parseRefKey,
  refKey,
} from '../fs/catalog-caps';
export { volumeChrome, sidebarGlyphSrc, formatStorePath, clientVolumeURI, isClientURI } from '../fs/volume-chrome';
export type { SidebarGlyphRole } from '../fs/volume-chrome';
