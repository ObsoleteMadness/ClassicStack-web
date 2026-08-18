import { describe, expect, it } from 'vitest';
import type { RemoteEndpoint, SidebarGroup } from './finder-host';
import {
  SIDEBAR_GROUP_NETWORK,
  assignSidebarGroup,
  endpointsByGroup,
  isCatalogEndpoint,
  shareKeyForEndpoint,
  viewingCatalogEndpoint,
  visibleSidebarGroups,
} from './finder-sidebar';

function ep(partial: Partial<RemoteEndpoint> & Pick<RemoteEndpoint, 'id' | 'title'>): RemoteEndpoint {
  return { kind: 'afp', ...partial };
}

const classic: SidebarGroup[] = [
  { id: 'shares', title: 'Shares', hideWhenEmpty: true },
  { id: 'appletalk', title: 'AppleTalk', refresh: true, empty: 'None' },
  { id: 'smb', title: 'SMB', empty: 'None' },
  { id: 'netware', title: 'NetWare', empty: 'None' },
  { id: 'etherdfs', title: 'EtherDFS', empty: 'None' },
];

describe('assignSidebarGroup', () => {
  it('keeps a host group when it is in the layout', () => {
    expect(assignSidebarGroup(ep({ id: '1', title: 'SYS', group: 'netware' }), classic)).toBe('netware');
  });

  it('falls back to the network / refresh group for unknown ids', () => {
    expect(assignSidebarGroup(ep({ id: '1', title: 'X', group: 'other' }), classic)).toBe('appletalk');
    expect(
      assignSidebarGroup(ep({ id: '1', title: 'X' }), [
        { id: SIDEBAR_GROUP_NETWORK, title: 'Network', refresh: true },
      ]),
    ).toBe(SIDEBAR_GROUP_NETWORK);
  });
});

describe('endpointsByGroup', () => {
  it('groups shares and clients separately and preserves server indices', () => {
    const servers = [
      ep({ id: 'local:afp:HD', title: 'HD', kind: 'local', group: 'shares', badge: 'AFP' }),
      ep({ id: 'Mac', title: 'Mac', group: 'appletalk', badge: 'NBP' }),
      ep({ id: 'FILE', title: 'FILE', kind: 'smb', group: 'smb', badge: 'TCP' }),
    ];
    const by = endpointsByGroup(servers, classic);
    expect(by.get('shares')?.map((r) => r.index)).toEqual([0]);
    expect(by.get('appletalk')?.map((r) => r.ep.badge)).toEqual(['NBP']);
    expect(by.get('smb')?.[0]?.index).toBe(2);
    expect(by.get('netware')).toEqual([]);
  });
});

describe('visibleSidebarGroups', () => {
  it('hides empty hideWhenEmpty groups but keeps a refresh group', () => {
    const by = endpointsByGroup(
      [ep({ id: 'FILE', title: 'FILE', kind: 'smb', group: 'smb', badge: 'TCP' })],
      classic,
    );
    expect(visibleSidebarGroups(classic, by).map((g) => g.id)).toEqual(['appletalk', 'smb', 'netware', 'etherdfs']);
  });
});

describe('share keys and drop targets', () => {
  it('treats ClassicStack shares and FUSE mounts as catalog rows', () => {
    const share = ep({ id: 'local:afp:HD', title: 'HD', kind: 'local' });
    const mounted = ep({ id: 'mounted:abc', title: 'SYS', kind: 'ncp', role: 'volume' });
    const server = ep({ id: 'Mac', title: 'Mac' });
    expect(isCatalogEndpoint(share)).toBe(true);
    expect(isCatalogEndpoint(mounted)).toBe(true);
    expect(isCatalogEndpoint(server)).toBe(false);
    expect(shareKeyForEndpoint(share)).toBe('endpoint:local:afp:HD');
    expect(shareKeyForEndpoint(mounted)).toBe('endpoint:mounted:abc');
    expect(shareKeyForEndpoint(server, 'Mac HD')).toBe('Mac:Mac HD');
  });

  it('switches to a ClassicStack share when another remote catalog is on screen', () => {
    const share = ep({ id: 'local:afp:HD', title: 'HD', kind: 'local' });
    const remote = ep({ id: 'mounted:abc', title: 'SYS', kind: 'ncp', role: 'volume' });
    const server = ep({ id: 'Mac', title: 'Mac' });
    expect(viewingCatalogEndpoint(share, remote.id, 'remote', true)).toBe(false);
    expect(viewingCatalogEndpoint(share, share.id, 'remote', true)).toBe(true);
    expect(viewingCatalogEndpoint(share, share.id, 'remote', false)).toBe(false);
    expect(viewingCatalogEndpoint(server, share.id, 'remote', true)).toBe(false);
  });
});
