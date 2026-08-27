import { describe, expect, it } from 'vitest';
import { CapabilityCatalog } from './capability-catalog';
import {
  afpVolumeCaps,
  catalogCapsForSession,
  edfsVolumeCaps,
  smbVolumeCaps,
  showsResourceFork,
  showsTypeCreator,
} from './catalog-caps';
import { formatStorePath, sidebarGlyphSrc, volumeChrome } from './volume-chrome';

describe('CapabilityCatalog CNID vs path', () => {
  it('AFP preset is CNID-addressed with no path identity fields', async () => {
    const cat = new CapabilityCatalog(afpVolumeCaps);
    expect(cat.capabilities().addressBy).toBe('cnid');
    expect(cat.rootId()).toBe(2);

    const foo = await cat.mkdir(2, 'FOO');
    expect(foo.addr).toBe('cnid');
    if (foo.addr !== 'cnid') return;
    expect(foo.id).toBeGreaterThan(2);
    expect(foo.parentId).toBe(2);
    expect('path' in foo).toBe(false);

    const bar = await cat.createFile(foo.id, 'BAR', new Uint8Array([1]));
    expect(bar.addr).toBe('cnid');
    const resolved = await cat.resolvePath('FOO/BAR');
    expect(resolved?.addr).toBe('cnid');
    if (resolved?.addr !== 'cnid') return;
    expect(resolved.id).toBe(bar.addr === 'cnid' ? bar.id : -1);
    expect(await cat.pathOf(resolved.id)).toBe('FOO/BAR');
  });

  it('SMB preset is path-addressed with no CNID identity fields', async () => {
    const cat = new CapabilityCatalog(smbVolumeCaps);
    expect(cat.capabilities().addressBy).toBe('path');
    expect(cat.rootId()).toBe('');

    const foo = await cat.mkdir('', 'FOO');
    expect(foo.addr).toBe('path');
    if (foo.addr !== 'path') return;
    expect(foo.path).toBe('FOO');
    expect(foo.parentPath).toBe('');
    expect('id' in foo).toBe(false);

    const bar = await cat.createFile('FOO', 'BAR.TXT', new Uint8Array());
    expect(bar.addr).toBe('path');
    if (bar.addr !== 'path') return;
    expect(bar.path).toBe('FOO/BAR.TXT');
    expect(bar.parentPath).toBe('FOO');

    const resolved = await cat.resolvePath('FOO/BAR.TXT');
    expect(resolved?.addr).toBe('path');
    if (resolved?.addr !== 'path') return;
    expect(resolved.path).toBe('FOO/BAR.TXT');
    expect(await cat.pathOf('FOO/BAR.TXT')).toBe('FOO/BAR.TXT');
    await expect(cat.get(2)).resolves.toBeUndefined();
  });

  it('EtherDFS stub uses short names and DOS attrs, still path-addressed', async () => {
    const cat = new CapabilityCatalog(edfsVolumeCaps);
    expect(cat.capabilities().names).toEqual(['short']);
    expect(cat.capabilities().hideAttribute).toBe('hidden');
    expect(cat.capabilities().addressBy).toBe('path');
    const file = await cat.createFile('', 'README.TXT', new Uint8Array());
    expect(file.addr).toBe('path');
    await cat.setAttrs('README.TXT', { hidden: true, readonly: true });
    const got = await cat.get('README.TXT');
    expect(got?.attrs).toEqual({ hidden: true, readonly: true });
  });
});

describe('volume chrome', () => {
  it('is identity-driven, not shareKind for Get Info fields', () => {
    expect(volumeChrome(smbVolumeCaps).volumeIcon).toBe('windows');
    expect(volumeChrome(afpVolumeCaps).volumeIcon).toBe('appleshare');
    expect(volumeChrome(edfsVolumeCaps).volumeIcon).toBe('dos');
    expect(formatStorePath('FOO/BAR', 'dos', 'C:')).toBe('C:\\FOO\\BAR');
    expect(formatStorePath('FOO/BAR', 'mac', 'HD')).toBe('HD:FOO:BAR');
    expect(formatStorePath('FOO/BAR', 'ncp', 'SYS')).toBe('SYS:FOO/BAR');
  });

  it('local+smb still looks like a Windows share', () => {
    const chrome = volumeChrome({
      ...smbVolumeCaps,
      identity: { shareKind: 'local', protocol: 'smb' },
    });
    expect(chrome.volumeIcon).toBe('windows');
    expect(chrome.kindLabel).toMatch(/Windows/i);
  });

  it('picks Finder sidebar glyphs by protocol and role', () => {
    expect(sidebarGlyphSrc('afp', 'share')).toBe('/icons/classic/AppleShare.gif');
    expect(sidebarGlyphSrc('smb', 'share')).toBe('/icons/classic/windows-share3.png');
    expect(sidebarGlyphSrc('ncp', 'share')).toBe('/icons/classic/NovellShare.png');
    expect(sidebarGlyphSrc('etherdfs', 'share')).toBe('/icons/classic/ibmshare.png');
    expect(sidebarGlyphSrc('afp', 'server')).toBe('/icons/ui/icons8-happy-mac-50.png');
    expect(sidebarGlyphSrc('ncp', 'server')).toBe('/icons/classic/ncp-server.png');
    expect(sidebarGlyphSrc('smb', 'server')).toBe('/icons/classic/win-pc2.png');
    expect(sidebarGlyphSrc('edfs', 'server')).toBe('/icons/classic/dos1.png');
    expect(sidebarGlyphSrc('ncp', 'volume')).toBe('/icons/classic/netware-share.png');
    expect(sidebarGlyphSrc('smb', 'volume')).toBe('/icons/classic/windows-share2.png');
    expect(sidebarGlyphSrc('afp', 'volume')).toBe('/icons/icl8_-3978.png');
    expect(sidebarGlyphSrc('etherdfs', 'volume')).toBe('/icons/ui/icons8-c-drive-2-50.png');
    expect(sidebarGlyphSrc('local', 'share')).toBeUndefined();
  });
});

describe('Get Info feature flags', () => {
  it('hides type/creator and resource fork on SMB', () => {
    expect(showsTypeCreator(smbVolumeCaps, false)).toBe(false);
    expect(showsResourceFork(smbVolumeCaps)).toBe(false);
  });

  it('shows type/creator and resource fork on AFP files', () => {
    expect(showsTypeCreator(afpVolumeCaps, false)).toBe(true);
    expect(showsTypeCreator(afpVolumeCaps, true)).toBe(false);
    expect(showsResourceFork(afpVolumeCaps)).toBe(true);
  });

  it('does not default SMB sessions to AFP Mac metadata', () => {
    const caps = catalogCapsForSession({ kind: 'smb' });
    expect(showsTypeCreator(caps, false)).toBe(false);
    expect(showsResourceFork(caps)).toBe(false);
  });

  it('keeps server-declared capabilities', () => {
    const caps = catalogCapsForSession({ kind: 'smb', capabilities: afpVolumeCaps });
    expect(showsResourceFork(caps)).toBe(true);
  });
});
