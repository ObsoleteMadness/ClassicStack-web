import { log } from '../util/logger';
import {
  cloneDefaultExtensionMap,
  hydrateExtensionMap,
  persistExtensionMap,
  type ExtensionMapping,
} from '../fs/extension-map';
import { uiIcons } from './lucide-icon';

/** Advanced-menu editor for filename extension → creator/type mappings. */
export class ExtensionEditorDialog extends HTMLElement {
  private rows: ExtensionMapping[] = [];
  private busy = false;
  private error = '';

  connectedCallback(): void {
    this.classList.add('extension-editor-dialog');
    this.hidden = true;
    this.addEventListener('click', (e) => void this.onClick(e));
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.hidden) this.close();
    });
  }

  open(): void {
    this.hidden = false;
    this.error = '';
    this.busy = true;
    this.rows = [];
    this.render();
    log.info('Opened extension editor', 'finder');
    void this.reload();
  }

  close(): void {
    this.hidden = true;
    this.innerHTML = '';
    this.error = '';
    this.busy = false;
  }

  private async reload(): Promise<void> {
    try {
      this.rows = await hydrateExtensionMap();
      this.error = '';
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.rows = [];
    }
    this.busy = false;
    if (this.hidden) return;
    this.render();
    queueMicrotask(() => {
      this.querySelector<HTMLInputElement>('[data-field="extension"]')?.focus();
    });
  }

  private harvest(): ExtensionMapping[] {
    const out: ExtensionMapping[] = [];
    for (const row of this.querySelectorAll<HTMLElement>('[data-row]')) {
      const extension = (row.querySelector('[data-field="extension"]') as HTMLInputElement)?.value ?? '';
      const creator = (row.querySelector('[data-field="creator"]') as HTMLInputElement)?.value ?? '';
      const type = (row.querySelector('[data-field="type"]') as HTMLInputElement)?.value ?? '';
      const comment = (row.querySelector('[data-field="comment"]') as HTMLInputElement)?.value ?? '';
      out.push({ extension, creator, type, comment });
    }
    return out;
  }

  private render(): void {
    const bodyRows = this.rows
      .map(
        (row, i) => `
        <div class="extension-editor__row" data-row>
          <input data-field="extension" spellcheck="false" autocomplete="off" maxlength="16"
            value="${escapeAttr(row.extension)}" placeholder="txt" aria-label="Extension" ${this.busy ? 'disabled' : ''} />
          <input data-field="creator" class="extension-editor__ostype" spellcheck="false" autocomplete="off" maxlength="4"
            value="${escapeAttr(row.creator)}" placeholder="ttxt" aria-label="Creator" ${this.busy ? 'disabled' : ''} />
          <input data-field="type" class="extension-editor__ostype" spellcheck="false" autocomplete="off" maxlength="4"
            value="${escapeAttr(row.type)}" placeholder="TEXT" aria-label="Type" ${this.busy ? 'disabled' : ''} />
          <input data-field="comment" spellcheck="false" autocomplete="off" maxlength="160"
            value="${escapeAttr(row.comment)}" placeholder="ASCII Text" aria-label="Comment" ${this.busy ? 'disabled' : ''} />
          <button type="button" class="btn icon-btn extension-editor__remove" data-act="remove" data-i="${i}" aria-label="Remove row" ${this.busy ? 'disabled' : ''}>
            ${uiIcons.delete}
          </button>
        </div>`,
      )
      .join('');

    this.innerHTML = `
      <div class="netboot-dialog__backdrop" data-act="cancel"></div>
      <div class="netboot-dialog__card extension-editor__card" role="dialog" aria-labelledby="ext-editor-title" aria-modal="true">
        <header class="netboot-dialog__header">
          <h2 id="ext-editor-title">Extension editor</h2>
          <button type="button" class="btn" data-act="cancel" aria-label="Close">✕</button>
        </header>
        <p class="netboot-dialog__lead">Map filename extensions to Macintosh creator and type codes. Used when importing files that have no AppleDouble metadata.</p>
        ${this.error ? `<p class="extension-editor__error">${escapeAttr(this.error)}</p>` : ''}
        <div class="extension-editor__table-wrap">
          <div class="extension-editor__grid">
            <div class="extension-editor__head">Extension</div>
            <div class="extension-editor__head">Creator</div>
            <div class="extension-editor__head">Type</div>
            <div class="extension-editor__head">Comment</div>
            <div class="extension-editor__head"></div>
            ${this.busy ? '' : bodyRows}
          </div>
          ${this.busy ? `<p class="extension-editor__empty">Loading…</p>` : ''}
          ${!this.busy && bodyRows ? '' : !this.busy ? `<p class="extension-editor__empty">No mappings. Add a row or reset to defaults.</p>` : ''}
        </div>
        <footer class="netboot-dialog__footer extension-editor__footer">
          <button type="button" class="btn" data-act="add" ${this.busy ? 'disabled' : ''}>${uiIcons.add} Add</button>
          <button type="button" class="btn" data-act="reset" ${this.busy ? 'disabled' : ''}>Reset</button>
          <span class="extension-editor__spacer"></span>
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="button" class="btn primary" data-act="save" ${this.busy ? 'disabled' : ''}>Save</button>
        </footer>
      </div>
    `;
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'cancel') {
      this.close();
      return;
    }
    if (this.busy) return;
    if (act === 'add') {
      this.rows = this.harvest();
      this.rows.push({ extension: '', creator: '', type: '', comment: '' });
      this.render();
      const inputs = this.querySelectorAll<HTMLInputElement>('[data-field="extension"]');
      inputs[inputs.length - 1]?.focus();
      return;
    }
    if (act === 'remove') {
      this.rows = this.harvest();
      const i = Number(t.dataset.i);
      if (Number.isInteger(i)) this.rows.splice(i, 1);
      this.render();
      return;
    }
    if (act === 'reset') {
      this.rows = cloneDefaultExtensionMap();
      this.error = '';
      this.render();
      return;
    }
    if (act === 'save') {
      const rows = this.harvest();
      this.busy = true;
      this.error = '';
      this.render();
      try {
        this.rows = await persistExtensionMap(rows);
        log.info(`Saved ${this.rows.length} filename extension mapping${this.rows.length === 1 ? '' : 's'}`, 'finder');
        this.close();
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.busy = false;
        if (!this.hidden) this.render();
      }
    }
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

customElements.define('extension-editor-dialog', ExtensionEditorDialog);
