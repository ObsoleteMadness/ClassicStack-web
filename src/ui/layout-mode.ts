/** Compact (phone) layout vs desktop Finder chrome. */

export const COMPACT_QUERY = '(max-width: 720px)';
export const COARSE_QUERY = '(pointer: coarse)';

const CLASS = 'compact-ui';
const listeners = new Set<() => void>();

export function isCompactUi(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches;
}

export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(COARSE_QUERY).matches;
}

function apply(): void {
  document.documentElement.classList.toggle(CLASS, isCompactUi());
  for (const fn of listeners) fn();
}

/** Run `fn` whenever compact layout turns on or off. */
export function onLayoutModeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Keep `html.compact-ui` in sync with the viewport. Returns an unsubscribe. */
export function startLayoutMode(): () => void {
  apply();
  const mq = window.matchMedia(COMPACT_QUERY);
  const onChange = (): void => apply();
  mq.addEventListener('change', onChange);
  return () => {
    mq.removeEventListener('change', onChange);
    listeners.clear();
  };
}
