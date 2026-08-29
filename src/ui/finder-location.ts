/** Finder path-bar crumbs: network trail, server > share, or a typed client URI. */

import type { NodeRef } from '../fs/catalog-caps';
import { networkGlyphSrc } from '../fs/volume-chrome';
import { NETWORK_ROOT_NAME, parseNetworkPath } from '../fs/network-tree';

export type LocationMode = 'local' | 'network' | 'server' | 'url';

export type NetworkPrefixCrumb = {
  name: string;
  path: string;
  iconSrc?: string;
};

export type LocationCrumb = {
  name: string;
  iconSrc?: string;
  /** Navigate in the current volume catalog. */
  nodeId?: NodeRef;
  pathIndex?: number;
  /** Switch back to the Network Browser at this store path (`''` = root). */
  networkPath?: string;
  /** Volume catalog root (share that is currently mounted). */
  volumeRoot?: boolean;
  /** Re-list this server’s shares (sidebar / server-mode first crumb). */
  serverShares?: boolean;
};

export function networkPrefixFromStack(
  pathStack: readonly { id: NodeRef; name: string }[],
): NetworkPrefixCrumb[] {
  return pathStack.map((p) => {
    const path = typeof p.id === 'string' ? p.id : '';
    const info = parseNetworkPath(path);
    return {
      name: p.name,
      path,
      iconSrc: networkGlyphSrc(info.role, info.protocol),
    };
  });
}

/**
 * Crumbs for the Finder path bar.
 *
 * - `network`: Browse Network → protocol → zone → server → [share → folders]
 * - `server`: server → share → folders
 * - `url`: the typed client URI → folders inside the share
 * - `local`: [group] → volume → folders (`groupTitle` is “Shared Volumes” for hosted shares)
 */
export function buildLocationCrumbs(opts: {
  mode: LocationMode;
  locationUri: string;
  serverTitle: string;
  protocol?: string;
  /** Sidebar group shown as a parent of a hosted/mounted catalog (not a file server). */
  groupTitle?: string;
  networkPrefix: readonly NetworkPrefixCrumb[];
  pathStack: readonly { id: NodeRef; name: string }[];
  volumeMounted: boolean;
}): LocationCrumb[] {
  const proto = opts.protocol;
  const folders = opts.pathStack.slice(1).map((p, i) => ({
    name: p.name,
    nodeId: p.id,
    pathIndex: i + 1,
  }));
  const vol = opts.pathStack[0];

  if (opts.mode === 'url' && opts.locationUri) {
    const crumbs: LocationCrumb[] = [
      { name: opts.locationUri, volumeRoot: true, pathIndex: 0, iconSrc: networkGlyphSrc('share', proto) },
    ];
    return [...crumbs, ...folders];
  }

  if (opts.mode === 'network') {
    const prefix = opts.networkPrefix.length
      ? opts.networkPrefix
      : networkPrefixFromStack(opts.pathStack);
    if (!opts.volumeMounted) {
      return prefix.map((c) => ({
        name: c.name || NETWORK_ROOT_NAME,
        iconSrc: c.iconSrc,
        networkPath: c.path,
      }));
    }
    const crumbs: LocationCrumb[] = prefix.map((c) => ({
      name: c.name || NETWORK_ROOT_NAME,
      iconSrc: c.iconSrc,
      networkPath: c.path,
    }));
    if (vol) {
      crumbs.push({
        name: vol.name,
        nodeId: vol.id,
        volumeRoot: true,
        pathIndex: 0,
        iconSrc: networkGlyphSrc('share', proto),
      });
    }
    return [...crumbs, ...folders];
  }

  const group = (opts.groupTitle || '').trim();
  if (group && opts.mode !== 'server') {
    const crumbs: LocationCrumb[] = [
      { name: group, iconSrc: networkGlyphSrc('share', proto) },
    ];
    if (vol) {
      crumbs.push({
        name: vol.name,
        nodeId: vol.id,
        volumeRoot: true,
        pathIndex: 0,
        iconSrc: networkGlyphSrc('share', proto),
      });
    }
    return [...crumbs, ...folders];
  }

  if (opts.mode === 'server' && opts.serverTitle) {
    const crumbs: LocationCrumb[] = [
      {
        name: opts.serverTitle,
        serverShares: true,
        iconSrc: networkGlyphSrc('server', proto),
      },
    ];
    if (vol) {
      crumbs.push({
        name: vol.name,
        nodeId: vol.id,
        volumeRoot: true,
        pathIndex: 0,
        iconSrc: networkGlyphSrc('share', proto),
      });
    }
    return [...crumbs, ...folders];
  }

  return opts.pathStack.map((p, i) => ({
    name: p.name,
    nodeId: p.id,
    volumeRoot: i === 0,
    pathIndex: i,
  }));
}
