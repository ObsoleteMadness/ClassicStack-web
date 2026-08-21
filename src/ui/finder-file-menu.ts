/** Finder File menu: new folder, preview, zip download, info, rename, delete, close share. */

import type { FinderWindow } from './finder-window';
import { shortcutHtml } from './menu-shortcut';

export const FILE_MENU_KEY = 'file';

export interface FileMenuHost {
  finder: FinderWindow;
}

const TOGGLE_ACTS = new Set(['toggle', 'toggle-file']);

export function isFileMenuToggle(act: string | undefined): boolean {
  return !!act && TOGGLE_ACTS.has(act);
}

function menuItem(opts: {
  act: string;
  label: string;
  disabled?: boolean;
  shortcut?: string[];
  checked?: boolean;
  radio?: boolean;
}): string {
  const role = opts.radio ? 'menuitemradio' : 'menuitem';
  const check =
    opts.checked != null
      ? `<span class="app-menu__check">${opts.checked ? '✓' : ''}</span>`
      : `<span class="app-menu__check"></span>`;
  const shortcut = opts.shortcut ? shortcutHtml(opts.shortcut) : '';
  return `<button type="button" role="${role}"${opts.checked != null ? ` aria-checked="${opts.checked}"` : ''} data-act="${opts.act}" class="app-menu__item"${opts.disabled ? ' disabled' : ''}>
          ${check}<span class="app-menu__label">${opts.label}</span>${shortcut}
        </button>`;
}

/** Trigger + dropdown markup for the File menu. */
export function fileMenuInnerHTML(host: FileMenuHost, open: boolean): string {
  const finder = host.finder;
  const previewOk = finder.selectionSupportsPreview();
  const closeShare = finder.canCloseMountedShare();
  return `
      <button type="button" class="app-menu__trigger" data-act="toggle-file" aria-haspopup="true" aria-expanded="${open}">
        File
      </button>
      <div class="app-menu__dropdown" role="menu" ${open ? '' : 'hidden'}>
        ${menuItem({ act: 'new-folder', label: 'New Folder', shortcut: ['mod', 'shift', 'N'] })}
        ${menuItem({ act: 'open-preview', label: 'Open Preview', disabled: !previewOk, shortcut: ['Space'] })}
        ${menuItem({ act: 'download-zip', label: 'Download Zip' })}
        <hr />
        ${menuItem({ act: 'get-info', label: 'Get Info', shortcut: ['mod', 'I'] })}
        ${menuItem({ act: 'rename', label: 'Rename', shortcut: ['Enter'] })}
        ${menuItem({ act: 'delete', label: 'Delete', shortcut: ['mod', 'Backspace'] })}
        ${closeShare ? `<hr />${menuItem({ act: 'close-share', label: 'Close Share' })}` : ''}
      </div>
    `;
}

/**
 * Apply a File menu item. Returns true when `act` was handled (not the title toggle).
 */
export async function applyFileMenuAction(act: string | undefined, host: FileMenuHost): Promise<boolean> {
  if (!act || isFileMenuToggle(act)) return false;
  const finder = host.finder;
  switch (act) {
    case 'new-folder':
      await finder.menuNewFolder();
      return true;
    case 'open-preview':
      if (!finder.selectionSupportsPreview()) return true;
      await finder.menuOpenPreview();
      return true;
    case 'download-zip':
      await finder.menuDownloadZip();
      return true;
    case 'get-info':
      finder.menuGetInfo();
      return true;
    case 'rename':
      finder.menuRename();
      return true;
    case 'delete':
      await finder.menuDelete();
      return true;
    case 'close-share':
      await finder.menuCloseShare();
      return true;
    default:
      return false;
  }
}
