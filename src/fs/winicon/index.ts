/** Windows ICO decoding and PE/NE executable icon extraction. */

export {
  decodeIco,
  decodeIcoFromReader,
  encodeIco,
  extractNeIcons,
  extractNeIconsFromBuffer,
  extractPeIcons,
  extractPeIconsFromBuffer,
  extractWinIcons,
  extractWinIconsFromBuffer,
  isWinExeName,
  isWinIconName,
  isWinResourceName,
  isWinVersionName,
  pickIconNear,
  sniffWinIcon,
  type WinIconKind,
} from './extract';
export { sniffIcoHeader, enumerateIcoFrames } from './ico';
export { sniffBmp, decodeBmp } from './bmp';
export { enumeratePeResources, type PeResourceLeaf, type PeResourceTable } from './pe';
export { enumerateNeResources, type NeResourceLeaf, type NeResourceTable } from './ne';
export {
  inspectWinResources,
  preferredWinType,
  type WinResEntry,
  type WinResInspect,
  type WinResKind,
  type WinResTypeGroup,
} from './table';
export { decodeVersionInfo, decodeStringTable, previewWinResource, type WinResPreview } from './decode-res';
export {
  extractWinVersion,
  winVersionForGetInfo,
  type WinVersionGetInfo,
} from './version-info';
export {
  RT_BITMAP,
  RT_CURSOR,
  RT_GROUP_ICON,
  RT_ICON,
  RT_MANIFEST,
  RT_STRING,
  RT_VERSION,
  RT_VERSIONINFO,
  rtTypeCode,
  rtTypeLabel,
} from './rt';
