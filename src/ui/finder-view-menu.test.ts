import { describe, expect, it, vi } from 'vitest';
import { applyViewMenuAction, isViewMenuToggle, viewMenuInnerHTML } from './finder-view-menu';
import type { ViewMenuHost } from './finder-view-menu';

function host(overrides: Partial<ViewMenuHost['finder']> = {}): ViewMenuHost {
  const finder = {
    getShowHiddenFiles: () => false,
    setShowHiddenFiles: vi.fn(),
    getReadFinderIcons: () => true,
    setReadFinderIcons: vi.fn(),
    getView: () => 'icon' as const,
    getSortKey: () => 'name' as const,
    applyViewMode: vi.fn(),
    applySortKey: vi.fn(),
    networkBrowserEnabled: () => true,
    isNetworkBrowserOpen: () => false,
    openNetworkBrowser: vi.fn(),
    ...overrides,
  };
  return { finder: finder as ViewMenuHost['finder'] };
}

describe('View menu actions', () => {
  it('ignores title toggles', () => {
    expect(isViewMenuToggle('toggle-view')).toBe(true);
    expect(isViewMenuToggle('toggle')).toBe(true);
    expect(applyViewMenuAction('toggle-view', host())).resolves.toBe(false);
  });

  it('toggles hidden files', async () => {
    const h = host();
    expect(await applyViewMenuAction('toggle-show-hidden', h)).toBe(true);
    expect(h.finder.setShowHiddenFiles).toHaveBeenCalledWith(true);
  });

  it('switches view modes', async () => {
    const h = host();
    expect(await applyViewMenuAction('view-list', h)).toBe(true);
    expect(h.finder.applyViewMode).toHaveBeenCalledWith('list');
  });

  it('applies sort keys', async () => {
    const h = host();
    expect(await applyViewMenuAction('sort-modified', h)).toBe(true);
    expect(h.finder.applySortKey).toHaveBeenCalledWith('modified');
  });

  it('opens Network Browser when the client is enabled', async () => {
    const h = host();
    expect(await applyViewMenuAction('network-browser', h)).toBe(true);
    expect(h.finder.openNetworkBrowser).toHaveBeenCalled();
  });

  it('checks Network Browser only while that catalog is open', () => {
    const html = viewMenuInnerHTML(host({ isNetworkBrowserOpen: () => true }), false);
    expect(html).toMatch(/role="menuitemcheckbox" aria-checked="true" data-act="network-browser"/);
    expect(html).toContain('✓');
  });

  it('disables Network Browser when the client is off', () => {
    const html = viewMenuInnerHTML(host({ networkBrowserEnabled: () => false }), false);
    expect(html).toContain('data-act="network-browser"');
    expect(html).toMatch(/data-act="network-browser"[^>]*disabled/);
  });

  it('renders view shortcuts and sort submenu', () => {
    const html = viewMenuInnerHTML(host(), false);
    expect(html).toContain('as Icons');
    expect(html).toContain('Sort By');
    expect(html).toContain('Load icons');
    expect(html).toContain('Network Browser');
    expect(html).not.toContain('AppleDouble zip');
  });
});
