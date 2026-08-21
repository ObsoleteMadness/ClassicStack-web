import { describe, expect, it, vi } from 'vitest';
import { AfpFinderHost, type AfpFinderUi } from './afp-finder-host';
import type { AfpClient } from '../services/afp-client/client';
import type { AtpClient } from '../services/atp-client';
import type { VirtualFS } from '../fs/virtual-fs';
import type { RemoteEndpoint } from '../ui/finder-host';

const ep: RemoteEndpoint = { id: 'Mac Classic', kind: 'afp', title: 'Mac Classic' };

function fakeClient(over?: Partial<AfpClient>): AfpClient {
  return {
    loggedIn: true,
    serverName: 'Mac Classic',
    uams: ['Cleartxt passwrd', 'Randnum exchange'],
    volumes: [{ flags: 0, name: 'OpenRetroSCSI 7.5.3' }],
    close: vi.fn(async () => undefined),
    ...over,
  } as unknown as AfpClient;
}

function host(): AfpFinderHost {
  const ui = {
    finder: {
      setStatus: vi.fn(),
      setServers: vi.fn(),
      setNetworkScanning: vi.fn(),
      unmountRemote: vi.fn(),
    },
    login: {} as AfpFinderUi['login'],
    alert: {} as AfpFinderUi['alert'],
    nameConflict: {} as AfpFinderUi['nameConflict'],
  } satisfies AfpFinderUi;
  const h = new AfpFinderHost({} as never, {} as VirtualFS, ui);
  h.atp = {} as AtpClient;
  return h;
}

describe('AfpFinderHost.beginRemote', () => {
  it('reuses a live authenticated session instead of logging it out', async () => {
    const h = host();
    const client = fakeClient();
    h.remote = client;
    h.remoteNbpName = 'Mac Classic';
    const lookup = vi.fn(async () => []);
    h.nbp = { lookup } as never;

    const info = await h.beginRemote(ep);

    expect(client.close).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(h.remote).toBe(client);
    expect(info.serverName).toBe('Mac Classic');
    expect(info.volumes).toEqual(['OpenRetroSCSI 7.5.3']);
    expect(info.uams).toEqual(['Cleartxt passwrd', 'Randnum exchange']);
  });

  it('matches the open session by endpoint title as well as id', async () => {
    const h = host();
    h.remote = fakeClient();
    h.remoteNbpName = 'Mac Classic';
    const lookup = vi.fn(async () => []);
    h.nbp = { lookup } as never;

    await h.beginRemote({ id: '0.2:252', kind: 'afp', title: 'mac classic' });

    expect(lookup).not.toHaveBeenCalled();
  });

  it('reconnects when the session was never authenticated', async () => {
    const h = host();
    const client = fakeClient({ loggedIn: false });
    h.remote = client;
    h.remoteNbpName = 'Mac Classic';
    h.nbp = { lookup: vi.fn(async () => []) } as never;

    await expect(h.beginRemote(ep)).rejects.toThrow(/is not on the network/);
  });

  it('reconnects when the endpoint is a different server', async () => {
    const h = host();
    const client = fakeClient();
    h.remote = client;
    h.remoteNbpName = 'Mac Classic';
    h.nbp = { lookup: vi.fn(async () => []) } as never;

    await expect(
      h.beginRemote({ id: 'Other Mac', kind: 'afp', title: 'Other Mac' }),
    ).rejects.toThrow(/is not on the network/);
  });
});
