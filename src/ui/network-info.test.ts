import { describe, expect, it } from 'vitest';
import { modelFromEndpoint, networkInfoHtml, networkObjectKindLabel } from './network-info';
import type { RemoteEndpoint } from './finder-host';

const snow: RemoteEndpoint = {
  id: 'afp://snow:LToUDP Network,ltoudp/',
  kind: 'afp',
  title: 'snow',
  neighborhood: 'LToUDP Network',
  protocol: 'afp',
  transport: 'ddp',
  uri: 'afp://snow:LToUDP Network,ltoudp',
  own: false,
};

describe('network Get Info', () => {
  it('labels a zone, server, and volume distinctly', () => {
    expect(networkObjectKindLabel({ kind: 'neighborhood', name: 'LToUDP Network', protocol: 'afp' })).toBe(
      'AppleTalk zone',
    );
    expect(networkObjectKindLabel({ kind: 'server', name: 'snow', protocol: 'afp' })).toBe('Server');
    expect(networkObjectKindLabel({ kind: 'share', name: 'OpenSCSI Volume', protocol: 'afp' })).toBe('Volume');
    expect(networkObjectKindLabel({ kind: 'share', name: 'C', protocol: 'smb' })).toBe('Share');
    expect(networkObjectKindLabel({ kind: 'service', name: 'LaserWriter', serviceKind: 'printer' })).toBe(
      'Printer',
    );
  });

  it('renders one panel for a server and for a volume', () => {
    const server = networkInfoHtml(modelFromEndpoint(snow), { variant: 'dialog' });
    expect(server).toContain('Kind');
    expect(server).toContain('Server');
    expect(server).toContain('snow');
    const vol = networkInfoHtml(modelFromEndpoint(snow, { volume: 'OpenSCSI Volume' }), {
      variant: 'dialog',
      zipShare: true,
    });
    expect(vol).toContain('Volume');
    expect(vol).toContain('OpenSCSI Volume');
    expect(vol).toContain('data-act="download"');
  });
});
