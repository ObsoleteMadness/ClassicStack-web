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

  it('renders view shortcuts and sort submenu', () => {
    const html = viewMenuInnerHTML(host(), false);
    expect(html).toContain('as Icons');
    expect(html).toContain('Sort By');
    expect(html).toContain('Load icons');
    expect(html).not.toContain('AppleDouble zip');
  });
});
