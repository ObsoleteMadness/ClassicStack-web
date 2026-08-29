/** Unified Get Info body for Network Browser objects (protocol, zone, server, share, service). */

import type { RemoteEndpoint } from './finder-host';
import type { NetworkRole } from '../fs/network-tree';
import { networkGlyphSrc } from '../fs/volume-chrome';

export type NetworkInfoKind = Exclude<NetworkRole, 'root'> | 'root';

export type NetworkInfoModel = {
  kind: NetworkInfoKind;
  name: string;
  protocol?: string;
  neighborhood?: string;
  server?: string;
  iconSrc?: string;
  address?: string;
  uri?: string;
  os?: string;
  version?: string;
  transport?: string;
  volumes?: string[];
  uams?: string[];
  mountpoint?: string;
  own?: boolean;
  serviceKind?: string;
  description?: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function neighborhoodKindLabel(protocol?: string): string {
  switch ((protocol || '').toLowerCase()) {
    case 'afp':
      return 'AppleTalk zone';
    case 'smb':
      return 'Workgroup';
    case 'ncp':
      return 'IPX network';
    case 'etherdfs':
      return 'Ethernet';
    default:
      return 'Network';
  }
}

export function shareKindLabel(protocol?: string): string {
  switch ((protocol || '').toLowerCase()) {
    case 'smb':
      return 'Share';
    case 'etherdfs':
      return 'Drive';
    default:
      return 'Volume';
  }
}

export function serviceKindLabel(kind?: string): string {
  switch ((kind || '').toLowerCase()) {
    case 'printer':
      return 'Printer';
    case 'macipgw':
      return 'MacIP gateway';
    default:
      return 'Service';
  }
}

export function networkObjectKindLabel(m: NetworkInfoModel): string {
  switch (m.kind) {
    case 'root':
      return 'Network';
    case 'protocol':
      return 'Protocol';
    case 'neighborhood':
      return neighborhoodKindLabel(m.protocol);
    case 'server':
      return m.own ? 'This server' : 'Server';
    case 'share':
      return shareKindLabel(m.protocol);
    case 'service':
      return serviceKindLabel(m.serviceKind);
  }
}

function authLabel(protocol?: string): string {
  switch ((protocol || '').toLowerCase()) {
    case 'smb':
      return 'Capabilities';
    case 'ncp':
      return 'Login';
    case 'afp':
      return 'UAMs';
    default:
      return '';
  }
}

function row(label: string, value: string | undefined): string {
  const v = (value || '').trim();
  if (!v) return '';
  return `<div class="preview-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(v)}</span></div>`;
}

function uriRow(value: string | undefined): string {
  const v = (value || '').trim();
  if (!v) return '';
  return `<div class="preview-row preview-row--block"><span>URI</span><span class="preview-row__value">
    <code class="info-uri" title="Click to copy" data-act="copy-uri">${escapeHtml(v)}</code>
    <button type="button" class="btn log-panel__btn" data-act="copy-uri">Copy</button>
  </span></div>`;
}

export function modelFromEndpoint(
  ep: RemoteEndpoint,
  opts?: { volume?: string; uams?: string[]; mountpoint?: string; volumes?: string[] },
): NetworkInfoModel {
  const volume = (opts?.volume || '').trim();
  return {
    kind: volume ? 'share' : 'server',
    name: volume || ep.title,
    protocol: ep.protocol || ep.kind,
    neighborhood: ep.neighborhood || ep.subtitle,
    server: ep.title,
    iconSrc: networkGlyphSrc(volume ? 'share' : 'server', ep.protocol || ep.kind),
    address: ep.address,
    uri: volume && ep.uri ? `${ep.uri.replace(/\/+$/, '')}/${volume}` : ep.uri,
    os: ep.os,
    version: ep.version,
    transport: ep.transport,
    volumes: opts?.volumes,
    uams: opts?.uams,
    mountpoint: opts?.mountpoint,
    own: ep.own,
    description: ep.subtitle,
  };
}

/** Get Info markup for a Network Browser object (same panel as files). */
export function networkInfoHtml(
  m: NetworkInfoModel,
  opts: { variant: 'column' | 'dialog'; zipShare?: boolean },
): string {
  const proto = (m.protocol || '').toUpperCase();
  const transport = (m.transport || '').toUpperCase();
  const glyph = m.iconSrc
    ? `<img class="preview-glyph-img" src="${escapeHtml(m.iconSrc)}" alt="" width="32" height="32" draggable="false" />`
    : `<div class="preview-glyph folder"></div>`;
  const shellClass =
    opts.variant === 'column' ? 'column column-preview item-info' : 'item-info item-info--dialog';
  const auth = authLabel(m.protocol);
  const zipBtn =
    opts.zipShare && m.kind === 'share'
      ? `<button type="button" class="btn" data-act="download">Download Zip</button>`
      : '';
  const volumes =
    m.kind === 'server' && m.volumes?.length ? m.volumes.join(', ') : m.kind === 'share' ? m.name : '';
  return `<div class="${shellClass}" data-preview data-network-info="${escapeHtml(m.kind)}">
      <div class="preview-hero">
        ${glyph}
        <div class="preview-title" aria-label="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
      </div>
      <div class="preview-meta">
        ${row('Kind', networkObjectKindLabel(m))}
        ${row('Protocol', proto)}
        ${row('Transport', transport)}
        ${m.kind !== 'protocol' && m.kind !== 'neighborhood' ? row('Network', m.neighborhood) : ''}
        ${m.kind === 'share' || m.kind === 'service' ? row('Server', m.server) : ''}
        ${row('Address', m.address)}
        ${uriRow(m.uri)}
        ${row('OS', m.os)}
        ${row('SMB version', m.version)}
        ${row('Description', m.description && m.description !== m.neighborhood ? m.description : '')}
        ${m.kind === 'share' ? row(shareKindLabel(m.protocol), m.name) : row('Volumes', volumes)}
        ${auth ? row(auth, m.uams?.join(', ')) : ''}
        ${row('Mount point', m.mountpoint)}
        ${m.own ? row('Note', 'This ClassicStack instance') : ''}
        ${m.kind === 'service' ? row('Service', serviceKindLabel(m.serviceKind)) : ''}
      </div>
      ${zipBtn ? `<div class="preview-fields"><div class="preview-actions">${zipBtn}</div></div>` : ''}
    </div>`;
}
