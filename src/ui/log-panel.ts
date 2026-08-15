import { log, meetsLevel, type LogEntry, type LogLevel } from '../util/logger';
import { positionCallout } from './callout';

const LEVELS: LogLevel[] = ['trace', 'info', 'warn', 'error'];

/** Event log shown as a callout from Advanced. */
export class LogPanel extends HTMLElement {
  private minLevel: LogLevel = 'info';
  private unsub: (() => void) | null = null;
  private anchor: HTMLElement | null = null;

  connectedCallback(): void {
    this.classList.add('log-panel', 'is-callout');
    this.renderShell();
    this.unsub = log.subscribe((e) => this.appendEntry(e));
    this.reload();
    this.addEventListener('click', (e) => this.onClick(e));
    this.addEventListener('change', (e) => this.onChange(e));
    window.addEventListener('pointerdown', this.onDocPointer, true);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onReposition);
  }

  disconnectedCallback(): void {
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener('pointerdown', this.onDocPointer, true);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onReposition);
  }

  show(): void {
    this.showCallout(this.anchor);
  }

  showCallout(anchor: HTMLElement | null): void {
    this.anchor = anchor;
    this.hidden = false;
    this.reload();
    this.reposition();
  }

  hide(): void {
    this.hidden = true;
  }

  toggleCallout(anchor: HTMLElement | null): void {
    if (!this.hidden) this.hide();
    else this.showCallout(anchor);
  }

  private reposition = (): void => {
    if (this.hidden || !this.anchor) return;
    positionCallout(this, this.anchor);
  };

  private onReposition = (): void => this.reposition();

  private onDocPointer = (e: PointerEvent): void => {
    if (this.hidden) return;
    const t = e.target as Node;
    if (this.contains(t)) return;
    if (this.anchor?.contains(t)) return;
    this.hide();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.hidden) this.hide();
  };

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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('log-panel', LogPanel);
