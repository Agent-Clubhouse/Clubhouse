import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PluginSettingsRenderer } from './plugin-settings-renderer';
import { usePluginStore } from './plugin-store';
import type { PluginSettingDeclaration } from '../../shared/plugin-types';

const PLUGIN_ID = 'test-plugin';
const SCOPE = 'app';

function resetStore(settings?: Record<string, unknown>) {
  usePluginStore.setState({
    plugins: {},
    projectEnabled: {},
    appEnabled: [],
    modules: {},
    safeModeActive: false,
    pluginSettings: settings
      ? { [`${SCOPE}:${PLUGIN_ID}`]: settings }
      : {},
  });
}

describe('PluginSettingsRenderer', () => {
  beforeEach(() => {
    resetStore();
    // Silence storage write errors in tests (no real IPC)
    window.clubhouse.plugin.storageWrite = vi.fn(async () => {});
  });

  it('boolean setting renders a toggle, click persists', async () => {
    const settings: PluginSettingDeclaration[] = [
      { key: 'darkMode', type: 'boolean', label: 'Dark Mode', default: false },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    expect(screen.getByText('Dark Mode')).toBeInTheDocument();

    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('data-on', 'false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(usePluginStore.getState().pluginSettings[`${SCOPE}:${PLUGIN_ID}`]?.darkMode).toBe(true);
    });
  });

  it('select setting renders dropdown with options, change persists', async () => {
    const settings: PluginSettingDeclaration[] = [
      {
        key: 'theme',
        type: 'select',
        label: 'Theme',
        default: 'light',
        options: [
          { label: 'Light', value: 'light' },
          { label: 'Dark', value: 'dark' },
        ],
      },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    expect(screen.getByText('Theme')).toBeInTheDocument();

    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('light');

    fireEvent.change(select, { target: { value: 'dark' } });

    await waitFor(() => {
      expect(usePluginStore.getState().pluginSettings[`${SCOPE}:${PLUGIN_ID}`]?.theme).toBe('dark');
    });
  });

  it('number setting renders input with value', () => {
    resetStore({ fontSize: 16 });
    const settings: PluginSettingDeclaration[] = [
      { key: 'fontSize', type: 'number', label: 'Font Size', default: 14 },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    expect(screen.getByText('Font Size')).toBeInTheDocument();

    const input = screen.getByRole('spinbutton');
    expect(input).toHaveValue(16); // from store, not default
  });

  it('string setting renders text input (default fallback)', () => {
    const settings: PluginSettingDeclaration[] = [
      { key: 'greeting', type: 'string', label: 'Greeting', default: 'Hello!' },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    expect(screen.getByText('Greeting')).toBeInTheDocument();

    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Hello!');
  });

  it('description shown when present', () => {
    const settings: PluginSettingDeclaration[] = [
      { key: 'debug', type: 'boolean', label: 'Debug', description: 'Enable debug logging', default: false },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    expect(screen.getByText('Enable debug logging')).toBeInTheDocument();
  });

  it('description omitted when absent', () => {
    const settings: PluginSettingDeclaration[] = [
      { key: 'debug', type: 'boolean', label: 'Debug', default: false },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    expect(screen.getByText('Debug')).toBeInTheDocument();
    // Only the label should be present, no description text
    const container = screen.getByText('Debug').closest('div');
    expect(container?.querySelectorAll('.text-xs')).toHaveLength(0);
  });

  it('calls window.clubhouse.plugin.storageWrite() on change', async () => {
    const storageWrite = vi.fn(async () => {});
    window.clubhouse.plugin.storageWrite = storageWrite;

    const settings: PluginSettingDeclaration[] = [
      { key: 'flag', type: 'boolean', label: 'Flag', default: false },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(storageWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: '_system',
          scope: 'global',
          key: `settings-${SCOPE}-${PLUGIN_ID}`,
        }),
      );
    });
  });

  it('reads initial value from store', () => {
    resetStore({ greeting: 'Custom hello' });
    const settings: PluginSettingDeclaration[] = [
      { key: 'greeting', type: 'string', label: 'Greeting', default: 'Default' },
    ];

    render(<PluginSettingsRenderer pluginId={PLUGIN_ID} settings={settings} scope={SCOPE} />);
    expect(screen.getByRole('textbox')).toHaveValue('Custom hello');
  });
});
