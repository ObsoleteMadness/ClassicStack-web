import { describe, expect, it } from 'vitest';
import { buildLocationCrumbs, networkPrefixFromStack } from './finder-location';

describe('buildLocationCrumbs', () => {
  it('keeps the full Network Browser trail when a share is mounted', () => {
    const prefix = networkPrefixFromStack([
      { id: '', name: 'Browse Network' },
      { id: 'AFP', name: 'AFP' },
      { id: 'AFP/LToUDP Network', name: 'LToUDP Network' },
      { id: 'AFP/LToUDP Network/snow', name: 'snow' },
    ]);
    const crumbs = buildLocationCrumbs({
      mode: 'network',
      locationUri: '',
      serverTitle: 'snow',
      networkPrefix: prefix,
      pathStack: [
        { id: 2, name: 'OpenSCSI Volume' },
        { id: 14, name: 'Documents' },
      ],
      volumeMounted: true,
    });
    expect(crumbs.map((c) => c.name)).toEqual([
      'Browse Network',
      'AFP',
      'LToUDP Network',
      'snow',
      'OpenSCSI Volume',
      'Documents',
    ]);
    expect(crumbs[3]?.networkPath).toBe('AFP/LToUDP Network/snow');
    expect(crumbs[4]?.volumeRoot).toBe(true);
  });

  it('shows Shared Volumes > share for a hosted catalog, not the volume as a server', () => {
    const crumbs = buildLocationCrumbs({
      mode: 'local',
      locationUri: '',
      serverTitle: 'OpenSCSI Volume',
      groupTitle: 'Shared Volumes',
      networkPrefix: [],
      pathStack: [
        { id: 2, name: 'OpenSCSI Volume' },
        { id: 14, name: 'Documents' },
      ],
      volumeMounted: true,
    });
    expect(crumbs.map((c) => c.name)).toEqual(['Shared Volumes', 'OpenSCSI Volume', 'Documents']);
    expect(crumbs[0]?.serverShares).toBeUndefined();
    expect(crumbs[1]?.volumeRoot).toBe(true);
  });

  it('shows server > share when the volume was opened from the sidebar', () => {
    const crumbs = buildLocationCrumbs({
      mode: 'server',
      locationUri: '',
      serverTitle: 'snow',
      networkPrefix: [],
      pathStack: [{ id: 2, name: 'OpenSCSI Volume' }],
      volumeMounted: true,
    });
    expect(crumbs.map((c) => c.name)).toEqual(['snow', 'OpenSCSI Volume']);
    expect(crumbs[0]?.serverShares).toBe(true);
  });

  it('shows the typed client URI when opened from Open by Path', () => {
    const uri = 'afp://snow:LToUDP Network,ltoudp/OpenSCSI Volume';
    const crumbs = buildLocationCrumbs({
      mode: 'url',
      locationUri: uri,
      serverTitle: 'snow',
      networkPrefix: [],
      pathStack: [
        { id: 2, name: 'OpenSCSI Volume' },
        { id: 14, name: 'System Folder' },
      ],
      volumeMounted: true,
    });
    expect(crumbs.map((c) => c.name)).toEqual([uri, 'System Folder']);
  });
});
