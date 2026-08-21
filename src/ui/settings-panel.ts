/** Reusable macOS / iOS-style settings shell and row renderers. */

export interface SettingsNavItem {
  id: string;
  label: string;
  iconHtml: string;
}

export interface SettingsSelectOption {
  value: string;
  label: string;
}

export type SettingsRow =
  | {
      type: 'toggle';
      id: string;
      label: string;
      description?: string;
      checked: boolean;
      disabled?: boolean;
    }
  | {
      type: 'select';
      id: string;
      label: string;
      description?: string;
      value: string;
      options: SettingsSelectOption[];
      disabled?: boolean;
    }
  | {
      type: 'button';
      id: string;
      label: string;
      description?: string;
      buttonLabel: string;
      disabled?: boolean;
      danger?: boolean;
    }
  | {
      type: 'link';
      id: string;
      label: string;
      description?: string;
      href: string;
      download?: string;
      linkLabel: string;
    }
  | {
      type: 'badge';
      id: string;
      label: string;
      description?: string;
      badge: string;
    }
  | {
      type: 'file';
      id: string;
      label: string;
      description?: string;
      accept?: string;
      buttonLabel: string;
      hint?: string;
    }
  | { type: 'custom'; html: string };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

export function renderSettingsNav(nav: SettingsNavItem[], selectedId: string): string {
  return nav
    .map((item) => {
      const selected = item.id === selectedId;
      return `
        <button type="button" class="settings-nav__item${selected ? ' is-selected' : ''}"
          data-nav="${escapeAttr(item.id)}" aria-current="${selected ? 'page' : 'false'}">
          <span class="settings-nav__icon" aria-hidden="true">${item.iconHtml}</span>
          <span class="settings-nav__label">${escapeHtml(item.label)}</span>
        </button>`;
    })
    .join('');
}

/** Panel header: section icon left of title, short description underneath. */
export function renderSettingsPanelHeading(opts: {
  title: string;
  description?: string;
  iconHtml?: string;
}): string {
  const icon = opts.iconHtml
    ? `<span class="settings-panel__heading-icon" aria-hidden="true">${opts.iconHtml}</span>`
    : '';
  const desc = opts.description
    ? `<p class="settings-panel__desc">${escapeHtml(opts.description)}</p>`
    : '';
  return `
    <header class="settings-panel__heading">
      ${icon}
      <div class="settings-panel__heading-text">
        <h3 id="settings-panel-title" class="settings-panel__title">${escapeHtml(opts.title)}</h3>
        ${desc}
      </div>
    </header>`;
}

export function renderSettingsFrame(title: string, navHtml: string): string {
  return `
    <div class="settings-shell__backdrop" data-act="close"></div>
    <div class="settings-shell__card" role="dialog" aria-labelledby="settings-title" aria-modal="true">
      <header class="settings-shell__header">
        <h2 id="settings-title">${escapeHtml(title)}</h2>
        <button type="button" class="btn" data-act="close" aria-label="Close">✕</button>
      </header>
      <div class="settings-shell__body">
        <nav class="settings-nav" aria-label="Settings sections">${navHtml}</nav>
        <section class="settings-panel" aria-labelledby="settings-panel-title">
          <div class="settings-panel__heading-slot"></div>
          <div class="settings-panel__content"></div>
        </section>
      </div>
    </div>`;
}

export function renderSettingsShell(opts: {
  title: string;
  nav: SettingsNavItem[];
  selectedId: string;
  panelTitle: string;
  panelDescription?: string;
  panelIconHtml?: string;
  panelHtml: string;
}): string {
  const nav = renderSettingsNav(opts.nav, opts.selectedId);
  const heading = renderSettingsPanelHeading({
    title: opts.panelTitle,
    description: opts.panelDescription,
    iconHtml: opts.panelIconHtml,
  });

  return `
    <div class="settings-shell__backdrop" data-act="close"></div>
    <div class="settings-shell__card" role="dialog" aria-labelledby="settings-title" aria-modal="true">
      <header class="settings-shell__header">
        <h2 id="settings-title">${escapeHtml(opts.title)}</h2>
        <button type="button" class="btn" data-act="close" aria-label="Close">✕</button>
      </header>
      <div class="settings-shell__body">
        <nav class="settings-nav" aria-label="Settings sections">${nav}</nav>
        <section class="settings-panel" aria-labelledby="settings-panel-title">
          ${heading}
          <div class="settings-panel__content">${opts.panelHtml}</div>
        </section>
      </div>
    </div>`;
}

export function renderSettingsGroup(title: string | undefined, rows: SettingsRow[]): string {
  const body = rows.map(renderSettingsRow).join('');
  if (!title) return `<div class="settings-group">${body}</div>`;
  return `
    <div class="settings-group">
      <div class="settings-group__title">${escapeHtml(title)}</div>
      ${body}
    </div>`;
}

export function renderSettingsRow(row: SettingsRow): string {
  if (row.type === 'custom') return row.html;

  const desc = row.description
    ? `<div class="settings-row__desc">${escapeHtml(row.description)}</div>`
    : '';
  const disabled = 'disabled' in row && row.disabled ? ' disabled' : '';

  if (row.type === 'toggle') {
    return `
      <div class="settings-row settings-row--toggle" data-row="${escapeAttr(row.id)}">
        <div class="settings-row__main">
          <div class="settings-row__label">${escapeHtml(row.label)}</div>
          ${desc}
        </div>
        <label class="settings-switch">
          <input type="checkbox" data-field="toggle" data-id="${escapeAttr(row.id)}"${row.checked ? ' checked' : ''}${disabled} />
          <span class="settings-switch__track" aria-hidden="true"></span>
        </label>
      </div>`;
  }

  if (row.type === 'select') {
    const options = row.options
      .map(
        (opt) =>
          `<option value="${escapeAttr(opt.value)}"${opt.value === row.value ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`,
      )
      .join('');
    return `
      <div class="settings-row settings-row--select" data-row="${escapeAttr(row.id)}">
        <div class="settings-row__main">
          <div class="settings-row__label">${escapeHtml(row.label)}</div>
          ${desc}
        </div>
        <select class="settings-select" data-field="select" data-id="${escapeAttr(row.id)}"${disabled}>${options}</select>
      </div>`;
  }

  if (row.type === 'button') {
    const btnClass = row.danger ? 'btn danger' : 'btn';
    return `
      <div class="settings-row settings-row--button" data-row="${escapeAttr(row.id)}">
        <div class="settings-row__main">
          <div class="settings-row__label">${escapeHtml(row.label)}</div>
          ${desc}
        </div>
        <button type="button" class="${btnClass}" data-field="button" data-id="${escapeAttr(row.id)}"${disabled}>${escapeHtml(row.buttonLabel)}</button>
      </div>`;
  }

  if (row.type === 'link') {
    const download = row.download ? ` download="${escapeAttr(row.download)}"` : '';
    return `
      <div class="settings-row settings-row--link" data-row="${escapeAttr(row.id)}">
        <div class="settings-row__main">
          <div class="settings-row__label">${escapeHtml(row.label)}</div>
          ${desc}
        </div>
        <a class="btn" href="${escapeAttr(row.href)}"${download} data-field="link" data-id="${escapeAttr(row.id)}">${escapeHtml(row.linkLabel)}</a>
      </div>`;
  }

  if (row.type === 'badge') {
    return `
      <div class="settings-row settings-row--badge" data-row="${escapeAttr(row.id)}">
        <div class="settings-row__main">
          <div class="settings-row__label">${escapeHtml(row.label)}</div>
          ${desc}
        </div>
        <span class="settings-badge">${escapeHtml(row.badge)}</span>
      </div>`;
  }

  if (row.type === 'file') {
    const hint = row.hint ? `<div class="settings-row__hint">${escapeHtml(row.hint)}</div>` : '';
    return `
      <div class="settings-row settings-row--file" data-row="${escapeAttr(row.id)}">
        <div class="settings-row__main">
          <div class="settings-row__label">${escapeHtml(row.label)}</div>
          ${desc}
          ${hint}
        </div>
        <label class="btn settings-file-btn">
          ${escapeHtml(row.buttonLabel)}
          <input type="file" data-field="file" data-id="${escapeAttr(row.id)}" accept="${escapeAttr(row.accept ?? '')}" hidden${disabled} />
        </label>
      </div>`;
  }

  return '';
}
