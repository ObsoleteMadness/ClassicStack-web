/** Finder chrome from volume identity — decoration only, not catalog I/O. */

import type { ShareKind } from '../ui/finder-host';
import type { CatalogCapabilities, PathFormat } from './catalog-caps';

export type VolumeChrome = {
  volumeIcon: string;
  kindLabel: string;
  pathFormat: PathFormat;
};

/** Sidebar row kind: hosted share, discovered server, or a volume on that server. */
export type SidebarGlyphRole = 'share' | 'server' | 'volume';

const CHROME: Record<string, VolumeChrome> = {
  afp: { volumeIcon: 'appleshare', kindLabel: 'AppleShare', pathFormat: 'mac' },
  smb: { volumeIcon: 'windows', kindLabel: 'Windows share', pathFormat: 'dos' },
  ncp: { volumeIcon: 'novell', kindLabel: 'NetWare volume', pathFormat: 'ncp' },
  etherdfs: { volumeIcon: 'dos', kindLabel: 'DOS drive', pathFormat: 'dos' },
  local: { volumeIcon: 'disk', kindLabel: 'Local volume', pathFormat: 'posix' },
};

const GENERIC: VolumeChrome = { volumeIcon: 'disk', kindLabel: 'Volume', pathFormat: 'posix' };

const SHARE_GLYPHS: Record<string, string> = {
  afp: '/icons/classic/AppleShare.gif',
  smb: '/icons/classic/windows-share3.png',
  ncp: '/icons/classic/NovellShare.png',
  etherdfs: '/icons/classic/ibmshare.png',
};

const SERVER_GLYPHS: Record<string, string> = {
  afp: '/icons/ui/icons8-happy-mac-50.png',
  smb: '/icons/classic/win-pc2.png',
  ncp: '/icons/classic/ncp-server.png',
  etherdfs: '/icons/classic/dos1.png',
};

const VOLUME_GLYPHS: Record<string, string> = {
  afp: '/icons/icl8_-3978.png',
  smb: '/icons/classic/windows-share2.png',
  ncp: '/icons/classic/netware-share.png',
  etherdfs: '/icons/ui/icons8-c-drive-2-50.png',
};

function protocolKey(protocol: string): string {
  const key = protocol.toLowerCase();
  return key === 'edfs' ? 'etherdfs' : key;
}

/** Classic glyph for a Finder sidebar row, or undefined to keep the colored dot. */
export function sidebarGlyphSrc(protocol: string, role: SidebarGlyphRole): string | undefined {
  const key = protocolKey(protocol);
  const map = role === 'share' ? SHARE_GLYPHS : role === 'server' ? SERVER_GLYPHS : VOLUME_GLYPHS;
  return map[key];
}

const NETWORK_ROOT_GLYPH = '/icons/classic/mac-network.png';
const NETWORK_GROUP_GLYPH = '/icons/classic/mac-group.png';

/** Glyph for a Network Browser container (same art as the matching sidebar row). */
export function networkGlyphSrc(
  role: 'root' | 'protocol' | 'neighborhood' | 'server' | 'share' | 'service',
  protocol?: string,
  serviceKind?: string,
): string {
  switch (role) {
    case 'root':
      return NETWORK_ROOT_GLYPH;
    case 'protocol':
      return sidebarGlyphSrc(protocol || 'afp', 'share') || NETWORK_ROOT_GLYPH;
    case 'neighborhood':
      return NETWORK_GROUP_GLYPH;
    case 'server':
      return sidebarGlyphSrc(protocol || 'afp', 'server') || NETWORK_ROOT_GLYPH;
    case 'share':
      return sidebarGlyphSrc(protocol || 'afp', 'volume') || NETWORK_ROOT_GLYPH;
    case 'service':
      if (serviceKind === 'macipgw') return NETWORK_ROOT_GLYPH;
      return NETWORK_GROUP_GLYPH;
  }
}

/** Chrome for a volume: local shares use protocol so local+smb still looks Windows. */
export function volumeChrome(caps: CatalogCapabilities): VolumeChrome {
  const kind: ShareKind | string = caps.identity.shareKind === 'local'
    ? (caps.identity.protocol ?? 'local')
    : caps.identity.shareKind;
  const base = CHROME[kind] ?? CHROME[caps.identity.shareKind] ?? GENERIC;
  return {
    ...base,
    pathFormat: caps.pathFormat || base.pathFormat,
    kindLabel: caps.identity.shareKind === 'local' && caps.identity.protocol
      ? `Local ${base.kindLabel}`
      : base.kindLabel,
  };
}

/** True when s is a ClassicStack client URI (`scheme://…`), not an NBP object name. */
export function isClientURI(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

/**
 * Join a discovered server with a volume per the client URI grammar:
 *   scheme://[user[:pass]@]server[,transport]/volume
 * NBP names (in-browser AFP) stay `server:volume`.
 */
export function clientVolumeURI(server: string, volume = ''): string {
  const vol = volume.trim();
  if (isClientURI(server)) {
    const base = server.replace(/\/+$/, '');
    if (!vol) return base;
    const suffix = '/' + vol;
    if (base.toLowerCase().endsWith(suffix.toLowerCase())) return base;
    return base + suffix;
  }
  if (!vol) return server;
  return `${server}:${vol}`;
}

/** Format a store-relative `'/'` path for the status bar / Get Info. */
export function formatStorePath(path: string, fmt: PathFormat, volume = ''): string {
  const parts = path.split('/').filter(Boolean);
  switch (fmt) {
    case 'mac':
      return [volume || 'Volume', ...parts].join(':');
    case 'dos':
      return (volume ? `${volume}\\` : '\\') + parts.join('\\');
    case 'ncp':
      return `${volume || 'VOL'}:${parts.join('/')}`;
    default:
      return '/' + parts.join('/');
  }
}
