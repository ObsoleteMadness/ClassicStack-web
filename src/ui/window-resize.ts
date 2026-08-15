/** Bottom-right resize grip for Finder and floating diagnostic windows. */

interface ResizeOpts {
  minWidth?: number;
  minHeight?: number;
}

const bound = new WeakSet<HTMLElement>();
const optsMap = new WeakMap<HTMLElement, { minWidth: number; minHeight: number }>();

type DragState = { el: HTMLElement; w: number; h: number; x: number; y: number };
let drag: DragState | null = null;
let listening = false;

function ensureHandle(el: HTMLElement): void {
  if (el.querySelector(':scope > .window-resize-handle')) return;
  const handle = document.createElement('div');
  handle.className = 'window-resize-handle';
  handle.title = 'Resize';
  handle.setAttribute('aria-hidden', 'true');
  el.appendChild(handle);
}

function onMove(e: PointerEvent): void {
  if (!drag) return;
  e.preventDefault();
  const { minWidth, minHeight } = optsMap.get(drag.el) ?? { minWidth: 280, minHeight: 160 };
  const w = Math.max(minWidth, drag.w + (e.clientX - drag.x));
  const h = Math.max(minHeight, drag.h + (e.clientY - drag.y));
  drag.el.style.width = `${Math.round(w)}px`;
  drag.el.style.height = `${Math.round(h)}px`;
}

function onUp(): void {
  drag = null;
}

function ensureListeners(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

export function enableWindowResize(el: HTMLElement, opts: ResizeOpts = {}): void {
  optsMap.set(el, {
    minWidth: opts.minWidth ?? 280,
    minHeight: opts.minHeight ?? 160,
  });
  ensureHandle(el);
  ensureListeners();
  if (bound.has(el)) return;
  bound.add(el);
  el.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.window-resize-handle')) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    drag = { el, w: r.width, h: r.height, x: e.clientX, y: e.clientY };
    t.setPointerCapture?.(e.pointerId);
  });
}
