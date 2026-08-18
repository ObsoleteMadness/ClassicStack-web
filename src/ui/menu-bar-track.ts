/** OS-style menu bar tracking: click to open, hover to switch, click outside / Escape to dismiss. */

/** Dispatched on the tracking root when the open menu key changes. */
export const MENUBAR_CHANGE = 'cs-menubar-change';

const MENU_SEL = '[data-menu]';
const TRIGGER_SEL = '.app-menu__trigger';

/** Currently open menu key (`data-menu`), or null if all menus are closed. */
export function menubarOpenKey(root: HTMLElement): string | null {
  return root.dataset.openMenu || null;
}

/**
 * Update the open menu. Returns true when the key changed (and `MENUBAR_CHANGE` fired).
 */
export function setMenubarOpen(root: HTMLElement, key: string | null): boolean {
  const prev = menubarOpenKey(root);
  const next = key || null;
  if (prev === next) return false;
  if (next) root.dataset.openMenu = next;
  else delete root.dataset.openMenu;
  root.dispatchEvent(new Event(MENUBAR_CHANGE));
  return true;
}

function closestFrom(target: EventTarget | null, selector: string): Element | null {
  if (target instanceof Element) return target.closest(selector);
  if (target instanceof Text) return target.parentElement?.closest(selector) ?? null;
  return null;
}

function menuKeyOf(target: EventTarget | null, root: HTMLElement): string | null {
  const menu = closestFrom(target, MENU_SEL);
  if (!menu || !root.contains(menu)) return null;
  return menu.getAttribute('data-menu');
}

function menuKeys(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(MENU_SEL)]
    .map((el) => el.getAttribute('data-menu'))
    .filter((k): k is string => !!k);
}

function adjacentKey(root: HTMLElement, current: string, dir: -1 | 1): string | null {
  const keys = menuKeys(root);
  const i = keys.indexOf(current);
  if (i < 0 || keys.length === 0) return current;
  return keys[(i + dir + keys.length) % keys.length] ?? current;
}

/**
 * Bind click / hover / keyboard tracking on a stable root that contains `[data-menu]`
 * items (each with an `.app-menu__trigger`). The root must not be replaced by innerHTML.
 *
 * While a menu is open, moving the pointer onto another title switches to that menu —
 * the same tracking mode as macOS / Windows menu bars.
 */
export function bindMenuBarTracking(root: HTMLElement): () => void {
  const onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    if (!menubarOpenKey(root)) return;
    if (closestFrom(e.target, '.app-menu__dropdown')) return;
    const key = menuKeyOf(e.target, root);
    if (key) setMenubarOpen(root, key);
  };

  const onClick = (e: MouseEvent): void => {
    if (!closestFrom(e.target, TRIGGER_SEL)) return;
    const key = menuKeyOf(e.target, root);
    if (!key) return;
    e.stopPropagation();
    const open = menubarOpenKey(root);
    if (open && open !== key) setMenubarOpen(root, key);
    else setMenubarOpen(root, open === key ? null : key);
  };

  const onWindowClick = (e: MouseEvent): void => {
    if (!menubarOpenKey(root)) return;
    const menu = closestFrom(e.target, MENU_SEL);
    if (menu && root.contains(menu)) return;
    setMenubarOpen(root, null);
  };

  const onKey = (e: KeyboardEvent): void => {
    const open = menubarOpenKey(root);
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      setMenubarOpen(root, null);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = adjacentKey(root, open, e.key === 'ArrowRight' ? 1 : -1);
      if (next) setMenubarOpen(root, next);
    }
  };

  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('click', onClick);
  window.addEventListener('click', onWindowClick);
  window.addEventListener('keydown', onKey);

  return () => {
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('click', onClick);
    window.removeEventListener('click', onWindowClick);
    window.removeEventListener('keydown', onKey);
  };
}
