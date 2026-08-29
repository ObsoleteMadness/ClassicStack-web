/** Finder View menu: layout, sort, hidden files, load icons. */

import type { FinderWindow } from './finder-window';
import type { SortKey, ViewMode } from './finder-window';
import { shortcutHtml } from './menu-shortcut';

export const VIEW_MENU_KEY = 'view';

export interface ViewMenuHost {
  finder: FinderWindow;
}

const TOGGLE_ACTS = new Set(['toggle', 'toggle-view']);

/** True when `act` is the View title (tracking / the host toggles the dropdown). */
export function isViewMenuToggle(act: string | undefined): boolean {
  return !!act && TOGGLE_ACTS.has(act);
}

function viewItem(view: ViewMode, current: ViewMode, label: string, digit: string): string {
  const checked = current === view;
  return `<button type="button" role="menuitemradio" aria-checked="${checked}" data-act="view-${view}" class="app-menu__item">
          <span class="app-menu__check">${checked ? '✓' : ''}</span>
          <span class="app-menu__label">${label}</span>
          ${shortcutHtml(['mod', digit])}
        </button>`;
}

function sortItem(key: SortKey, current: SortKey, label: string): string {
  const checked = current === key;
  return `<button type="button" role="menuitemradio" aria-checked="${checked}" data-act="sort-${key}" class="app-menu__item">
          <span class="app-menu__check">${checked ? '✓' : ''}</span>
          <span class="app-menu__label">${label}</span>
        </button>`;
}

/** Trigger + dropdown markup for the View menu. */
export function viewMenuInnerHTML(host: ViewMenuHost, open: boolean): string {
  const finder = host.finder;
  const hidden = finder.getShowHiddenFiles();
  const icons = finder.getReadFinderIcons();
  const view = finder.getView();
  const sort = finder.getSortKey();
  return `
      <button type="button" class="app-menu__trigger" data-act="toggle-view" aria-haspopup="true" aria-expanded="${open}">
        View
      </button>
      <div class="app-menu__dropdown" role="menu" ${open ? '' : 'hidden'}>
        ${viewItem('icon', view, 'as Icons', '1')}
        ${viewItem('list', view, 'as List', '2')}
        ${viewItem('column', view, 'as Columns', '3')}
        <hr />
        <div class="app-menu__submenu-trigger" role="none">
          <button type="button" role="menuitem" class="app-menu__item app-menu__submenu-btn" aria-haspopup="true" tabindex="-1">
            <span class="app-menu__check"></span>
            <span class="app-menu__label">Sort By</span>
            <span class="app-menu__submenu-arrow" aria-hidden="true">▸</span>
          </button>
          <div class="app-menu__submenu" role="menu">
            ${sortItem('name', sort, 'Name')}
            ${sortItem('modified', sort, 'Date Modified')}
            ${sortItem('size', sort, 'Size')}
          </div>
        </div>
        <hr />
        <button type="button" role="menuitemcheckbox" aria-checked="${hidden}" data-act="toggle-show-hidden" class="app-menu__item">
          <span class="app-menu__check">${hidden ? '✓' : ''}</span>
          <span class="app-menu__label">Show hidden files</span>
        </button>
        <button type="button" role="menuitemcheckbox" aria-checked="${icons}" data-act="toggle-read-finder-icons" class="app-menu__item">
          <span class="app-menu__check">${icons ? '✓' : ''}</span>
          <span class="app-menu__label">Load icons</span>
        </button>
        <hr />
        <button type="button" role="menuitemcheckbox" aria-checked="${finder.isNetworkBrowserOpen()}" data-act="network-browser" class="app-menu__item"${finder.networkBrowserEnabled() ? '' : ' disabled'}>
          <span class="app-menu__check">${finder.isNetworkBrowserOpen() ? '✓' : ''}</span>
          <span class="app-menu__label">Network Browser</span>
        </button>
      </div>
    `;
}

/**
 * Apply a View menu item. Returns true when `act` was handled (not the title toggle).
 */
export async function applyViewMenuAction(act: string | undefined, host: ViewMenuHost): Promise<boolean> {
  if (!act || isViewMenuToggle(act)) return false;
  const finder = host.finder;
  if (act === 'toggle-show-hidden') {
    finder.setShowHiddenFiles(!finder.getShowHiddenFiles());
    return true;
  }
  if (act === 'toggle-read-finder-icons') {
    finder.setReadFinderIcons(!finder.getReadFinderIcons());
    return true;
  }
  if (act === 'view-icon') {
    await finder.applyViewMode('icon');
    return true;
  }
  if (act === 'view-list') {
    await finder.applyViewMode('list');
    return true;
  }
  if (act === 'view-column') {
    await finder.applyViewMode('column');
    return true;
  }
  if (act === 'sort-name') {
    await finder.applySortKey('name');
    return true;
  }
  if (act === 'sort-modified') {
    await finder.applySortKey('modified');
    return true;
  }
  if (act === 'sort-size') {
    await finder.applySortKey('size');
    return true;
  }
  if (act === 'network-browser') {
    if (!finder.networkBrowserEnabled()) return true;
    await finder.openNetworkBrowser();
    return true;
  }
  return false;
}
