/** Sidebar grouping helpers. FinderWindow renders; the host owns labels and badges. */

import type { RemoteEndpoint, SidebarGroup } from './finder-host';

/** Default catch-all group when the host does not set `endpoint.group`. */
export const SIDEBAR_GROUP_NETWORK = 'network';

export type SidebarRow = {
  ep: RemoteEndpoint;
  /** Index in the Finder’s `servers` array (`data-server`). */
  index: number;
};

export function badgeText(badge: RemoteEndpoint['badge']): string {
  if (!badge) return '';
  return typeof badge === 'string' ? badge : badge.text;
}

export function badgeTitle(badge: RemoteEndpoint['badge']): string | undefined {
  if (!badge || typeof badge === 'string') return undefined;
  return badge.title;
}

/** Group id for one endpoint: host `group` if known, else the network/refresh fallback. */
export function assignSidebarGroup(ep: RemoteEndpoint, groups: readonly SidebarGroup[]): string {
  const known = new Set(groups.map((g) => g.id));
  if (ep.group && known.has(ep.group)) return ep.group;
  const fallback =
    groups.find((g) => g.id === SIDEBAR_GROUP_NETWORK) ??
    groups.find((g) => g.refresh) ??
    groups[groups.length - 1];
  return fallback?.id ?? SIDEBAR_GROUP_NETWORK;
}

/** Partition endpoints into host-defined groups, preserving original indices. */
export function endpointsByGroup(
  servers: readonly RemoteEndpoint[],
  groups: readonly SidebarGroup[],
): Map<string, SidebarRow[]> {
  const map = new Map<string, SidebarRow[]>();
  for (const g of groups) map.set(g.id, []);
  servers.forEach((ep, index) => {
    const id = assignSidebarGroup(ep, groups);
    const list = map.get(id) ?? [];
    list.push({ ep, index });
    map.set(id, list);
  });
  return map;
}

export function visibleSidebarGroups(
  groups: readonly SidebarGroup[],
  byGroup: Map<string, SidebarRow[]>,
): SidebarGroup[] {
  const out: SidebarGroup[] = [];
  let keptRefresh = false;
  for (const g of groups) {
    const rows = byGroup.get(g.id) ?? [];
    if (g.hideWhenEmpty && rows.length === 0) {
      if (g.refresh && !keptRefresh) {
        out.push(g);
        keptRefresh = true;
      }
      continue;
    }
    out.push(g);
    if (g.refresh) keptRefresh = true;
  }
  return out;
}

/** PWA IndexedDB Browser Share. */
export const LOCAL_SHARE_KEY = 'local';

/**
 * True when the sidebar row is itself a catalog (ClassicStack live share or a
 * FUSE/WinFsp mounted volume), not a server that lists volumes as children.
 */
export function isCatalogEndpoint(ep: RemoteEndpoint): boolean {
  return ep.kind === 'local' || ep.role === 'volume';
}

/** Stable Finder catalog key for an endpoint and optional volume child. */
export function shareKeyForEndpoint(ep: RemoteEndpoint, volume?: string): string {
  if (isCatalogEndpoint(ep)) return `endpoint:${ep.id}`;
  if (volume) return `${ep.id}:${volume}`;
  return `endpoint:${ep.id}`;
}

/**
 * True when the on-screen Finder catalog is already this ClassicStack share
 * or FUSE/WinFsp mount. Clicking the row must still switch catalogs when
 * another remote volume is open — id/name matches are not enough.
 */
export function viewingCatalogEndpoint(
  ep: RemoteEndpoint,
  currentId: string | undefined,
  source: 'local' | 'remote',
  remoteOpen: boolean,
): boolean {
  return isCatalogEndpoint(ep) && source === 'remote' && remoteOpen && currentId === ep.id;
}

export type ShareDrop = { key: string; name: string };

/**
 * Sidebar drop target under the pointer. ClassicStack shares and mounted
 * volumes use `data-share-key`; Browser Share uses `data-local`.
 */
export function shareDropFromElement(target: EventTarget | null, sidebar: Element | null): ShareDrop | null {
  const t = target instanceof Element ? target : null;
  if (!t || !sidebar) return null;
  if (t.closest('[data-eject], [data-eject-endpoint], [data-disconnect]')) return null;
  const el = t.closest('[data-share-key], [data-local]') as HTMLElement | null;
  if (!el || !sidebar.contains(el)) return null;
  const key = el.getAttribute('data-share-key') || (el.hasAttribute('data-local') ? LOCAL_SHARE_KEY : '');
  if (!key) return null;
  const name =
    el.getAttribute('data-share-name') ||
    el.querySelector('.side-item-label')?.getAttribute('aria-label') ||
    '';
  return { key, name };
}
