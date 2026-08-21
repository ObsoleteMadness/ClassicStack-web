/** Platform-aware menu shortcut labels (⌘ on macOS, Ctrl on Windows/Linux). */

export function isMacUi(): boolean {
  if (typeof navigator === 'undefined') return true;
  const hint = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  return /Mac|iPhone|iPod|iPad/i.test(hint);
}

/** Primary modifier key label for menu shortcuts. */
export function modKeyLabel(): string {
  return isMacUi() ? '⌘' : 'Ctrl';
}

/** Build a human-readable shortcut string from symbolic parts. */
export function menuShortcut(parts: string[]): string {
  const mod = modKeyLabel();
  const mapped = parts.map((p) => {
    if (p === 'mod') return mod;
    if (p === 'shift') return isMacUi() ? '⇧' : 'Shift';
    if (p === 'alt') return isMacUi() ? '⌥' : 'Alt';
    return p;
  });
  return isMacUi() ? mapped.join('') : mapped.join('+');
}

export function shortcutHtml(parts: string[]): string {
  const text = menuShortcut(parts);
  return `<span class="app-menu__shortcut" aria-hidden="true">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`;
}
