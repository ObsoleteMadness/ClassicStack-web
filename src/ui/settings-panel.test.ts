import { describe, expect, it } from 'vitest';
import { renderSettingsGroup, renderSettingsRow, renderSettingsShell } from './settings-panel';

describe('settings-panel', () => {
  it('renders a two-column shell with selected nav item', () => {
    const html = renderSettingsShell({
      title: 'Settings',
      nav: [{ id: 'general', label: 'General', iconHtml: '<svg/>' }],
      selectedId: 'general',
      panelTitle: 'General',
      panelHtml: '<p>Body</p>',
    });
    expect(html).toContain('settings-shell__body');
    expect(html).toContain('is-selected');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<p>Body</p>');
  });

  it('renders grouped toggle and select rows', () => {
    const html = renderSettingsGroup('Finder', [
      {
        type: 'toggle',
        id: 'show-hidden',
        label: 'Show hidden files',
        description: 'Include invisible items.',
        checked: true,
      },
      {
        type: 'select',
        id: 'default-view',
        label: 'Default view',
        value: 'icon',
        options: [
          { value: 'icon', label: 'Icons' },
          { value: 'list', label: 'List' },
        ],
      },
    ]);
    expect(html).toContain('settings-group__title');
    expect(html).toContain('settings-switch');
    expect(html).toContain('settings-select');
    expect(html).toContain('checked');
    expect(html).toContain('selected');
  });

  it('renders standalone row helpers', () => {
    const html = renderSettingsRow({
      type: 'button',
      id: 'reset',
      label: 'Reset',
      buttonLabel: 'Reset…',
      danger: true,
    });
    expect(html).toContain('btn danger');
    expect(html).toContain('Reset…');
  });
});
