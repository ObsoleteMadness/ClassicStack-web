/** Bottom-right resize grip and title-bar move for Finder and floating windows. */

interface ResizeOpts {
  minWidth?: number;
  minHeight?: number;
}

const resizeBound = new WeakSet<HTMLElement>();
const moveBound = new WeakSet<HTMLElement>();
const optsMap = new WeakMap<HTMLElement, { minWidth: number; minHeight: number }>();

type ResizeDrag = { el: HTMLElement; w: number; h: number; x: number; y: number };
type MoveDrag = { el: HTMLElement; left: number; top: number; x: number; y: number };
let resize: ResizeDrag | null = null;
let move: MoveDrag | null = null;
let listening = false;
let floatZ = 60;
const FLOAT_Z_MAX = 69;
const geometryListeners = new WeakMap<HTMLElement, () => void>();

/** Bring a floating window above siblings. Finder uses `raise: false` and stays at z-index 20. */
export function raiseFloatingWindow(el: HTMLElement): void {
  floatZ = Math.min(floatZ + 1, FLOAT_Z_MAX);
  el.style.zIndex = String(floatZ);
}

function ensureHandle(el: HTMLElement): void {
  if (el.querySelector(':scope > .window-resize-handle')) return;
  const handle = document.createElement('div');
  handle.className = 'window-resize-handle';
  handle.title = 'Resize';
  handle.setAttribute('aria-hidden', 'true');
  el.appendChild(handle);
}

function onPointerMove(e: PointerEvent): void {
  if (resize) {
    e.preventDefault();
    const { minWidth, minHeight } = optsMap.get(resize.el) ?? { minWidth: 280, minHeight: 160 };
    const w = Math.max(minWidth, resize.w + (e.clientX - resize.x));
    const h = Math.max(minHeight, resize.h + (e.clientY - resize.y));
    resize.el.style.width = `${Math.round(w)}px`;
    resize.el.style.height = `${Math.round(h)}px`;
    return;
  }
  if (!move) return;
  e.preventDefault();
  const pad = 8;
  const left = Math.max(pad, Math.min(window.innerWidth - 40, move.left + (e.clientX - move.x)));
  const top = Math.max(pad, Math.min(window.innerHeight - 40, move.top + (e.clientY - move.y)));
  move.el.style.left = `${Math.round(left)}px`;
  move.el.style.top = `${Math.round(top)}px`;
}

function isLocked(el: HTMLElement): boolean {
  return el.classList.contains('is-maximized');
}

function notifyGeometry(el: HTMLElement): void {
  geometryListeners.get(el)?.();
}

function onPointerUp(): void {
  const el = resize?.el ?? move?.el ?? null;
  resize = null;
  if (move) {
    move.el.classList.remove('is-dragging');
    move = null;
  }
  if (el) notifyGeometry(el);
}

function ensureListeners(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

export function enableWindowResize(el: HTMLElement, opts: ResizeOpts = {}): void {
  optsMap.set(el, {
    minWidth: opts.minWidth ?? 280,
    minHeight: opts.minHeight ?? 160,
  });
  ensureHandle(el);
  ensureListeners();
  if (resizeBound.has(el)) return;
  resizeBound.add(el);
  el.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.window-resize-handle')) return;
    if (isLocked(el)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    el.dataset.userSized = '1';
    resize = { el, w: r.width, h: r.height, x: e.clientX, y: e.clientY };
    t.setPointerCapture?.(e.pointerId);
  });
}

/** Persist size/position after a drag or resize finishes. */
export function onWindowGeometryChange(el: HTMLElement, fn: () => void): void {
  geometryListeners.set(el, fn);
}

/** Drag a floating window by its title chrome (ignores buttons and fields). */
export function enableWindowMove(
  el: HTMLElement,
  chromeSelector: string,
  opts: { raise?: boolean } = {},
): void {
  ensureListeners();
  if (moveBound.has(el)) return;
  moveBound.add(el);
  const raise = opts.raise !== false;
  el.addEventListener('pointerdown', (e) => {
    if (raise) raiseFloatingWindow(el);
    const t = e.target as HTMLElement;
    if (t.closest('.window-resize-handle')) return;
    if (isLocked(el)) return;
    const chrome = t.closest(chromeSelector);
    if (!chrome || !el.contains(chrome)) return;
    if (t.closest('button, select, label, input, a')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    move = { el, left: r.left, top: r.top, x: e.clientX, y: e.clientY };
    el.classList.add('is-dragging');
    el.setPointerCapture?.(e.pointerId);
  });
}
