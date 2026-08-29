/** Network Neighborhood tree: Protocol → zone/workgroup → server → share. */

import type { RemoteEndpoint, ShareKind } from '../ui/finder-host';

export const NETWORK_ROOT_NAME = 'Browse Network';
export const NETWORK_SHARE_KEY = 'network';

export type NetworkRole = 'root' | 'protocol' | 'neighborhood' | 'server' | 'share' | 'service';
export type RemoteShareKind = Exclude<ShareKind, 'local'>;

/** Finder folder name for a file-sharing scheme (Browse Network → AFP → …). */
export const PROTOCOL_FOLDER: Record<RemoteShareKind, string> = {
  afp: 'AFP',
  smb: 'SMB',
  ncp: 'NetWare',
  etherdfs: 'EtherDFS',
};

const FOLDER_PROTOCOL: Record<string, RemoteShareKind> = {
  afp: 'afp',
  smb: 'smb',
  netware: 'ncp',
  ncp: 'ncp',
  etherdfs: 'etherdfs',
  edfs: 'etherdfs',
};

export function protocolFolderFor(kind: ShareKind): string | undefined {
  if (kind === 'local') return undefined;
  return PROTOCOL_FOLDER[kind];
}

export function protocolFromFolder(name: string): RemoteShareKind | undefined {
  return FOLDER_PROTOCOL[name.trim().toLowerCase()];
}

/** Link kind from a ClassicStack client URI (`afp://snow:Zone,ltoudp/` → `ltoudp`). */
export function linkKindFromId(id: string): string {
  const m = /,\s*([a-z0-9]+)\/?$/i.exec(id.trim());
  return m?.[1]?.toLowerCase() ?? '';
}

/** Fallback AppleTalk neighborhood when NBP did not name a zone. */
export function afpNetworkLabel(transport?: string, id?: string): string {
  let link = (transport || '').toLowerCase();
  if (!link || link === 'ddp' || link === 'nbp') link = linkKindFromId(id || '');
  switch (link) {
    case 'ltoudp':
      return 'LToUDP Network';
    case 'tashtalk':
      return 'TashTalk Network';
    case 'pcap':
    case 'tap':
    case 'ethertalk':
      return 'EtherTalk Network';
    case 'tcp':
      return 'TCP';
    default:
      return 'AppleTalk';
  }
}

export function normalizeZone(zone?: string): string {
  const z = (zone || '').trim();
  if (!z || z === '*') return '';
  return z;
}

/**
 * Workgroup / AppleTalk zone / transport network a server sits in.
 * Hosts may set `RemoteEndpoint.neighborhood`; otherwise it is derived.
 */
export function neighborhoodFor(ep: RemoteEndpoint): string {
  const pinned = (ep.neighborhood || '').trim();
  if (pinned) return pinned;
  if (ep.kind === 'afp') {
    if ((ep.transport || '').toLowerCase() === 'tcp') return 'TCP';
    const zone = normalizeZone(ep.subtitle);
    if (zone) return zone;
    return afpNetworkLabel(ep.transport, ep.id);
  }
  if (ep.kind === 'smb') return 'Workgroup';
  if (ep.kind === 'ncp') return 'IPX Network';
  if (ep.kind === 'etherdfs') return 'Ethernet';
  return 'Network';
}

/**
 * NCP and EtherDFS have no workgroup/zone folder — protocol lists servers.
 * AFP EtherTalk with no NBP zone skips the synthetic “EtherTalk Network” folder.
 */
export function protocolSkipsNeighborhood(kind: ShareKind): boolean {
  return kind === 'ncp' || kind === 'etherdfs';
}

/** True when this server is listed directly under its protocol folder. */
export function endpointSkipsNeighborhood(ep: RemoteEndpoint): boolean {
  if (protocolSkipsNeighborhood(ep.kind)) return true;
  if (ep.kind !== 'afp') return false;
  if ((ep.neighborhood || '').trim()) return false;
  if (normalizeZone(ep.subtitle)) return false;
  return afpNetworkLabel(ep.transport, ep.id) === 'EtherTalk Network';
}

/** Neighborhood folder name, or undefined when the server sits under the protocol. */
export function treeNeighborhood(ep: RemoteEndpoint): string | undefined {
  if (endpointSkipsNeighborhood(ep)) return undefined;
  return neighborhoodFor(ep);
}

/** True when the row is a discovered server (not a live share or FUSE mount). */
export function isNetworkServer(ep: RemoteEndpoint): boolean {
  return ep.kind !== 'local' && ep.role !== 'volume';
}

export function joinNetworkPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

export function serverNetworkPath(ep: RemoteEndpoint): string | undefined {
  const proto = protocolFolderFor(ep.kind);
  if (!proto || !isNetworkServer(ep)) return undefined;
  const title = (ep.title || '').trim();
  if (!title) return undefined;
  const nb = treeNeighborhood(ep);
  return nb ? joinNetworkPath(proto, nb, title) : joinNetworkPath(proto, title);
}

export type NetworkPathInfo = {
  role: NetworkRole;
  protocol?: RemoteShareKind;
  neighborhood?: string;
  server?: string;
  share?: string;
  /** Store path inside the share (`Documents/Readme`). Unset at the share root. */
  volumePath?: string;
};

function pathUsesNeighborhood(
  protocol: RemoteShareKind,
  second: string,
  endpoints?: readonly RemoteEndpoint[],
): boolean {
  if (protocolSkipsNeighborhood(protocol)) return false;
  if (!endpoints?.length) return true;
  const servers = endpoints.filter((ep) => isNetworkServer(ep) && ep.kind === protocol);
  const want = second.toLowerCase();
  const asFlat = servers.some(
    (ep) => endpointSkipsNeighborhood(ep) && ep.title.trim().toLowerCase() === want,
  );
  const asNb = servers.some(
    (ep) => !endpointSkipsNeighborhood(ep) && neighborhoodFor(ep).toLowerCase() === want,
  );
  if (asFlat && !asNb) return false;
  if (asNb) return true;
  if (servers.length && servers.every(endpointSkipsNeighborhood)) return false;
  return true;
}

/** Split a store path (`AFP/LToUDP Network/snow/OpenSCSI Volume/Docs`) into roles. */
export function parseNetworkPath(
  path: string,
  endpoints?: readonly RemoteEndpoint[],
): NetworkPathInfo {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { role: 'root' };
  const protocol = protocolFromFolder(parts[0]!);
  if (!protocol) return { role: 'root' };
  if (parts.length === 1) return { role: 'protocol', protocol };

  const nested = pathUsesNeighborhood(protocol, parts[1]!, endpoints);
  if (!nested) {
    if (parts.length === 2) return { role: 'server', protocol, server: parts[1] };
    const volumePath = parts.slice(3).join('/');
    return {
      role: 'share',
      protocol,
      server: parts[1],
      share: parts[2],
      volumePath: volumePath || undefined,
    };
  }

  if (parts.length === 2) {
    return { role: 'neighborhood', protocol, neighborhood: parts[1] };
  }
  if (parts.length === 3) {
    return { role: 'server', protocol, neighborhood: parts[1], server: parts[2] };
  }
  const volumePath = parts.slice(4).join('/');
  return {
    role: 'share',
    protocol,
    neighborhood: parts[1],
    server: parts[2],
    share: parts[3],
    volumePath: volumePath || undefined,
  };
}

export function matchNetworkServer(
  endpoints: readonly RemoteEndpoint[],
  protocol: RemoteShareKind,
  neighborhood: string | undefined,
  server: string,
): RemoteEndpoint | undefined {
  const wantNb = (neighborhood || '').toLowerCase();
  const wantName = server.toLowerCase();
  return endpoints.find((ep) => {
    if (!isNetworkServer(ep) || ep.kind !== protocol) return false;
    if (ep.title.trim().toLowerCase() !== wantName) return false;
    const nb = treeNeighborhood(ep);
    if (!wantNb) return !nb;
    return (nb || '').toLowerCase() === wantNb;
  });
}

/** Protocol → [zone] → server → share store path (no volume-relative segments). */
export function shareNetworkPath(
  protocol: RemoteShareKind,
  neighborhood: string | undefined,
  server: string,
  share: string,
): string {
  const proto = PROTOCOL_FOLDER[protocol];
  return neighborhood
    ? joinNetworkPath(proto, neighborhood, server, share)
    : joinNetworkPath(proto, server, share);
}
