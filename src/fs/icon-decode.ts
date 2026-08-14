/**
 * Classic Mac icon family decoder for Finder icon view.
 * Re-exports the LibHfs.ResourceForks port.
 */

export {
  type DecodedIcon,
  decodeICNHash,
  decodeDesktopIcon,
  decodeIcon,
  decodedIconToDataUrl,
  SUPPORTED_ICON_TYPES,
} from './resource-types/icon-decoder';

export { ResourceFork } from './resource-fork';
export { IconSet, IconSize } from './resource-types/icon-set';
export { iconCache, type IconUrls, readTypeCreator } from './icon-cache';
