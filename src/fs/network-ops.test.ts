import { describe, expect, it } from 'vitest';
import type { PathVNode } from './virtual-fs';
import {
  isNetworkContainer,
  isNetworkNavigable,
  opsForNetworkNode,
  overlayNativeOf,
  selectionAllowsMutate,
  selectionAllowsZip,
} from './network-ops';

function node(role: NonNullable<PathVNode['chrome']>['networkRole'], extra?: Partial<PathVNode>): PathVNode {
  return {
    addr: 'path',
    path: role || '',
    parentPath: '',
    name: role || 'x',
    isDir: false,
    data: new Uint8Array(),
    resource: new Uint8Array(),
    finderInfo: new Uint8Array(32),
    createDate: 0,
    modDate: 0,
    chrome: { networkRole: role, container: true },
    ...extra,
  };
}

describe('network container ops', () => {
  it('treats protocol, zone, server, share, and service as containers, not directories', () => {
    for (const role of ['protocol', 'neighborhood', 'server', 'share', 'service'] as const) {
      const n = node(role);
      expect(n.isDir).toBe(false);
      expect(isNetworkContainer(n)).toBe(true);
    }
    expect(isNetworkNavigable(node('protocol'))).toBe(true);
    expect(isNetworkNavigable(node('share'))).toBe(true);
    expect(isNetworkNavigable(node('service'))).toBe(false);
  });

  it('forbids file operations on network objects except zip on a volume', () => {
    expect(opsForNetworkNode(node('server'))).toMatchObject({ mutate: false, downloadZip: false });
    expect(opsForNetworkNode(node('neighborhood'))).toMatchObject({ mutate: false, downloadZip: false });
    expect(opsForNetworkNode(node('protocol'))).toMatchObject({ mutate: false, downloadZip: false });
    expect(opsForNetworkNode(node('share'))).toMatchObject({ mutate: false, downloadZip: true });
    expect(selectionAllowsMutate([node('share')])).toBe(false);
    expect(selectionAllowsZip([node('share')])).toBe(true);
    expect(selectionAllowsZip([node('server')])).toBe(false);
  });

  it('allows zip and mutate on overlay files inside a mounted share', () => {
    const folder = node(undefined, {
      path: 'AFP/zone/server/Vol/Documents',
      name: 'Documents',
      isDir: true,
      chrome: { catalogKey: 'snow:Vol', nativeRef: 14 },
    });
    expect(isNetworkContainer(folder)).toBe(false);
    expect(opsForNetworkNode(folder)).toBeNull();
    expect(selectionAllowsMutate([folder])).toBe(true);
    expect(selectionAllowsZip([folder])).toBe(true);
    expect(overlayNativeOf(folder)).toEqual({ catalogKey: 'snow:Vol', nativeRef: 14 });
    expect(overlayNativeOf(node('share', { chrome: { networkRole: 'share', catalogKey: 'k', nativeRef: 2 } }))).toEqual({
      catalogKey: 'k',
      nativeRef: 2,
    });
    expect(overlayNativeOf(node('server'))).toBeNull();
  });
});
