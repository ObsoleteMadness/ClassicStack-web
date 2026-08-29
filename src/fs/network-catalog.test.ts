import { describe, expect, it } from 'vitest';
import type { RemoteEndpoint } from '../ui/finder-host';
import { NetworkCatalog } from './network-catalog';
import { EmptyCatalog } from './empty-catalog';
import type { PathVNode } from './virtual-fs';

function ep(partial: Partial<RemoteEndpoint> & Pick<RemoteEndpoint, 'id' | 'title'>): RemoteEndpoint {
  return { kind: 'afp', ...partial };
}

describe('NetworkCatalog', () => {
  it('lists protocols, zones, servers, then shares', async () => {
    const snow = ep({
      id: 'afp://snow:LToUDP Network,ltoudp/',
      title: 'snow',
      subtitle: 'LToUDP Network',
    });
    const cat = new NetworkCatalog({
      endpoints: () => [snow],
      schemes: () => ['afp', 'smb'],
      volumes: (e) => (e.id === snow.id ? ['OpenSCSI Volume'] : []),
    });

    const root = await cat.children('');
    expect(root.map((n) => n.name)).toEqual(['AFP', 'SMB']);
    expect(root[0]?.chrome?.networkRole).toBe('protocol');

    const zones = await cat.children('AFP');
    expect(zones.map((n) => n.name)).toEqual(['LToUDP Network']);
    expect(zones[0]?.chrome?.networkRole).toBe('neighborhood');

    const servers = await cat.children('AFP/LToUDP Network');
    expect(servers.map((n) => n.name)).toEqual(['snow']);
    expect(servers[0]?.chrome?.endpointId).toBe(snow.id);

    const shares = await cat.children('AFP/LToUDP Network/snow');
    expect(shares.map((n) => n.name)).toEqual(['OpenSCSI Volume']);
    expect(shares[0]?.chrome?.networkRole).toBe('share');
    expect(shares[0]?.isDir).toBe(true);
    expect(shares[0]?.chrome?.container).toBe(true);
    expect(shares[0]?.chrome?.iconSrc).toContain('icl8_');
  });

  it('lists extra services under a server beside file shares', async () => {
    const snow = ep({
      id: 'afp://snow:LToUDP Network,ltoudp/',
      title: 'snow',
      subtitle: 'LToUDP Network',
      services: [
        { kind: 'printer', name: 'LaserWriter' },
        { kind: 'macipgw', name: 'MacIP Gateway' },
      ],
    });
    const cat = new NetworkCatalog({
      endpoints: () => [snow],
      schemes: () => ['afp'],
      volumes: () => ['Macintosh HD'],
    });
    const kids = await cat.children('AFP/LToUDP Network/snow');
    expect(kids.map((n) => n.name)).toEqual(['Macintosh HD', 'LaserWriter', 'MacIP Gateway']);
    expect(kids[1]?.chrome?.networkRole).toBe('service');
    expect(kids[1]?.chrome?.serviceKind).toBe('printer');
    expect(kids[2]?.chrome?.serviceKind).toBe('macipgw');
    expect(kids.every((n) => n.chrome?.container)).toBe(true);
    expect(kids[0]?.isDir).toBe(true);
    expect(kids[1]?.isDir).toBe(false);
    expect(kids[2]?.isDir).toBe(false);
  });

  it('groups two TashTalk AFP servers under one neighborhood', async () => {
    const cat = new NetworkCatalog({
      endpoints: () => [
        ep({ id: 'Mac A', title: 'Mac A', transport: 'nbp', subtitle: '*' }),
        ep({ id: 'Mac B', title: 'Mac B', transport: 'nbp' }),
      ],
      schemes: () => ['afp'],
      volumes: () => [],
    });
    const zones = await cat.children('AFP');
    expect(zones.map((n) => n.name)).toEqual(['AppleTalk']);
    const servers = await cat.children('AFP/AppleTalk');
    expect(servers.map((n) => n.name)).toEqual(['Mac A', 'Mac B']);
  });

  it('lists NCP and unzoned EtherTalk servers directly under the protocol', async () => {
    const fs = ep({ id: 'ncp://FS/SYS', title: 'FS', kind: 'ncp' });
    const mac = ep({
      id: 'afp://iMac,ethertalk/',
      title: 'iMac',
      kind: 'afp',
      transport: 'ethertalk',
      subtitle: '*',
    });
    const cat = new NetworkCatalog({
      endpoints: () => [fs, mac],
      schemes: () => ['ncp', 'afp'],
      volumes: (e) => (e.id === fs.id ? ['SYS'] : ['Macintosh HD']),
    });
    expect((await cat.children('NetWare')).map((n) => n.name)).toEqual(['FS']);
    expect((await cat.children('NetWare'))[0]?.chrome?.networkRole).toBe('server');
    expect((await cat.children('AFP')).map((n) => n.name)).toEqual(['iMac']);
    expect((await cat.children('AFP/iMac')).map((n) => n.name)).toEqual(['Macintosh HD']);
  });

  it('overlays a mounted volume catalog under the share', async () => {
    const snow = ep({
      id: 'afp://snow:LToUDP Network,ltoudp/',
      title: 'snow',
      subtitle: 'LToUDP Network',
    });
    const docs: PathVNode = {
      addr: 'path',
      path: 'Documents',
      parentPath: '',
      name: 'Documents',
      isDir: true,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: new Uint8Array(32),
      createDate: 0,
      modDate: 0,
    };
    const vol = new EmptyCatalog();
    vol.children = async () => [docs];
    vol.pathOf = async (ref) => (ref === docs.path ? 'Documents' : '');
    vol.resolvePath = async (path) => (path === 'Documents' ? docs : undefined);
    vol.get = async (ref) => (ref === docs.path ? docs : await EmptyCatalog.prototype.get.call(vol, ref));
    const cat = new NetworkCatalog({
      endpoints: () => [snow],
      schemes: () => ['afp'],
      volumes: () => ['OpenSCSI Volume'],
      volumeCatalog: () => vol,
      volumeCatalogKey: () => `${snow.id}:OpenSCSI Volume`,
    });
    const kids = await cat.children('AFP/LToUDP Network/snow/OpenSCSI Volume');
    expect(kids.map((n) => n.name)).toEqual(['Documents']);
    expect(kids[0]?.isDir).toBe(true);
    expect(kids[0]?.chrome?.catalogKey).toBe(`${snow.id}:OpenSCSI Volume`);
    expect(kids[0]?.chrome?.nativeRef).toBe('Documents');
    expect(kids[0]?.chrome?.networkRole).toBeUndefined();
    expect((kids[0] as PathVNode).path).toBe('AFP/LToUDP Network/snow/OpenSCSI Volume/Documents');
  });

  it('wraps overlay children from the parent path, not volume pathOf', async () => {
    const snow = ep({
      id: 'afp://snow:LToUDP Network,ltoudp/',
      title: 'snow',
      subtitle: 'LToUDP Network',
    });
    const docs: PathVNode = {
      addr: 'path',
      path: 'Documents',
      parentPath: '',
      name: 'Documents',
      isDir: true,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: new Uint8Array(32),
      createDate: 0,
      modDate: 0,
    };
    const vol = new EmptyCatalog();
    vol.children = async () => [docs];
    vol.pathOf = async () => '';
    vol.resolvePath = async (path) => (path === 'Documents' ? docs : undefined);
    vol.get = async (ref) => (ref === docs.path ? docs : await EmptyCatalog.prototype.get.call(vol, ref));
    const cat = new NetworkCatalog({
      endpoints: () => [snow],
      schemes: () => ['afp'],
      volumes: () => ['OpenSCSI Volume'],
      volumeCatalog: () => vol,
      volumeCatalogKey: () => `${snow.id}:OpenSCSI Volume`,
    });
    const kids = await cat.children('AFP/LToUDP Network/snow/OpenSCSI Volume');
    expect((kids[0] as PathVNode).path).toBe('AFP/LToUDP Network/snow/OpenSCSI Volume/Documents');
    expect(kids[0]?.chrome?.nativeRef).toBe('Documents');
  });

  it('proxies mkdir and remove through the mounted volume catalog', async () => {
    const snow = ep({
      id: 'afp://snow:LToUDP Network,ltoudp/',
      title: 'snow',
      subtitle: 'LToUDP Network',
    });
    const created: PathVNode = {
      addr: 'path',
      path: 'Notes',
      parentPath: '',
      name: 'Notes',
      isDir: true,
      data: new Uint8Array(),
      resource: new Uint8Array(),
      finderInfo: new Uint8Array(32),
      createDate: 0,
      modDate: 0,
    };
    const removed: unknown[] = [];
    const mkdirAt: unknown[] = [];
    const vol = new EmptyCatalog();
    vol.mkdir = async (parent, name) => {
      mkdirAt.push({ parent, name });
      return created;
    };
    vol.remove = async (ref) => {
      removed.push(ref);
    };
    vol.resolvePath = async (path) => (path === 'Notes' ? created : undefined);
    vol.get = async (ref) => (ref === created.path ? created : await EmptyCatalog.prototype.get.call(vol, ref));
    const cat = new NetworkCatalog({
      endpoints: () => [snow],
      schemes: () => ['afp'],
      volumes: () => ['OpenSCSI Volume'],
      volumeCatalog: () => vol,
      volumeCatalogKey: () => `${snow.id}:OpenSCSI Volume`,
    });
    const share = 'AFP/LToUDP Network/snow/OpenSCSI Volume';
    const node = await cat.mkdir(share, 'Notes');
    expect(mkdirAt).toEqual([{ parent: vol.rootId(), name: 'Notes' }]);
    expect((node as PathVNode).path).toBe(`${share}/Notes`);
    expect(node.chrome?.nativeRef).toBe('Notes');
    await cat.remove(`${share}/Notes`);
    expect(removed).toEqual(['Notes']);
  });
});
