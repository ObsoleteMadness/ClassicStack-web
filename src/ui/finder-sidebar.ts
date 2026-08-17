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
