import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PluginListSettings } from './PluginListSettings';
import { usePluginStore } from '../../plugins/plugin-store';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';

// Mock plugin-loader to avoid side effects
const mockDiscoverNewPlugins = vi.fn(async () => [] as string[]);
vi.mock('../../plugins/plugin-loader', () => ({
  activatePlugin: vi.fn(async () => {}),
  deactivatePlugin: vi.fn(async () => {}),
  discoverNewPlugins: (...args: unknown[]) => mockDiscoverNewPlugins(...args),
}));

// Mock the marketplace dialog to avoid nested async fetching
vi.mock('./PluginMarketplaceDialog', () => ({
  PluginMarketplaceDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="mock-marketplace-dialog">
      <button onClick={onClose}>Close Marketplace</button>
    </div>
  ),
}));

beforeEach(() => {
  usePluginStore.setState({
    plugins: {
      'test-builtin': {
        manifest: {
          id: 'test-builtin',
          name: 'Test Builtin',
          version: '1.0.0',
          engine: { api: 0.5 },
          scope: 'project',
        },
        status: 'activated',
        source: 'builtin',
        pluginPath: '/builtin/test',
      },
    },
    projectEnabled: {},
    appEnabled: ['test-builtin'],
    modules: {},
    safeModeActive: false,
    pluginSettings: {},
    externalPluginsEnabled: false,
    permissionViolations: [],
  });

  useUIStore.setState({
    settingsContext: 'app',
  } as any);

  useProjectStore.setState({
    activeProjectId: null,
    projects: [],
  } as any);

  usePluginUpdateStore.setState({
    updates: [],
    incompatibleUpdates: [],
    checking: false,
    lastCheck: null,
    updating: {},
    error: null,
    updateErrors: {},
    dismissed: false,
  });
});

describe('PluginListSettings', () => {
  it('renders the marketplace button in app context', () => {
    render(<PluginListSettings />);
    expect(screen.getByTestId('marketplace-button')).toBeInTheDocument();
    expect(screen.getByText('View Plugin Marketplace')).toBeInTheDocument();
  });

  it('does not render marketplace button in project context', () => {
    useUIStore.setState({ settingsContext: 'project-123' } as any);
    render(<PluginListSettings />);
    expect(screen.queryByTestId('marketplace-button')).not.toBeInTheDocument();
  });

  it('opens marketplace dialog when button is clicked', () => {
    render(<PluginListSettings />);

    expect(screen.queryByTestId('mock-marketplace-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('marketplace-button'));
    expect(screen.getByTestId('mock-marketplace-dialog')).toBeInTheDocument();
  });

  it('closes marketplace dialog when close callback fires', () => {
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('marketplace-button'));
    expect(screen.getByTestId('mock-marketplace-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close Marketplace'));
    expect(screen.queryByTestId('mock-marketplace-dialog')).not.toBeInTheDocument();
  });

  it('renders the Workshop link', () => {
    render(<PluginListSettings />);
    expect(screen.getByTestId('workshop-link')).toBeInTheDocument();
  });

  it('renders "Official" badge for marketplace source plugins', () => {
    usePluginStore.setState({
      plugins: {
        'market-plug': {
          manifest: {
            id: 'market-plug',
            name: 'Market Plugin',
            version: '1.0.0',
            engine: { api: 0.5 },
            scope: 'app',
          },
          status: 'activated',
          source: 'marketplace',
          pluginPath: '/plugins/market-plug',
        },
      },
      appEnabled: ['market-plug'],
      externalPluginsEnabled: true,
    } as any);

    render(<PluginListSettings />);
    expect(screen.getByText('Official')).toBeInTheDocument();
  });

  it('renders "Community" badge for community source plugins', () => {
    usePluginStore.setState({
      plugins: {
        'comm-plug': {
          manifest: {
            id: 'comm-plug',
            name: 'Community Plugin',
            version: '1.0.0',
            engine: { api: 0.5 },
            scope: 'app',
          },
          status: 'activated',
          source: 'community',
          pluginPath: '/plugins/comm-plug',
        },
      },
      appEnabled: ['comm-plug'],
      externalPluginsEnabled: true,
    } as any);

    render(<PluginListSettings />);
    expect(screen.getByText('Community')).toBeInTheDocument();
    expect(screen.queryByText('Official')).not.toBeInTheDocument();
  });

  it('renders "Reload Local Plugins" button in app context', () => {
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);
    expect(screen.getByTestId('scan-plugins-button')).toBeInTheDocument();
    expect(screen.getByText('Reload Local Plugins')).toBeInTheDocument();
  });

  it('calls discoverNewPlugins when scan button is clicked', async () => {
    mockDiscoverNewPlugins.mockResolvedValue(['new-plug-1']);
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('scan-plugins-button'));

    await screen.findByText(/Found 1 new plugin/);
  });

  it('shows no new plugins message when scan finds nothing', async () => {
    mockDiscoverNewPlugins.mockResolvedValue([]);
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('scan-plugins-button'));

    await screen.findByText('No new plugins found.');
  });

  describe('check for updates UI', () => {
    it('renders "Check for Updates" button in app context with external plugins enabled', () => {
      usePluginStore.setState({
        externalPluginsEnabled: true,
      } as any);
      render(<PluginListSettings />);
      expect(screen.getByTestId('check-updates-button')).toBeInTheDocument();
      expect(screen.getByText('Check for Updates')).toBeInTheDocument();
    });

    it('shows "Checking..." when check is in progress', () => {
      usePluginStore.setState({
        externalPluginsEnabled: true,
      } as any);
      usePluginUpdateStore.setState({ checking: true });
      render(<PluginListSettings />);
      expect(screen.getByText('Checking...')).toBeInTheDocument();
    });

    it('shows last check time when available', () => {
      usePluginStore.setState({
        externalPluginsEnabled: true,
      } as any);
      usePluginUpdateStore.setState({ lastCheck: '2026-03-01T12:00:00Z' });
      render(<PluginListSettings />);
      expect(screen.getByTestId('last-check-time')).toBeInTheDocument();
    });

    it('shows "Update All" button when multiple updates available', () => {
      usePluginStore.setState({
        plugins: {
          'plug-a': {
            manifest: { id: 'plug-a', name: 'Plugin A', version: '1.0.0', engine: { api: 0.5 }, scope: 'app' },
            status: 'activated', source: 'community', pluginPath: '/plugins/plug-a',
          },
          'plug-b': {
            manifest: { id: 'plug-b', name: 'Plugin B', version: '1.0.0', engine: { api: 0.5 }, scope: 'app' },
            status: 'activated', source: 'community', pluginPath: '/plugins/plug-b',
          },
        },
        appEnabled: ['plug-a', 'plug-b'],
        externalPluginsEnabled: true,
      } as any);
      usePluginUpdateStore.setState({
        updates: [
          { pluginId: 'plug-a', pluginName: 'Plugin A', currentVersion: '1.0.0', latestVersion: '2.0.0', assetUrl: '', sha256: '', size: 0, api: 0.5 },
          { pluginId: 'plug-b', pluginName: 'Plugin B', currentVersion: '1.0.0', latestVersion: '2.0.0', assetUrl: '', sha256: '', size: 0, api: 0.5 },
        ],
      });
      render(<PluginListSettings />);
      expect(screen.getByTestId('update-all-button')).toBeInTheDocument();
    });

    it('shows per-plugin update badge and button when update available', () => {
      usePluginStore.setState({
        plugins: {
          'updatable': {
            manifest: { id: 'updatable', name: 'Updatable Plugin', version: '1.0.0', engine: { api: 0.5 }, scope: 'app' },
            status: 'activated', source: 'marketplace', pluginPath: '/plugins/updatable',
          },
        },
        appEnabled: ['updatable'],
        externalPluginsEnabled: true,
      } as any);
      usePluginUpdateStore.setState({
        updates: [
          { pluginId: 'updatable', pluginName: 'Updatable Plugin', currentVersion: '1.0.0', latestVersion: '2.0.0', assetUrl: '', sha256: '', size: 0, api: 0.5 },
        ],
      });
      render(<PluginListSettings />);
      expect(screen.getByTestId('update-badge-updatable')).toBeInTheDocument();
      expect(screen.getByTestId('update-btn-updatable')).toBeInTheDocument();
      expect(screen.getByText('v2.0.0 available')).toBeInTheDocument();
    });

    it('shows update phase badge when plugin is being updated', () => {
      usePluginStore.setState({
        plugins: {
          'updating-plug': {
            manifest: { id: 'updating-plug', name: 'Updating Plugin', version: '1.0.0', engine: { api: 0.5 }, scope: 'app' },
            status: 'activated', source: 'community', pluginPath: '/plugins/updating-plug',
          },
        },
        appEnabled: ['updating-plug'],
        externalPluginsEnabled: true,
      } as any);
      usePluginUpdateStore.setState({
        updates: [
          { pluginId: 'updating-plug', pluginName: 'Updating Plugin', currentVersion: '1.0.0', latestVersion: '2.0.0', assetUrl: '', sha256: '', size: 0, api: 0.5 },
        ],
        updating: { 'updating-plug': 'downloading' },
      });
      render(<PluginListSettings />);
      expect(screen.getByTestId('update-phase-updating-plug')).toBeInTheDocument();
      expect(screen.getByText('Downloading...')).toBeInTheDocument();
      // Update button should be hidden during update
      expect(screen.queryByTestId('update-btn-updating-plug')).not.toBeInTheDocument();
    });

    it('shows update error inline on the plugin row', () => {
      usePluginStore.setState({
        plugins: {
          'error-plug': {
            manifest: { id: 'error-plug', name: 'Error Plugin', version: '1.0.0', engine: { api: 0.5 }, scope: 'app' },
            status: 'activated', source: 'community', pluginPath: '/plugins/error-plug',
          },
        },
        appEnabled: ['error-plug'],
        externalPluginsEnabled: true,
      } as any);
      usePluginUpdateStore.setState({
        updateErrors: { 'error-plug': 'Module syntax error' },
      });
      render(<PluginListSettings />);
      expect(screen.getByText(/Update failed: Module syntax error/)).toBeInTheDocument();
    });
  });
});
