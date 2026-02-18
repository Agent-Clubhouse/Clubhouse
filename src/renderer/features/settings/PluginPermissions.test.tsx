import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { usePluginStore } from '../../plugins/plugin-store';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import type { PluginManifest, PluginRegistryEntry } from '../../../shared/plugin-types';
import { PERMISSION_DESCRIPTIONS } from '../../../shared/plugin-types';
import { PluginListSettings } from './PluginListSettings';
import { PluginDetailSettings } from './PluginDetailSettings';

function makeEntry(manifest: PluginManifest, overrides?: Partial<PluginRegistryEntry>): PluginRegistryEntry {
  return {
    manifest,
    status: 'activated',
    source: 'community',
    pluginPath: `/plugins/${manifest.id}`,
    ...overrides,
  };
}

const v05Manifest: PluginManifest = {
  id: 'wiki-plugin',
  name: 'Wiki Plugin',
  version: '1.0.0',
  engine: { api: 0.5 },
  scope: 'project',
  contributes: { help: {} },
  permissions: ['files', 'files.external', 'storage', 'notifications'],
  externalRoots: [
    { settingKey: 'wiki-root', root: 'wiki' },
    { settingKey: 'docs-root', root: 'docs' },
  ],
};

function resetStores() {
  usePluginStore.setState({
    plugins: {
      'wiki-plugin': makeEntry(v05Manifest),
    },
    projectEnabled: {},
    appEnabled: ['wiki-plugin'],
    modules: {},
    safeModeActive: false,
    pluginSettings: {},
  });
  useUIStore.setState({
    settingsContext: 'app',
    settingsSubPage: 'plugins',
    explorerTab: 'settings',
  });
  useProjectStore.setState({
    projects: [],
    activeProjectId: null,
  });
}

describe('PluginListSettings — PermissionInfoPopup', () => {
  beforeEach(resetStores);

  it('renders (i) info icon for v0.5 plugin with permissions', () => {
    render(<PluginListSettings />);
    // The v0.5 plugin should have the info button
    const buttons = screen.getAllByTitle('View permissions');
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking (i) icon opens popup with permission list', () => {
    render(<PluginListSettings />);
    const infoButton = screen.getAllByTitle('View permissions')[0];
    fireEvent.click(infoButton);

    // Should show permission names
    expect(screen.getByText('files')).toBeInTheDocument();
    expect(screen.getByText('files.external')).toBeInTheDocument();
    expect(screen.getByText('storage')).toBeInTheDocument();
    expect(screen.getByText('notifications')).toBeInTheDocument();
  });

  it('popup shows human-readable descriptions for each permission', () => {
    render(<PluginListSettings />);
    const infoButton = screen.getAllByTitle('View permissions')[0];
    fireEvent.click(infoButton);

    // Check descriptions from PERMISSION_DESCRIPTIONS
    expect(screen.getByText(PERMISSION_DESCRIPTIONS['files'])).toBeInTheDocument();
    expect(screen.getByText(PERMISSION_DESCRIPTIONS['files.external'])).toBeInTheDocument();
    expect(screen.getByText(PERMISSION_DESCRIPTIONS['storage'])).toBeInTheDocument();
    expect(screen.getByText(PERMISSION_DESCRIPTIONS['notifications'])).toBeInTheDocument();
  });

  it('popup closes on outside click', () => {
    render(<PluginListSettings />);
    const infoButton = screen.getAllByTitle('View permissions')[0];
    fireEvent.click(infoButton);

    // Popup should be open
    expect(screen.getByText('Permissions')).toBeInTheDocument();

    // Click outside
    fireEvent.mouseDown(document.body);

    // Popup should close
    expect(screen.queryByText(PERMISSION_DESCRIPTIONS['files'])).toBeNull();
  });

  it('clicking (i) icon twice toggles popup', () => {
    render(<PluginListSettings />);
    const infoButton = screen.getAllByTitle('View permissions')[0];

    // Open
    fireEvent.click(infoButton);
    expect(screen.getByText('Permissions')).toBeInTheDocument();

    // Close
    fireEvent.click(infoButton);
    expect(screen.queryByText(PERMISSION_DESCRIPTIONS['files'])).toBeNull();
  });

  it('shows API version badge for v0.5 plugin', () => {
    render(<PluginListSettings />);
    expect(screen.getByText('API 0.5')).toBeInTheDocument();
  });

  it('popup uses fixed positioning to escape overflow clipping', () => {
    render(<PluginListSettings />);
    const infoButton = screen.getAllByTitle('View permissions')[0];
    fireEvent.click(infoButton);

    const popup = screen.getByTestId('permission-popup');
    expect(popup.className).toContain('fixed');
    expect(popup.className).not.toContain('absolute');
  });
});

describe('PluginDetailSettings — permissions section', () => {
  beforeEach(() => {
    resetStores();
    useUIStore.setState({
      pluginSettingsId: 'wiki-plugin',
      settingsSubPage: 'plugin-detail',
      settingsContext: 'app',
    });
  });

  it('renders permissions section for v0.5 plugin', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByText('Permissions')).toBeInTheDocument();
  });

  it('lists all declared permissions with descriptions', () => {
    render(<PluginDetailSettings />);
    // Permission names
    expect(screen.getByText('files')).toBeInTheDocument();
    expect(screen.getByText('files.external')).toBeInTheDocument();
    expect(screen.getByText('storage')).toBeInTheDocument();
    expect(screen.getByText('notifications')).toBeInTheDocument();

    // Descriptions
    expect(screen.getByText(PERMISSION_DESCRIPTIONS['files'])).toBeInTheDocument();
    expect(screen.getByText(PERMISSION_DESCRIPTIONS['files.external'])).toBeInTheDocument();
  });

  it('renders external roots section when externalRoots declared', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByText('External Roots')).toBeInTheDocument();
    expect(screen.getByText('wiki')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('shows settingKey for each external root', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByText('wiki-root')).toBeInTheDocument();
    expect(screen.getByText('docs-root')).toBeInTheDocument();
  });

  it('does not show external roots when plugin has permissions but no externalRoots', () => {
    const noExtManifest: PluginManifest = {
      ...v05Manifest,
      id: 'no-ext',
      permissions: ['files', 'git'],
      externalRoots: undefined,
    };
    usePluginStore.setState({
      plugins: {
        'no-ext': makeEntry(noExtManifest),
      },
      appEnabled: ['no-ext'],
    });
    useUIStore.setState({ pluginSettingsId: 'no-ext' });
    render(<PluginDetailSettings />);
    expect(screen.getByText('Permissions')).toBeInTheDocument();
    expect(screen.queryByText('External Roots')).toBeNull();
  });

  it('shows plugin name and version', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByText('Wiki Plugin Settings')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
  });

  it('empty permissions array does not show permissions section', () => {
    const emptyPermsManifest: PluginManifest = {
      ...v05Manifest,
      id: 'empty-perms',
      permissions: [],
      externalRoots: undefined,
    };
    usePluginStore.setState({
      plugins: {
        'empty-perms': makeEntry(emptyPermsManifest),
      },
      appEnabled: ['empty-perms'],
    });
    useUIStore.setState({ pluginSettingsId: 'empty-perms' });
    render(<PluginDetailSettings />);
    expect(screen.queryByText('Permissions')).toBeNull();
  });

  it('renders allowedCommands section when declared', () => {
    const processManifest: PluginManifest = {
      ...v05Manifest,
      id: 'process-plugin',
      permissions: ['files', 'process'],
      allowedCommands: ['gh', 'node'],
      externalRoots: undefined,
    };
    usePluginStore.setState({
      plugins: {
        'process-plugin': makeEntry(processManifest),
      },
      appEnabled: ['process-plugin'],
    });
    useUIStore.setState({ pluginSettingsId: 'process-plugin' });
    render(<PluginDetailSettings />);
    expect(screen.getByText('Allowed Commands')).toBeInTheDocument();
    expect(screen.getByText('gh')).toBeInTheDocument();
    expect(screen.getByText('node')).toBeInTheDocument();
  });

  it('does not render allowedCommands section when not declared', () => {
    render(<PluginDetailSettings />);
    expect(screen.queryByText('Allowed Commands')).toBeNull();
  });
});
