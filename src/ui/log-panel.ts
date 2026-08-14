import { log, meetsLevel, type LogEntry, type LogLevel } from '../util/logger';

const LEVELS: LogLevel[] = ['trace', 'info', 'warn', 'error'];

/** Floating diagnostic log panel with level filter. */
export class LogPanel extends HTMLElement {
  private minLevel: LogLevel = 'info';
  private unsub: (() => void) | null = null;
  private drag: { ox: number; oy: number; sx: number; sy: number } | null = null;
  private pos = { x: 24, y: 56 };

  connectedCallback(): void {
    this.classList.add('log-panel');
    this.renderShell();
    this.unsub = log.subscribe((e) => this.appendEntry(e));
    this.reload();
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('change', (e) => this.onChange(e));
    this.querySelector('.log-panel__chrome')?.addEventListener('pointerdown', (e) =>
      this.onDragStart(e as PointerEvent),
    );
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    this.applyPosition();
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
  }

  show(): void {
    this.hidden = false;
    this.reload();
    this.scrollToBottom();
  }

  hide(): void {
    this.hidden = true;
  }

  toggle(): void {
    if (this.hidden) this.show();
    else this.hide();
  }

  private renderShell(): void {
    this.innerHTML = `
      <div class="log-panel__chrome">
        <div class="log-panel__title">Event Log</div>
        <label class="log-panel__level">
          Level
          <select data-act="level">
            ${LEVELS.map((l) => `<option value="${l}"${l === this.minLevel ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="btn log-panel__btn" data-act="clear">Clear</button>
        <button type="button" class="btn log-panel__btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="log-panel__body" role="log" aria-live="polite"></div>
    `;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    if (t.dataset.act === 'close') this.hide();
    if (t.dataset.act === 'clear') {
      log.clear();
      this.reload();
    }
  }

  private onChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    if (sel.dataset.act !== 'level') return;
    this.minLevel = sel.value as LogLevel;
    this.reload();
  }

  private reload(): void {
    const body = this.querySelector('.log-panel__body');
    if (!body) return;
    body.innerHTML = '';
    for (const entry of log.getEntries()) {
      if (meetsLevel(entry.level, this.minLevel)) body.appendChild(this.entryEl(entry));
    }
    this.scrollToBottom();
  }

  private appendEntry(entry: LogEntry): void {
    if (this.hidden || !meetsLevel(entry.level, this.minLevel)) return;
    const body = this.querySelector('.log-panel__body');
    if (!body) return;
    body.appendChild(this.entryEl(entry));
    this.scrollToBottom();
  }

  private entryEl(entry: LogEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = `log-row log-row--${entry.level}`;
    const time = entry.time.toLocaleTimeString(undefined, {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    } as Intl.DateTimeFormatOptions);
    const src = entry.source ? ` [${entry.source}]` : '';
    row.innerHTML = `<span class="log-row__time">${time}</span><span class="log-row__level">${entry.level}</span><span class="log-row__msg">${escapeHtml(entry.message)}${escapeHtml(src)}</span>`;
    return row;
  }

  private scrollToBottom(): void {
    const body = this.querySelector('.log-panel__body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  private applyPosition(): void {
    this.style.left = `${this.pos.x}px`;
    this.style.top = `${this.pos.y}px`;
  }

  private onDragStart(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('select,button,label')) return;
    this.drag = { ox: this.pos.x, oy: this.pos.y, sx: e.clientX, sy: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  private onDragMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    this.pos = {
      x: Math.max(8, this.drag.ox + (e.clientX - this.drag.sx)),
      y: Math.max(8, this.drag.oy + (e.clientY - this.drag.sy)),
    };
    this.applyPosition();
  };

  private onDragEnd = (): void => {
    this.drag = null;
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('log-panel', LogPanel);
