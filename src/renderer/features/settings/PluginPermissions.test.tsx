import { render, screen } from '@testing-library/react';
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
  id: 'ext-plugin',
  name: 'Ext Plugin',
  version: '1.0.0',
  engine: { api: 0.5 },
  scope: 'project',
  contributes: { help: {} },
  permissions: ['files', 'files.external', 'storage', 'notifications'],
  externalRoots: [
    { settingKey: 'data-root', root: 'data' },
    { settingKey: 'docs-root', root: 'docs' },
  ],
};

const appScopedCrossProjectManifest: PluginManifest = {
  id: 'app-cross',
  name: 'App Cross Plugin',
  version: '1.0.0',
  engine: { api: 0.5 },
  scope: 'app',
  permissions: ['agent-config', 'agent-config.cross-project', 'workspace', 'workspace.cross-project'],
};

const projectScopedCrossProjectManifest: PluginManifest = {
  id: 'proj-cross',
  name: 'Proj Cross Plugin',
  version: '1.0.0',
  engine: { api: 0.5 },
  scope: 'project',
  permissions: ['agent-config', 'agent-config.cross-project'],
};

function resetStores() {
  usePluginStore.setState({
    plugins: {
      'ext-plugin': makeEntry(v05Manifest),
    },
    projectEnabled: {},
    appEnabled: ['ext-plugin'],
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

describe('PluginListSettings — rows stay plain', () => {
  beforeEach(resetStores);

  it('does not show a permissions popup or API chip on the row', () => {
    render(<PluginListSettings />);
    expect(screen.queryByTitle('View permissions')).toBeNull();
    expect(screen.queryByTestId('permission-popup')).toBeNull();
    expect(screen.queryByText('API 0.5')).toBeNull();
    expect(screen.queryByText('files.external')).toBeNull();
  });

  it('shows source and version as plain meta text', () => {
    render(<PluginListSettings />);
    expect(screen.getByTestId('plugin-meta-ext-plugin')).toHaveTextContent('Community · 1.0.0');
  });
});

describe('PluginDetailSettings — permissions section', () => {
  beforeEach(() => {
    resetStores();
    useUIStore.setState({
      pluginSettingsId: 'ext-plugin',
      settingsSubPage: 'plugin-detail',
      settingsContext: 'app',
    });
  });

  it('renders permissions section for v0.5 plugin', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByText('Permissions')).toBeInTheDocument();
  });

  it('groups permissions by risk', () => {
    render(<PluginDetailSettings />);
    const elevated = screen.getByTestId('permission-group-elevated');
    expect(elevated).toHaveTextContent('Can change things');
    expect(elevated).toHaveTextContent('files.external');
    const safe = screen.getByTestId('permission-group-safe');
    expect(safe).toHaveTextContent('Read only');
    expect(safe).toHaveTextContent('storage');
    expect(safe).toHaveTextContent('notifications');
    expect(screen.queryByTestId('permission-group-dangerous')).toBeNull();
  });

  it('shows the "Can bypass safety" group for dangerous permissions', () => {
    usePluginStore.setState({
      plugins: {
        'app-cross': makeEntry(appScopedCrossProjectManifest),
      },
      appEnabled: ['app-cross'],
    });
    useUIStore.setState({ pluginSettingsId: 'app-cross' });
    render(<PluginDetailSettings />);
    const dangerous = screen.getByTestId('permission-group-dangerous');
    expect(dangerous).toHaveTextContent('Can bypass safety');
    expect(dangerous).toHaveTextContent('workspace.cross-project');
    expect(screen.getByText('Can bypass safety').className).toContain('text-ctp-error');
  });

  it('shows app-scope cross-project note for app-scoped plugins with cross-project permissions', () => {
    usePluginStore.setState({
      plugins: {
        'app-cross': makeEntry(appScopedCrossProjectManifest),
      },
      appEnabled: ['app-cross'],
    });
    useUIStore.setState({ pluginSettingsId: 'app-cross' });
    render(<PluginDetailSettings />);
    expect(screen.getByTestId('app-scope-cross-project-note').textContent).toContain(
      'works across the whole app',
    );
  });

  it('does not show app-scope note for project-scoped plugins with cross-project permissions', () => {
    usePluginStore.setState({
      plugins: {
        'proj-cross': makeEntry(projectScopedCrossProjectManifest),
      },
      appEnabled: ['proj-cross'],
    });
    useUIStore.setState({ pluginSettingsId: 'proj-cross' });
    render(<PluginDetailSettings />);
    expect(screen.queryByTestId('app-scope-cross-project-note')).toBeNull();
  });

  it('rewrites cross-project permission descriptions for app-scoped plugins', () => {
    usePluginStore.setState({
      plugins: {
        'app-cross': makeEntry(appScopedCrossProjectManifest),
      },
      appEnabled: ['app-cross'],
    });
    useUIStore.setState({ pluginSettingsId: 'app-cross' });
    render(<PluginDetailSettings />);
    expect(screen.queryByText(/where the plugin is also enabled/)).toBeNull();
    expect(screen.getAllByText(/across all projects, since the plugin is app-wide/).length).toBeGreaterThanOrEqual(1);
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
    expect(screen.getByText('External roots')).toBeInTheDocument();
    expect(screen.getByText('data')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('shows settingKey for each external root', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByText('data-root')).toBeInTheDocument();
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
    expect(screen.queryByText('External roots')).toBeNull();
  });

  it('shows plugin name and version', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByRole('heading', { level: 2, name: 'Ext Plugin' })).toBeInTheDocument();
    expect(screen.getByTestId('plugin-detail-meta')).toHaveTextContent('Community · 1.0.0');
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
    expect(screen.getByText('Allowed commands')).toBeInTheDocument();
    expect(screen.getByText('gh')).toBeInTheDocument();
    expect(screen.getByText('node')).toBeInTheDocument();
  });

  it('does not render allowedCommands section when not declared', () => {
    render(<PluginDetailSettings />);
    expect(screen.queryByText('Allowed commands')).toBeNull();
  });
});
