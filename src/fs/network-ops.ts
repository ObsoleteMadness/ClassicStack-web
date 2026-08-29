/** Network Browser nodes are containers, not filesystem directories. */

import type { NodeRef } from './catalog-caps';
import type { VNode } from './virtual-fs';
import type { NetworkRole } from './network-tree';

export type NetworkItemOps = {
  getInfo: boolean;
  /** Open / mount / navigate into. */
  open: boolean;
  downloadZip: boolean;
  /** Cut, copy, paste, rename, move, delete. */
  mutate: boolean;
  resources: boolean;
};

const CONTAINER_ROLES = new Set<NetworkRole>([
  'root',
  'protocol',
  'neighborhood',
  'server',
  'share',
  'service',
]);

const CHILD_ROLES = new Set<NetworkRole>(['root', 'protocol', 'neighborhood', 'server', 'share']);

export function networkRoleOf(node: VNode | null | undefined): NetworkRole | undefined {
  return node?.chrome?.networkRole;
}

/** True when this node is a Network Browser container (not a directory). */
export function isNetworkContainer(node: VNode | null | undefined): boolean {
  const role = networkRoleOf(node);
  return !!role && CONTAINER_ROLES.has(role);
}

/** Protocol / zone / server / share containers list children; services do not. */
export function networkHasChildren(role: NetworkRole | undefined): boolean {
  return !!role && CHILD_ROLES.has(role);
}

/** Column / list navigation, including expanding a volume into its folders. */
export function isNetworkNavigable(node: VNode | null | undefined): boolean {
  if (!node) return false;
  if (node.isDir) return true;
  return isNetworkContainer(node) && networkHasChildren(networkRoleOf(node));
}

/** Double-click: navigate, mount a share, or Get Info on a service. */
export function isNetworkOpenable(node: VNode | null | undefined): boolean {
  return !!node && (node.isDir || isNetworkContainer(node));
}

/** File-manager operations allowed on a Network Browser node. `null` = not a network object. */
export function opsForNetworkNode(node: VNode | null | undefined): NetworkItemOps | null {
  const role = networkRoleOf(node);
  if (!role) return null;
  return {
    getInfo: true,
    open: true,
    downloadZip: role === 'share',
    mutate: false,
    resources: false,
  };
}

export function selectionAllowsMutate(nodes: readonly VNode[]): boolean {
  if (!nodes.length) return true;
  return nodes.every((n) => opsForNetworkNode(n)?.mutate !== false);
}

export function selectionAllowsZip(nodes: readonly VNode[]): boolean {
  if (!nodes.length) return true;
  return nodes.every((n) => {
    const ops = opsForNetworkNode(n);
    if (!ops) return true;
    return ops.downloadZip;
  });
}

/**
 * Volume catalog key + native ref for a Network Browser overlay node (a file or
 * folder inside a mounted share, or the share used as a drop/mkdir destination).
 */
export function overlayNativeOf(
  node: VNode | null | undefined,
): { catalogKey: string; nativeRef: NodeRef } | null {
  const role = node?.chrome?.networkRole;
  if (role && role !== 'share') return null;
  const catalogKey = node?.chrome?.catalogKey;
  const nativeRef = node?.chrome?.nativeRef;
  if (catalogKey == null || nativeRef == null) return null;
  return { catalogKey, nativeRef };
}
