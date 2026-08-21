/**
 * Diagnostic window: PE / NE (and standalone ICO) resources in the data fork.
 * Layout matches the Macintosh resource-fork explorer.
 */

import type { Catalog, VNode } from '../fs/virtual-fs';
import { nodeRef } from '../fs/virtual-fs';
import { hexDump } from '../fs/resource-inspect';
import { decodedIconToDataUrl } from '../fs/resource-types/icon-decoder';
import {
  inspectWinResources,
  preferredWinType,
  previewWinResource,
  RT_CURSOR,
  RT_ICON,
  type WinResEntry,
  type WinResInspect,
  type WinResPreview,
  type WinResTypeGroup,
} from '../fs/winicon';
import { formatBytes } from './format-bytes';
import { downloadBytes } from '../util/pcap';
import { enableWindowMove, enableWindowResize, onWindowGeometryChange, raiseFloatingWindow } from './window-resize';
import { defaultWinResourceFrame, persistWindow, restoreWindow } from './window-layout';

const HEX_PREVIEW_BYTES = 512;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function entryKey(e: WinResEntry, index: number): string {
  return `${e.typeKey}:${e.id ?? e.name ?? ''}:${e.language}:${index}`;
}

function kindTitle(kind: WinResInspect['kind']): string {
  if (kind === 'pe') return 'PE Resources';
  if (kind === 'ne') return 'NE Resources';
  if (kind === 'ico') return 'Icon File';
  if (kind === 'cur') return 'Cursor File';
  return 'Windows Resources';
}

export class WinResourceExplorer extends HTMLElement {
  private catalog: Catalog | null = null;
  private node: VNode | null = null;
  private inspect: WinResInspect | null = null;
  private selectedType: string | null = null;
  private selectedKey: string | null = null;
  private preview: WinResPreview | null = null;
  private previewUrls: string[] = [];
  private loadGen = 0;
  private loading = false;
  private error: string | null = null;
  private previewOpen = false;

  connectedCallback(): void {
    this.classList.add('rsrc-explorer');
    this.hidden = true;
    this.renderShell();
    enableWindowResize(this, { minWidth: 420, minHeight: 280 });
    enableWindowMove(this, '.rsrc-explorer__chrome');
    this.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', this.onKey);
    restoreWindow('winresource', this, defaultWinResourceFrame);
    onWindowGeometryChange(this, () => persistWindow('winresource', this));
  }

  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.onKey);
  }

  show(): void {
    this.hidden = false;
    raiseFloatingWindow(this);
    persistWindow('winresource', this);
  }

  hide(): void {
    this.hidden = true;
    persistWindow('winresource', this);
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

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || this.hidden) return;
    if (this.previewOpen) {
      this.previewOpen = false;
      this.paintPreviewOverlay();
      return;
    }
    this.hide();
  };

  private renderShell(): void {
    this.innerHTML = `
      <div class="rsrc-explorer__chrome">
        <div class="rsrc-explorer__title" data-role="title">Windows Resources</div>
        <div class="rsrc-explorer__file" data-role="file"></div>
        <div class="rsrc-explorer__actions">
          <button type="button" class="btn" data-act="preview-res" disabled>Preview</button>
          <button type="button" class="btn" data-act="download-res" disabled>Download</button>
        </div>
        <button type="button" class="btn log-panel__btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="rsrc-explorer__meta" data-role="meta"></div>
      <div class="rsrc-explorer__split">
        <div class="rsrc-explorer__types" data-role="types"></div>
        <div class="rsrc-explorer__entries" data-role="entries"></div>
      </div>
      <div class="rsrc-explorer__detail" data-role="detail"></div>
      <div class="rsrc-explorer__preview-overlay" data-role="preview-overlay" hidden></div>
    `;
  }

  private async inspectNode(catalog: Catalog | null, node: VNode | null, force: boolean): Promise<void> {
    if (
      !force &&
      node &&
      this.node &&
      nodeRef(this.node) === nodeRef(node) &&
      this.catalog === catalog &&
      this.inspect &&
      !this.loading
    ) {
      return;
    }
    const gen = ++this.loadGen;
    this.catalog = catalog;
    this.node = node;
    this.preview = null;
    this.previewUrls = [];
    this.error = null;
    this.inspect = null;

    if (!node) {
      this.loading = false;
      this.paint();
      return;
    }

    this.loading = true;
    this.paint();

    try {
      if (node.isDir) {
        this.inspect = { kind: null, types: [], entries: [] };
      } else if (catalog) {
        this.inspect = await catalog.withRangeReader(node, (read) => inspectWinResources(read), {
          resource: false,
        });
      } else {
        this.inspect = { kind: null, types: [], entries: [] };
      }
      if (gen !== this.loadGen) return;
      const types = this.inspect.types;
      if (!this.selectedType || !types.some((g) => g.key === this.selectedType)) {
        this.selectedType = preferredWinType(types);
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

  private group(): WinResTypeGroup | undefined {
    return this.inspect?.types.find((g) => g.key === this.selectedType);
  }

  private selectedEntry(): { entry: WinResEntry; index: number } | null {
    const group = this.group();
    if (!group) return null;
    if (this.selectedKey) {
      const hit = group.entries.findIndex((e, i) => entryKey(e, i) === this.selectedKey);
      if (hit >= 0) return { entry: group.entries[hit]!, index: hit };
    }
    const first = group.entries[0];
    return first ? { entry: first, index: 0 } : null;
  }

  private blobsOf(typeId: number): Map<number, Uint8Array> {
    const m = new Map<number, Uint8Array>();
    for (const e of this.inspect?.entries ?? []) {
      if (e.typeId === typeId && e.id != null) m.set(e.id, e.bytes);
    }
    return m;
  }

  private async refreshPreview(gen: number): Promise<void> {
    this.preview = null;
    this.previewUrls = [];
    const sel = this.selectedEntry();
    if (!sel) {
      if (gen === this.loadGen) this.paintDetail();
      return;
    }
    if (gen === this.loadGen) this.paintDetail();
    const preview = await previewWinResource({
      typeId: sel.entry.typeId,
      id: sel.entry.id,
      bytes: sel.entry.bytes,
      iconBlobs: this.blobsOf(RT_ICON),
      cursorBlobs: this.blobsOf(RT_CURSOR),
    });
    if (gen !== this.loadGen) return;
    this.preview = preview;
    const icons =
      preview.kind === 'icon' ? preview.icons : preview.kind === 'bitmap' ? [preview.icon] : [];
    this.previewUrls = [];
    for (const icon of icons) {
      const url = await decodedIconToDataUrl(icon);
      if (url) this.previewUrls.push(url);
    }
    if (gen !== this.loadGen) return;
    this.paintEntries();
    this.paintDetail();
  }

  private paint(): void {
    this.paintActions();
    this.paintPreviewOverlay();
    this.paintTitle();
    this.paintFile();
    this.paintMeta();
    this.paintTypes();
    this.paintEntries();
    this.paintDetail();
  }

  private paintTitle(): void {
    const el = this.querySelector('[data-role="title"]');
    if (!el) return;
    el.textContent = kindTitle(this.inspect?.kind ?? null);
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
      el.innerHTML = `<p class="rsrc-explorer__empty">Select a file in the Finder to list its PE/NE resources.</p>`;
      return;
    }
    if (this.loading) {
      el.innerHTML = `<p class="rsrc-explorer__empty">Reading Windows resources…</p>`;
      return;
    }
    if (this.error) {
      el.innerHTML = `<p class="rsrc-explorer__empty rsrc-explorer__empty--error">${escapeHtml(this.error)}</p>`;
      return;
    }
    if (this.node.isDir) {
      el.innerHTML = `<p class="rsrc-explorer__empty">Folders have no PE/NE resource table.</p>`;
      return;
    }
    const nTypes = this.inspect?.types.length ?? 0;
    const nRes = this.inspect?.entries.length ?? 0;
    const size = this.node.dataBytes ?? this.node.data.length;
    const pills: string[] = [];
    if (this.inspect?.magic) pills.push(this.inspect.magic.toUpperCase());
    if (this.inspect?.machineName) pills.push(this.inspect.machineName);
    if (this.inspect?.kind === 'ne' && this.inspect.shift != null) {
      pills.push(`align ${1 << this.inspect.shift}`);
    }
    const kindLabel =
      this.inspect?.kind === 'pe'
        ? 'PE resource directory'
        : this.inspect?.kind === 'ne'
          ? 'NE resource table'
          : this.inspect?.kind === 'ico' || this.inspect?.kind === 'cur'
            ? 'icon directory'
            : 'not a PE, NE, or ICO file';
    el.innerHTML = `
      <div class="rsrc-explorer__meta-row">
        ${pills.map((p) => `<span class="rsrc-explorer__pill">${escapeHtml(p)}</span>`).join('')}
        <span>${escapeHtml(kindLabel)} · ${escapeHtml(formatBytes(size))} · ${nTypes} type${nTypes === 1 ? '' : 's'} · ${nRes} resource${nRes === 1 ? '' : 's'}</span>
      </div>
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
        const sel = g.key === this.selectedType ? ' is-selected' : '';
        const icon = g.icon ? ' rsrc-explorer__type--icon' : '';
        return `<button type="button" class="rsrc-explorer__type${sel}${icon}" data-act="type" data-type="${escapeHtml(g.key)}">
          <span class="rsrc-explorer__type-code">${escapeHtml(g.code)}</span>
          <span class="rsrc-explorer__type-count">${g.count}</span>
          <span class="rsrc-explorer__type-label">${escapeHtml(g.label)}</span>
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
    const selectedKey = sel ? entryKey(sel.entry, sel.index) : null;
    const showLang = this.inspect?.kind === 'pe';
    const rows = group.entries
      .map((e, i) => {
        const key = entryKey(e, i);
        const isSel = key === selectedKey ? ' is-selected' : '';
        const id = e.id != null ? String(e.id) : '—';
        const name = e.name ? escapeHtml(e.name) : '';
        const lang =
          showLang && e.language ? `0x${e.language.toString(16).padStart(4, '0')}` : showLang ? '—' : '';
        return `<button type="button" class="rsrc-explorer__res${isSel}" data-act="res" data-key="${escapeHtml(key)}">
          <span class="rsrc-explorer__res-id">${escapeHtml(id)}</span>
          <span class="rsrc-explorer__res-name">${name}</span>
          <span class="rsrc-explorer__res-size">${escapeHtml(formatBytes(e.length))}</span>
          ${showLang ? `<span class="rsrc-explorer__res-attr">${escapeHtml(lang)}</span>` : ''}
        </button>`;
      })
      .join('');
    el.innerHTML = `
      <div class="rsrc-explorer__res-head">
        <span>ID</span><span>Name</span><span>Size</span>${showLang ? '<span>Lang</span>' : ''}
      </div>
      ${rows}
    `;
  }

  private paintDetail(): void {
    const el = this.querySelector('[data-role="detail"]');
    if (!el) return;
    const sel = this.selectedEntry();
    if (!sel) {
      el.innerHTML = '';
      return;
    }
    const bytes = sel.entry.bytes;
    const parts: string[] = [];
    const preview = this.preview;

    if (this.previewUrls.length) {
      const imgs = this.previewUrls
        .map((url) => `<img alt="" width="32" height="32" src="${escapeHtml(url)}" />`)
        .join('');
      const label =
        preview?.kind === 'bitmap'
          ? `Decoded bitmap ${sel.entry.id ?? sel.entry.name ?? ''}`
          : `Decoded ${escapeHtml(sel.entry.typeName ?? 'icon')} ${sel.entry.id ?? ''}`;
      parts.push(`<div class="rsrc-explorer__preview">${imgs}<span>${label}</span></div>`);
    } else if (preview?.kind === 'icon' || preview?.kind === 'bitmap') {
      parts.push(
        `<p class="rsrc-explorer__empty">Image present but decode failed (${sel.entry.length} bytes).</p>`,
      );
    }

    if (preview?.kind === 'version' && preview.fields.length) {
      const rows = preview.fields
        .map(
          (f) =>
            `<tr><td>${escapeHtml(f.key)}</td><td>${escapeHtml(f.value)}</td></tr>`,
        )
        .join('');
      parts.push(`
        <div class="rsrc-explorer__decoded">
          Version info
          <table class="rsrc-explorer__map">
            <thead><tr><th>Key</th><th>Value</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`);
    }

    if (preview?.kind === 'strings' && preview.lines.length) {
      const rows = preview.lines
        .map((l) => `<tr><td>${l.index}</td><td>${escapeHtml(l.text)}</td></tr>`)
        .join('');
      parts.push(`
        <div class="rsrc-explorer__decoded">
          String table
          <table class="rsrc-explorer__map">
            <thead><tr><th>ID</th><th>Text</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`);
    }

    if (preview?.kind === 'text') {
      parts.push(
        `<pre class="rsrc-explorer__decoded">${escapeHtml(preview.encoding)}\n${escapeHtml(preview.text)}</pre>`,
      );
    }

    const dump = hexDump(bytes, HEX_PREVIEW_BYTES);
    const unread = dump.truncated ? bytes.length - HEX_PREVIEW_BYTES : 0;
    parts.push(
      `<pre class="rsrc-explorer__hex">${escapeHtml(dump.text) || '(empty)'}${unread > 0 ? `\n… ${unread} more bytes` : ''}</pre>`,
    );
    el.innerHTML = parts.join('');
  }


  private selectedCanPreview(): boolean {
    const preview = this.preview;
    return preview?.kind === 'icon' || preview?.kind === 'bitmap';
  }

  private downloadSelectedResource(): void {
    const sel = this.selectedEntry();
    if (!sel) return;
    const name = sel.entry.name || `${sel.entry.typeName || 'resource'}_${sel.entry.id ?? '0'}.bin`;
    downloadBytes(sel.entry.bytes, name, 'application/octet-stream');
  }

  private paintActions(): void {
    const previewBtn = this.querySelector('[data-act="preview-res"]') as HTMLButtonElement | null;
    const downloadBtn = this.querySelector('[data-act="download-res"]') as HTMLButtonElement | null;
    const hasSel = !!this.selectedEntry();
    if (previewBtn) previewBtn.disabled = !hasSel || !this.selectedCanPreview() || this.previewUrls.length === 0;
    if (downloadBtn) downloadBtn.disabled = !hasSel;
  }

  private paintPreviewOverlay(): void {
    const el = this.querySelector('[data-role="preview-overlay"]') as HTMLElement | null;
    if (!el) return;
    if (!this.previewOpen || !this.previewUrls.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    const imgs = this.previewUrls.map((url) => `<img alt="" src="${escapeHtml(url)}" />`).join('');
    el.innerHTML = `<button type="button" class="btn log-panel__btn" data-act="close-preview" aria-label="Close preview">✕</button>${imgs}`;
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
      this.preview = null;
      this.previewUrls = [];
      this.paintTypes();
      this.paintEntries();
      void this.refreshPreview(this.loadGen);
      return;
    }
    if (act === 'res') {
      this.selectedKey = t.dataset.key ?? null;
      this.preview = null;
      this.previewUrls = [];
      this.previewOpen = false;
      this.paintEntries();
      void this.refreshPreview(this.loadGen);
      return;
    }
    if (act === 'download-res') {
      this.downloadSelectedResource();
      return;
    }
    if (act === 'preview-res') {
      if (this.selectedCanPreview() && this.previewUrls.length) {
        this.previewOpen = true;
        this.paintPreviewOverlay();
      }
      return;
    }
    if (act === 'close-preview') {
      this.previewOpen = false;
      this.paintPreviewOverlay();
    }
  }
}

customElements.define('win-resource-explorer', WinResourceExplorer);
