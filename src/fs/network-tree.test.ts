import { describe, expect, it } from 'vitest';
import type { RemoteEndpoint } from '../ui/finder-host';
import {
  afpNetworkLabel,
  neighborhoodFor,
  parseNetworkPath,
  protocolFolderFor,
  protocolFromFolder,
  serverNetworkPath,
} from './network-tree';

function ep(partial: Partial<RemoteEndpoint> & Pick<RemoteEndpoint, 'id' | 'title'>): RemoteEndpoint {
  return { kind: 'afp', ...partial };
}

describe('protocol folders', () => {
  it('maps schemes to Browse Network folder names', () => {
    expect(protocolFolderFor('afp')).toBe('AFP');
    expect(protocolFolderFor('ncp')).toBe('NetWare');
    expect(protocolFromFolder('NetWare')).toBe('ncp');
    expect(protocolFolderFor('local')).toBeUndefined();
  });
});

describe('neighborhoodFor', () => {
  it('uses an AppleTalk zone when NBP named one', () => {
    expect(neighborhoodFor(ep({ id: 'afp://snow:LToUDP Network,ltoudp/', title: 'snow', subtitle: 'LToUDP Network' }))).toBe(
      'LToUDP Network',
    );
  });

  it('falls back to the DDP link when the zone is unnamed', () => {
    expect(neighborhoodFor(ep({ id: 'afp://snow,ltoudp/', title: 'snow', subtitle: '*', transport: 'ddp' }))).toBe(
      'LToUDP Network',
    );
    expect(neighborhoodFor(ep({ id: 'Mac', title: 'Mac', transport: 'nbp' }))).toBe('AppleTalk');
    expect(afpNetworkLabel('tashtalk')).toBe('TashTalk Network');
  });

  it('groups TCP AFP, SMB, NCP, and EtherDFS under transport neighborhoods', () => {
    expect(neighborhoodFor(ep({ id: 'afp://1.2.3.4,tcp/', title: 'Files', kind: 'afp', transport: 'tcp' }))).toBe('TCP');
    expect(neighborhoodFor(ep({ id: 'smb://FOO,nbf/', title: 'FOO', kind: 'smb' }))).toBe('Workgroup');
    expect(neighborhoodFor(ep({ id: 'ncp://FS/SYS', title: 'FS', kind: 'ncp' }))).toBe('IPX Network');
    expect(neighborhoodFor(ep({ id: 'etherdfs://aa:bb/C', title: 'PC', kind: 'etherdfs' }))).toBe('Ethernet');
  });

  it('keeps an explicit neighborhood from the host', () => {
    expect(
      neighborhoodFor(ep({ id: 'smb://FOO,nbf/', title: 'FOO', kind: 'smb', neighborhood: 'ENGINEERING' })),
    ).toBe('ENGINEERING');
  });
});

describe('parseNetworkPath / serverNetworkPath', () => {
  it('parses Browse Network → AFP → zone → server → share', () => {
    expect(parseNetworkPath('')).toEqual({ role: 'root' });
    expect(parseNetworkPath('AFP')).toEqual({ role: 'protocol', protocol: 'afp' });
    expect(parseNetworkPath('AFP/LToUDP Network')).toEqual({
      role: 'neighborhood',
      protocol: 'afp',
      neighborhood: 'LToUDP Network',
    });
    expect(parseNetworkPath('AFP/LToUDP Network/snow')).toEqual({
      role: 'server',
      protocol: 'afp',
      neighborhood: 'LToUDP Network',
      server: 'snow',
    });
    expect(parseNetworkPath('AFP/LToUDP Network/snow/OpenSCSI Volume')).toEqual({
      role: 'share',
      protocol: 'afp',
      neighborhood: 'LToUDP Network',
      server: 'snow',
      share: 'OpenSCSI Volume',
    });
  });

  it('builds a server path from an endpoint', () => {
    expect(
      serverNetworkPath(
        ep({ id: 'afp://snow:LToUDP Network,ltoudp/', title: 'snow', subtitle: 'LToUDP Network' }),
      ),
    ).toBe('AFP/LToUDP Network/snow');
  });

  it('splits share vs folder path and flattens NCP / EtherTalk', () => {
    expect(parseNetworkPath('AFP/LToUDP Network/snow/OpenSCSI Volume/Documents')).toEqual({
      role: 'share',
      protocol: 'afp',
      neighborhood: 'LToUDP Network',
      server: 'snow',
      share: 'OpenSCSI Volume',
      volumePath: 'Documents',
    });
    expect(parseNetworkPath('NetWare/FS/SYS')).toEqual({
      role: 'share',
      protocol: 'ncp',
      server: 'FS',
      share: 'SYS',
    });
    expect(serverNetworkPath(ep({ id: 'ncp://FS/SYS', title: 'FS', kind: 'ncp' }))).toBe('NetWare/FS');
    const ether = ep({
      id: 'afp://iMac,ethertalk/',
      title: 'iMac',
      transport: 'ethertalk',
      subtitle: '*',
    });
    expect(serverNetworkPath(ether)).toBe('AFP/iMac');
    expect(parseNetworkPath('AFP/iMac/Macintosh HD', [ether])).toEqual({
      role: 'share',
      protocol: 'afp',
      server: 'iMac',
      share: 'Macintosh HD',
    });
  });
});
