import { describe, expect, it, vi } from 'vitest';
import { applyFileMenuAction, fileMenuInnerHTML } from './finder-file-menu';

function host() {
  return {
    finder: {
      selectionSupportsPreview: () => true,
      canCloseMountedShare: () => false,
      menuNewFolder: vi.fn(),
      menuOpenPreview: vi.fn(),
      menuDownloadZip: vi.fn(),
      menuGetInfo: vi.fn(),
      menuRename: vi.fn(),
      menuDelete: vi.fn(),
      menuCloseShare: vi.fn(),
    },
  } as const;
}

describe('File menu', () => {
  it('creates a new folder', async () => {
    const h = host();
    expect(await applyFileMenuAction('new-folder', h)).toBe(true);
    expect(h.finder.menuNewFolder).toHaveBeenCalled();
  });

  it('disables preview when unsupported', () => {
    const html = fileMenuInnerHTML({ finder: { ...host().finder, selectionSupportsPreview: () => false } as never }, false);
    expect(html).toContain('Open Preview');
    expect(html).toContain('disabled');
  });

  it('shows close share for mounted volumes', () => {
    const html = fileMenuInnerHTML({ finder: { ...host().finder, canCloseMountedShare: () => true } as never }, false);
    expect(html).toContain('Close Share');
  });
});
