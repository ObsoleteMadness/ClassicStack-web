/** Persisted Finder / floating-window geometry (localStorage). */

export const WINDOWS_STORAGE_KEY = 'classicstack.windows';

export type WindowId = 'finder' | 'log' | 'activity' | 'resource' | 'info';

export interface WindowFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  maximized?: boolean;
  open?: boolean;
  /** True after the user drags the resize handle; skip auto-fit to contents. */
  userSized?: boolean;
}

export type WindowLayouts = Partial<Record<WindowId, WindowFrame>>;

const PAD = 8;

export function parseWindowLayouts(raw: unknown): WindowLayouts {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: WindowLayouts = {};
  for (const id of ['finder', 'log', 'activity', 'resource', 'info'] as const) {
    const frame = parseFrame(src[id]);
    if (frame) out[id] = frame;
  }
  return out;
}

export function parseFrame(raw: unknown): WindowFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (![o.left, o.top, o.width, o.height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  return {
    left: o.left as number,
    top: o.top as number,
    width: o.width as number,
    height: o.height as number,
    maximized: o.maximized === true,
    open: o.open === true,
    userSized: o.userSized === true,
  };
}

export function clampFrame(
  frame: WindowFrame,
  bounds: { width: number; height: number },
  minWidth = 280,
  minHeight = 160,
): WindowFrame {
  const width = Math.min(Math.max(Math.round(frame.width), minWidth), Math.max(minWidth, bounds.width));
  const height = Math.min(Math.max(Math.round(frame.height), minHeight), Math.max(minHeight, bounds.height));
  const maxLeft = Math.max(PAD, bounds.width - 40);
  const maxTop = Math.max(PAD, bounds.height - 40);
  return {
    ...frame,
    width,
    height,
    left: Math.max(PAD, Math.min(maxLeft, Math.round(frame.left))),
    top: Math.max(PAD, Math.min(maxTop, Math.round(frame.top))),
  };
}

export function loadWindowLayouts(): WindowLayouts {
  try {
    const raw = localStorage.getItem(WINDOWS_STORAGE_KEY);
    if (!raw) return {};
    return parseWindowLayouts(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function saveWindowLayout(id: WindowId, patch: Partial<WindowFrame>): WindowLayouts {
  const all = loadWindowLayouts();
  const prev = all[id];
  const next: WindowFrame = {
    left: patch.left ?? prev?.left ?? 24,
    top: patch.top ?? prev?.top ?? 56,
    width: patch.width ?? prev?.width ?? 480,
    height: patch.height ?? prev?.height ?? 360,
    maximized: patch.maximized ?? prev?.maximized ?? false,
    open: patch.open ?? prev?.open ?? false,
    userSized: patch.userSized ?? prev?.userSized ?? false,
  };
  all[id] = next;
  persistAll(all);
  return all;
}

export function clearWindowLayouts(): void {
  try {
    localStorage.removeItem(WINDOWS_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

export function replaceWindowLayouts(all: WindowLayouts): void {
  persistAll(parseWindowLayouts(all));
}

export function captureWindowFrame(el: HTMLElement): WindowFrame {
  const r = el.getBoundingClientRect();
  return {
    left: Math.round(r.left),
    top: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
    maximized: el.classList.contains('is-maximized'),
    open: !el.hidden,
    userSized: el.dataset.userSized === '1',
  };
}

export function applyWindowFrame(el: HTMLElement, frame: WindowFrame): void {
  const clamped = clampFrame(frame, { width: window.innerWidth, height: window.innerHeight });
  el.style.left = `${clamped.left}px`;
  el.style.top = `${clamped.top}px`;
  el.style.width = `${clamped.width}px`;
  el.style.height = `${clamped.height}px`;
  el.classList.toggle('is-maximized', clamped.maximized === true);
  if (frame.userSized) el.dataset.userSized = '1';
  else delete el.dataset.userSized;
}

/**
 * Grow a floating window to its content (capped to the viewport).
 * No-op after the user resizes, or while the window is hidden / maximized.
 */
export function fitWindowToContents(
  el: HTMLElement,
  opts: { panel?: string; minHeight?: number } = {},
): void {
  if (el.hidden || el.classList.contains('is-maximized') || el.dataset.userSized === '1') return;
  const panel = (opts.panel ? el.querySelector(opts.panel) : null) as HTMLElement | null;
  const prev = panel
    ? { flex: panel.style.flex, minHeight: panel.style.minHeight, overflow: panel.style.overflow }
    : null;
  if (panel) {
    panel.style.flex = 'none';
    panel.style.minHeight = 'auto';
    panel.style.overflow = 'visible';
  }
  el.style.height = 'auto';
  const minH = opts.minHeight ?? 160;
  const neededH = Math.max(minH, Math.ceil(el.scrollHeight));
  if (panel && prev) {
    panel.style.flex = prev.flex;
    panel.style.minHeight = prev.minHeight;
    panel.style.overflow = prev.overflow;
  }
  const maxH = Math.max(minH, window.innerHeight - 16);
  const height = Math.min(neededH, maxH);
  el.style.height = `${height}px`;
  const r = el.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8) {
    el.style.top = `${Math.max(8, window.innerHeight - height - 8)}px`;
  }
}

export function persistWindow(id: WindowId, el: HTMLElement): void {
  const prev = loadWindowLayouts()[id];
  if (el.classList.contains('is-maximized')) {
    saveWindowLayout(id, {
      left: prev?.left,
      top: prev?.top,
      width: prev?.width,
      height: prev?.height,
      maximized: true,
      open: !el.hidden,
    });
    return;
  }
  saveWindowLayout(id, captureWindowFrame(el));
}

export function restoreWindow(
  id: WindowId,
  el: HTMLElement,
  fallback: () => WindowFrame,
): WindowFrame {
  const saved = loadWindowLayouts()[id];
  const frame = saved ?? fallback();
  applyWindowFrame(el, frame);
  return frame;
}

export function defaultFinderFrame(): WindowFrame {
  const stage = document.querySelector('.app-stage')?.getBoundingClientRect();
  const left0 = stage?.left ?? 24;
  const top0 = stage?.top ?? 40;
  const availW = stage?.width ?? Math.max(320, window.innerWidth - 48);
  const availH = stage?.height ?? Math.max(240, window.innerHeight - 64);
  const width = Math.min(1100, availW);
  const height = Math.min(720, availH);
  return {
    left: left0 + Math.max(0, (availW - width) / 2),
    top: top0 + Math.max(0, (availH - height) / 2),
    width,
    height,
    maximized: false,
    open: true,
  };
}

export function defaultLogFrame(): WindowFrame {
  return { left: 24, top: 56, width: 520, height: 360, open: false };
}

export function defaultActivityFrame(): WindowFrame {
  return { left: 56, top: 72, width: 480, height: 460, open: false };
}

export function defaultInfoFrame(): WindowFrame {
  const width = Math.min(320, window.innerWidth - 32);
  const height = Math.min(560, window.innerHeight - 32);
  return {
    left: Math.max(16, window.innerWidth - width - 16),
    top: 56,
    width,
    height,
    open: false,
  };
}

export function defaultResourceFrame(): WindowFrame {
  const pad = 16;
  const width = Math.min(640, window.innerWidth - pad * 2);
  const height = Math.min(480, window.innerHeight - pad * 2);
  return {
    left: Math.max(pad, window.innerWidth - width - pad),
    top: Math.max(pad, window.innerHeight - height - pad),
    width,
    height,
    open: false,
  };
}

function persistAll(all: WindowLayouts): void {
  try {
    localStorage.setItem(WINDOWS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode */
  }
}
