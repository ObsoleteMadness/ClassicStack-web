/**
 * Diagnostic window: every resource type/id in a file's resource fork.
 * Follows Finder selection so cdev / extension icons can be compared live.
 */

import type { Catalog, VNode } from '../fs/virtual-fs';
import { ResourceFork } from '../fs/resource-fork';
import {
  decodeFref,
  describeBndl,
  forkBytesFromNode,
  formatOsType,
  hexDump,
  ICON_RELATED_TYPES,
  inspectResourceFork,
  preferredInspectType,
  resourceIdHint,
  resourceTypeLabel,
  type ForkInspect,
  type ResourceTypeGroup,
} from '../fs/resource-inspect';
import { decodeIcon, SUPPORTED_ICON_TYPES, decodedIconToDataUrl } from '../fs/resource-types/icon-decoder';
import { readTypeCreator } from '../fs/icon-cache';
import { formatBytes } from './format-bytes';
import { enableWindowResize } from './window-resize';

const ICON_TYPE_SET = new Set<string>(SUPPORTED_ICON_TYPES);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function entryKey(type: string, id: number, index: number): string {
  return `${type}:${id}:${index}`;
}

export class ResourceForkExplorer extends HTMLElement {
  private catalog: Catalog | null = null;
  private node: VNode | null = null;
  private inspect: ForkInspect | null = null;
  private source: 'resource' | 'data' | 'empty' = 'empty';
  private selectedType: string | null = null;
  private selectedKey: string | null = null;
  private previewUrl: string | null = null;
  private loadGen = 0;
  private loading = false;
  private error: string | null = null;
  private rf: ResourceFork | null = null;

  connectedCallback(): void {
    this.classList.add('rsrc-explorer');
    this.hidden = true;
    this.renderShell();
    enableWindowResize(this, { minWidth: 420, minHeight: 280 });
    this.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', this.onKey);
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKey);
  }

  show(): void {
    this.hidden = false;
    this.reposition();
  }

  hide(): void {
    this.hidden = true;
  }

  toggle(): void {
    if (this.hidden) this.show();
    else this.hide();
  }

  /** Open (or focus) on a catalog node. Pass null for the empty prompt. */
  open(catalog: Catalog | null, node: VNode | null): void {
    this.show();
    void this.inspectNode(catalog, node, true);
  }

  /** Refresh when Finder selection changes, if the window is visible. */
  followSelection(catalog: Catalog | null, node: VNode | null): void {
    if (this.hidden) return;
    void this.inspectNode(catalog, node, false);
  }

  private reposition(): void {
    if (this.style.left || this.style.top) return;
    const pad = 16;
    const w = Math.min(640, window.innerWidth - pad * 2);
    const h = Math.min(480, window.innerHeight - pad * 2);
    this.style.width = `${w}px`;
    this.style.height = `${h}px`;
    this.style.left = `${Math.max(pad, window.innerWidth - w - pad)}px`;
    this.style.top = `${Math.max(pad, window.innerHeight - h - pad)}px`;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.hidden) this.hide();
  };

  private renderShell(): void {
    this.innerHTML = `
      <div class="rsrc-explorer__chrome">
        <div class="rsrc-explorer__title">Resource Fork</div>
        <div class="rsrc-explorer__file" data-role="file"></div>
        <button type="button" class="btn log-panel__btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="rsrc-explorer__meta" data-role="meta"></div>
      <div class="rsrc-explorer__split">
        <div class="rsrc-explorer__types" data-role="types"></div>
        <div class="rsrc-explorer__entries" data-role="entries"></div>
      </div>
      <div class="rsrc-explorer__detail" data-role="detail"></div>
    `;
  }

  private async inspectNode(catalog: Catalog | null, node: VNode | null, force: boolean): Promise<void> {
    if (
      !force &&
      node &&
      this.node?.id === node.id &&
      this.catalog === catalog &&
      this.inspect &&
      !this.loading
    ) {
      return;
    }
    const gen = ++this.loadGen;
    this.catalog = catalog;
    this.node = node;
    this.previewUrl = null;
    this.error = null;
    this.rf = null;
    this.inspect = null;
    this.source = 'empty';

    if (!node) {
      this.loading = false;
      this.paint();
      return;
    }

    this.loading = true;
    this.paint();

    try {
      let n = node;
      const rsrcHint = n.resourceBytes ?? n.resource.length;
      const dataHint = n.dataBytes ?? n.data.length;
      if (catalog && n.resource.length < 16 && (rsrcHint >= 16 || dataHint >= 16)) {
        n = (await catalog.ensureContent(n.id)) ?? n;
      }
      if (gen !== this.loadGen) return;
      this.node = n;
      const picked = forkBytesFromNode(n);
      this.source = picked.source;
      this.inspect = inspectResourceFork(picked.bytes);
      this.rf = picked.bytes.length >= 16 ? ResourceFork.fromBytes(picked.bytes) : null;
      const types = this.inspect.types.map((g) => g.type);
      if (!this.selectedType || !types.includes(this.selectedType)) {
        this.selectedType = preferredInspectType(types);
        this.selectedKey = null;
      }
      this.loading = false;
      this.paint();
      await this.refreshPreview(gen);
    } catch (err) {
      if (gen !== this.loadGen) return;
      this.loading = false;
      this.error = err instanceof Error ? err.message : String(err);
      this.paint();
    }
  }

  private group(): ResourceTypeGroup | undefined {
    return this.inspect?.types.find((g) => g.type === this.selectedType);
  }

  private selectedEntry(): { entry: import('../fs/resource-fork').ResourceEntry; index: number } | null {
    const group = this.group();
    if (!group) return null;
    if (this.selectedKey) {
      const hit = group.entries.findIndex((e, i) => entryKey(e.type, e.id, i) === this.selectedKey);
      if (hit >= 0) return { entry: group.entries[hit]!, index: hit };
    }
    const first = group.entries[0];
    return first ? { entry: first, index: 0 } : null;
  }

  private async refreshPreview(gen: number): Promise<void> {
    this.previewUrl = null;
    const sel = this.selectedEntry();
    if (!sel || !this.rf || !ICON_TYPE_SET.has(sel.entry.type)) {
      if (gen === this.loadGen) this.paintDetail();
      return;
    }
    const bytes = this.rf.readBytes(sel.entry);
    const decoded = decodeIcon(sel.entry.type, bytes);
    const url = decoded ? await decodedIconToDataUrl(decoded) : null;
    if (gen !== this.loadGen) return;
    this.previewUrl = url;
    this.paintDetail();
  }

  private paint(): void {
    this.paintFile();
    this.paintMeta();
    this.paintTypes();
    this.paintEntries();
    this.paintDetail();
  }

  private paintFile(): void {
    const el = this.querySelector('[data-role="file"]');
    if (!el) return;
    el.textContent = this.node?.name ?? 'No file selected';
  }

  private paintMeta(): void {
    const el = this.querySelector('[data-role="meta"]');
    if (!el) return;
    if (!this.node) {
      el.innerHTML = `<p class="rsrc-explorer__empty">Select a file in the Finder to list its resources.</p>`;
      return;
    }
    if (this.loading) {
      el.innerHTML = `<p class="rsrc-explorer__empty">Reading resource fork…</p>`;
      return;
    }
    if (this.error) {
      el.innerHTML = `<p class="rsrc-explorer__empty rsrc-explorer__empty--error">${escapeHtml(this.error)}</p>`;
      return;
    }
    const { type, creator } = readTypeCreator(this.node.finderInfo);
    const hdr = this.inspect?.header;
    const nTypes = this.inspect?.types.length ?? 0;
    const nRes = this.inspect?.entries.length ?? 0;
    const forkLabel =
      this.source === 'data'
        ? 'parsed from data fork'
        : this.source === 'empty'
          ? 'no resource fork'
          : 'resource fork';
    const hdrBits = hdr
      ? `data @${hdr.dataOffset} (${hdr.dataLength} bytes) · map @${hdr.mapOffset} (${hdr.mapLength} bytes)`
      : this.inspect && this.inspect.forkBytes > 0
        ? 'header did not parse as a resource map'
        : '';
    el.innerHTML = `
      <div class="rsrc-explorer__meta-row">
        <span class="rsrc-explorer__pill">${escapeHtml(formatOsType(type))}</span>
        <span class="rsrc-explorer__pill">${escapeHtml(formatOsType(creator))}</span>
        <span>${escapeHtml(forkLabel)} · ${escapeHtml(formatBytes(this.inspect?.forkBytes ?? 0))} · ${nTypes} type${nTypes === 1 ? '' : 's'} · ${nRes} resource${nRes === 1 ? '' : 's'}</span>
      </div>
      ${hdrBits ? `<div class="rsrc-explorer__hdr">${escapeHtml(hdrBits)}</div>` : ''}
    `;
  }

  private paintTypes(): void {
    const el = this.querySelector('[data-role="types"]');
    if (!el) return;
    const types = this.inspect?.types ?? [];
    if (!this.node || this.loading) {
      el.innerHTML = '';
      return;
    }
    if (!types.length) {
      el.innerHTML = `<p class="rsrc-explorer__empty">No resources</p>`;
      return;
    }
    el.innerHTML = types
      .map((g) => {
        const sel = g.type === this.selectedType ? ' is-selected' : '';
        const icon = ICON_RELATED_TYPES.has(g.type) ? ' rsrc-explorer__type--icon' : '';
        const label = resourceTypeLabel(g.type);
        return `<button type="button" class="rsrc-explorer__type${sel}${icon}" data-act="type" data-type="${escapeHtml(g.type)}">
          <span class="rsrc-explorer__type-code">${escapeHtml(formatOsType(g.type))}</span>
          <span class="rsrc-explorer__type-count">${g.count}</span>
          ${label ? `<span class="rsrc-explorer__type-label">${escapeHtml(label)}</span>` : ''}
        </button>`;
      })
      .join('');
  }

  private paintEntries(): void {
    const el = this.querySelector('[data-role="entries"]');
    if (!el) return;
    const group = this.group();
    if (!group) {
      el.innerHTML = '';
      return;
    }
    const sel = this.selectedEntry();
    const selectedKey = sel ? entryKey(sel.entry.type, sel.entry.id, sel.index) : null;
    const rows = group.entries
      .map((e, i) => {
        const key = entryKey(e.type, e.id, i);
        const isSel = key === selectedKey ? ' is-selected' : '';
        const hint = resourceIdHint(e.type, e.id);
        const name = e.name ? escapeHtml(e.name) : '';
        return `<button type="button" class="rsrc-explorer__res${isSel}" data-act="res" data-key="${escapeHtml(key)}">
          <span class="rsrc-explorer__res-id">${e.id}</span>
          <span class="rsrc-explorer__res-name">${name}${hint ? `<span class="rsrc-explorer__hint">${escapeHtml(hint)}</span>` : ''}</span>
          <span class="rsrc-explorer__res-size">${escapeHtml(formatBytes(e.length))}</span>
          <span class="rsrc-explorer__res-attr">0x${e.attributes.toString(16).padStart(2, '0')}</span>
        </button>`;
      })
      .join('');
    el.innerHTML = `
      <div class="rsrc-explorer__res-head">
        <span>ID</span><span>Name</span><span>Size</span><span>Attr</span>
      </div>
      ${rows}
    `;
  }

  private paintDetail(): void {
    const el = this.querySelector('[data-role="detail"]');
    if (!el) return;
    const sel = this.selectedEntry();
    if (!sel || !this.rf) {
      el.innerHTML = '';
      return;
    }
    const bytes = this.rf.readBytes(sel.entry);
    const parts: string[] = [];

    if (this.previewUrl) {
      parts.push(
        `<div class="rsrc-explorer__preview"><img alt="" width="32" height="32" src="${escapeHtml(this.previewUrl)}" /><span>Decoded ${escapeHtml(formatOsType(sel.entry.type))} ${sel.entry.id}</span></div>`,
      );
    } else if (ICON_TYPE_SET.has(sel.entry.type)) {
      parts.push(`<p class="rsrc-explorer__empty">Icon type present but decode failed (${sel.entry.length} bytes).</p>`);
    }

    if (sel.entry.type === 'FREF') {
      const fref = decodeFref(bytes);
      if (fref) {
        parts.push(
          `<div class="rsrc-explorer__decoded">FREF file type ${escapeHtml(formatOsType(fref.type))} → local icon ${fref.localId}${fref.name ? ` · “${escapeHtml(fref.name)}”` : ''}</div>`,
        );
      }
    }

    if (sel.entry.type === 'BNDL' && this.rf) {
      const view = describeBndl(this.rf, sel.entry);
      if (view) {
        const rows = view.mappings
          .map((m) => {
            const miss = m.present ? '' : ' rsrc-explorer__map--missing';
            return `<tr class="${miss}">
              <td>${escapeHtml(formatOsType(m.code))}</td>
              <td>${m.localId}</td>
              <td>${m.resourceId}</td>
              <td>${m.present ? 'present' : 'missing'}</td>
            </tr>`;
          })
          .join('');
        parts.push(`
          <div class="rsrc-explorer__decoded">
            BNDL owner ${escapeHtml(formatOsType(view.owner))} · owner id ${view.ownerId}
            <table class="rsrc-explorer__map">
              <thead><tr><th>Type</th><th>Local</th><th>Resource</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`);
      }
    }

    const dump = hexDump(bytes);
    parts.push(
      `<pre class="rsrc-explorer__hex">${escapeHtml(dump.text) || '(empty)'}${dump.truncated ? `\n… ${bytes.length - 512} more bytes` : ''}</pre>`,
    );
    el.innerHTML = parts.join('');
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') {
      this.hide();
      return;
    }
    if (act === 'type') {
      this.selectedType = t.dataset.type ?? null;
      this.selectedKey = null;
      this.previewUrl = null;
      this.paintTypes();
      this.paintEntries();
      void this.refreshPreview(this.loadGen);
      return;
    }
    if (act === 'res') {
      this.selectedKey = t.dataset.key ?? null;
      this.previewUrl = null;
      this.paintEntries();
      void this.refreshPreview(this.loadGen);
    }
  }
}

customElements.define('resource-fork-explorer', ResourceForkExplorer);
