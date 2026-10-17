import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PluginListSettings } from './PluginListSettings';
import { usePluginStore } from '../../plugins/plugin-store';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { usePluginUpdateStore } from '../../stores/pluginUpdateStore';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';

// Mock plugin-loader to avoid side effects
const mockRefreshCommunityPlugins = vi.fn(async () => ({ discovered: [] as string[], refreshed: [] as string[], activated: [] as string[], incompatible: [] as string[] }));
vi.mock('../../plugins/plugin-loader', () => ({
  activatePlugin: vi.fn(async () => {}),
  deactivatePlugin: vi.fn(async () => {}),
  refreshCommunityPlugins: (...args: unknown[]) => mockRefreshCommunityPlugins(...args),
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

  useMcpSettingsStore.setState({
    enabled: true,
    loaded: true,
  } as any);
});

describe('PluginListSettings', () => {
  it('renders the marketplace button in app context', () => {
    render(<PluginListSettings />);
    expect(screen.getByTestId('marketplace-button')).toBeInTheDocument();
    expect(screen.getByText('Browse marketplace')).toBeInTheDocument();
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

  it('shows "Official" in the meta line for marketplace source plugins', () => {
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
    expect(screen.getByTestId('plugin-meta-market-plug')).toHaveTextContent('Official · 1.0.0');
  });

  it('shows "Community" in the meta line for community source plugins', () => {
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
    expect(screen.getByTestId('plugin-meta-comm-plug')).toHaveTextContent('Community · 1.0.0');
    expect(screen.getByTestId('plugin-meta-comm-plug')).not.toHaveTextContent('Official');
  });

  it('renders the local plugins "Reload" button in app context', () => {
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);
    expect(screen.getByTestId('scan-plugins-button')).toBeInTheDocument();
    expect(screen.getByTestId('scan-plugins-button')).toHaveTextContent('Reload');
    expect(screen.getByText('Local plugins')).toBeInTheDocument();
  });

  it('calls refreshCommunityPlugins when scan button is clicked', async () => {
    mockRefreshCommunityPlugins.mockResolvedValue({ discovered: ['new-plug-1'], refreshed: [], activated: [], incompatible: [] });
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('scan-plugins-button'));

    await screen.findByText(/1 new plugin\(s\) found/);
  });

  it('shows up-to-date message when refresh finds only existing plugins', async () => {
    mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: ['existing-plug'], activated: [], incompatible: [] });
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('scan-plugins-button'));

    await screen.findByText('1 plugin(s) up to date.');
  });

  it('shows no plugins message when nothing found', async () => {
    mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: [], activated: [], incompatible: [] });
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('scan-plugins-button'));

    await screen.findByText('No plugins found.');
  });

  it('shows activated count when plugins are reactivated', async () => {
    mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: ['plug-a'], activated: ['plug-a'], incompatible: [] });
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('scan-plugins-button'));

    await screen.findByText(/1 plugin\(s\) activated/);
  });

  it('shows incompatible count when plugins fail validation', async () => {
    mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: [], activated: [], incompatible: ['bad-plug'] });
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);
    render(<PluginListSettings />);

    fireEvent.click(screen.getByTestId('scan-plugins-button'));

    await screen.findByText(/1 plugin\(s\) incompatible/);
  });

  it('auto-refreshes community plugins on mount when external plugins are enabled', async () => {
    mockRefreshCommunityPlugins.mockClear();
    mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: [], activated: [], incompatible: [] });
    usePluginStore.setState({
      externalPluginsEnabled: true,
    } as any);

    render(<PluginListSettings />);

    // refreshCommunityPlugins should be called on mount without user interaction
    await vi.waitFor(() => {
      expect(mockRefreshCommunityPlugins).toHaveBeenCalled();
    });
  });

  it('does not auto-refresh on mount when external plugins are disabled', async () => {
    mockRefreshCommunityPlugins.mockClear();
    usePluginStore.setState({
      externalPluginsEnabled: false,
    } as any);

    render(<PluginListSettings />);

    // Give effect time to run
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRefreshCommunityPlugins).not.toHaveBeenCalled();
  });

  // ── Mission 69: external master toggle should auto-discover ──────────
  describe('Mission 69 — external master toggle persistence', () => {
    it('auto-refreshes community plugins when toggling external from off→on', async () => {
      mockRefreshCommunityPlugins.mockClear();
      mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: [], activated: [], incompatible: [] });
      usePluginStore.setState({ externalPluginsEnabled: false } as any);
      render(<PluginListSettings />);

      // Reset call count after mount-time effects
      mockRefreshCommunityPlugins.mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Allow external plugins' }));

      await vi.waitFor(() => {
        expect(mockRefreshCommunityPlugins).toHaveBeenCalled();
      });
    });

    it('does NOT auto-refresh when toggling external from on→off', async () => {
      mockRefreshCommunityPlugins.mockClear();
      mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: [], activated: [], incompatible: [] });
      usePluginStore.setState({ externalPluginsEnabled: true } as any);
      render(<PluginListSettings />);

      // Wait for the on-mount auto-refresh, then clear
      await vi.waitFor(() => {
        expect(mockRefreshCommunityPlugins).toHaveBeenCalled();
      });
      mockRefreshCommunityPlugins.mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Allow external plugins' }));

      // Give the handler time to run
      await new Promise((r) => setTimeout(r, 50));
      expect(mockRefreshCommunityPlugins).not.toHaveBeenCalled();
    });

    it('passes active project context to refreshCommunityPlugins on auto-discover', async () => {
      mockRefreshCommunityPlugins.mockClear();
      mockRefreshCommunityPlugins.mockResolvedValue({ discovered: [], refreshed: [], activated: [], incompatible: [] });
      useProjectStore.setState({
        activeProjectId: 'proj-99',
        projects: [{ id: 'proj-99', name: 'Test Proj', path: '/path/to/proj-99' } as any],
      } as any);
      usePluginStore.setState({ externalPluginsEnabled: false } as any);
      render(<PluginListSettings />);
      mockRefreshCommunityPlugins.mockClear();

      fireEvent.click(screen.getByRole('button', { name: 'Allow external plugins' }));

      await vi.waitFor(() => {
        expect(mockRefreshCommunityPlugins).toHaveBeenCalledWith({
          activeProjectId: 'proj-99',
          activeProjectPath: '/path/to/proj-99',
        });
      });
    });

    it('persists external master flag value via storageWrite on toggle', async () => {
      const mockStorageWrite = vi.fn().mockResolvedValue(undefined);
      (window as any).clubhouse = {
        ...(window as any).clubhouse,
        plugin: {
          ...(window as any).clubhouse?.plugin,
          storageWrite: mockStorageWrite,
        },
      };
      usePluginStore.setState({ externalPluginsEnabled: false } as any);
      render(<PluginListSettings />);

      fireEvent.click(screen.getByRole('button', { name: 'Allow external plugins' }));

      await vi.waitFor(() => {
        expect(mockStorageWrite).toHaveBeenCalledWith(
          expect.objectContaining({
            pluginId: '_system',
            scope: 'global',
            key: 'external-plugins-enabled',
            value: true,
          }),
        );
      });
    });
  });

  describe('check for updates UI', () => {
    it('renders "Check for updates" button in app context with external plugins enabled', () => {
      usePluginStore.setState({
        externalPluginsEnabled: true,
      } as any);
      render(<PluginListSettings />);
      expect(screen.getByTestId('check-updates-button')).toBeInTheDocument();
      expect(screen.getByText('Check for updates')).toBeInTheDocument();
    });

    it('shows "Checking..." when check is in progress', () => {
      usePluginStore.setState({
        externalPluginsEnabled: true,
      } as any);
      usePluginUpdateStore.setState({ checking: true });
      render(<PluginListSettings />);
      expect(screen.getByText('Checking…')).toBeInTheDocument();
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

    it('shows a per-plugin update line and button when update available', () => {
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
      expect(screen.getByText('Version 2.0.0 is available.')).toBeInTheDocument();
    });

    it('shows update phase line when plugin is being updated', () => {
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
      expect(screen.getByText('Downloading…')).toBeInTheDocument();
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
      expect(screen.getByText(/Update failed\. Module syntax error/)).toBeInTheDocument();
    });
  });

  describe('permission approval UI', () => {
    it('shows a pending-approval line with approve/reject buttons', () => {
      usePluginStore.setState({
        plugins: {
          'pending-plug': {
            manifest: { id: 'pending-plug', name: 'Pending Plugin', version: '2.0.0', engine: { api: 0.5 }, scope: 'app', permissions: ['storage', 'process'] },
            status: 'pending-approval' as const,
            source: 'community',
            pluginPath: '/plugins/pending-plug',
            pendingPermissions: ['process'] as any,
          },
        },
        appEnabled: ['pending-plug'],
        externalPluginsEnabled: true,
      } as any);
      render(<PluginListSettings />);
      expect(screen.getByTestId('pending-approval-pending-plug')).toBeInTheDocument();
      expect(screen.getByTestId('pending-approval-pending-plug')).toHaveTextContent('This update needs more permissions');
      expect(screen.getByTestId('approve-btn-pending-plug')).toBeInTheDocument();
      expect(screen.getByTestId('reject-btn-pending-plug')).toBeInTheDocument();
      expect(screen.getByText('process')).toBeInTheDocument();
    });
  });

  describe('chrome-style rows', () => {
    it('shows plain meta text instead of chips', () => {
      render(<PluginListSettings />);
      expect(screen.getByTestId('plugin-meta-test-builtin')).toHaveTextContent('Built-in · 1.0.0');
      expect(screen.queryByText('API 0.5')).not.toBeInTheDocument();
      expect(screen.queryByTitle('View permissions')).not.toBeInTheDocument();
    });

    it('shows a deprecation line for plugins on an old API', () => {
      render(<PluginListSettings />);
      expect(screen.getByTestId('deprecated-api-test-builtin')).toHaveTextContent(
        'Uses plugin API 0.5, which stops loading in v0.39.',
      );
    });

    it('shows no action line for a plugin on a current API', () => {
      usePluginStore.setState({
        plugins: {
          fresh: {
            manifest: { id: 'fresh', name: 'Fresh', version: '1.0.0', engine: { api: 0.8 }, scope: 'app' },
            status: 'activated', source: 'builtin', pluginPath: '/builtin/fresh',
          },
        },
        appEnabled: ['fresh'],
      } as any);
      render(<PluginListSettings />);
      expect(screen.queryByTestId('deprecated-api-fresh')).not.toBeInTheDocument();
    });

    it('renders Built-in and From the marketplace sections with counts', () => {
      render(<PluginListSettings />);
      expect(screen.getByRole('heading', { level: 3, name: 'Built-in' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'From the marketplace' })).toBeInTheDocument();
      expect(screen.getByText('Allow external plugins')).toBeInTheDocument();
    });

    it('opens plugin detail from the gear button', () => {
      const openPluginSettings = vi.fn();
      useUIStore.setState({ openPluginSettings } as any);
      render(<PluginListSettings />);
      fireEvent.click(screen.getByTestId('plugin-settings-btn-test-builtin'));
      expect(openPluginSettings).toHaveBeenCalledWith('test-builtin');
    });

    it('toggles the plugin stores section from the header button', async () => {
      (window as any).clubhouse.marketplace.listCustomMarketplaces = vi.fn(async () => []);
      render(<PluginListSettings />);
      expect(screen.queryByTestId('custom-marketplace-section')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('custom-marketplace-toggle'));
      await screen.findByTestId('custom-marketplace-section');
    });
  });

  describe('MCP-dependent plugin visibility', () => {
    const setupMcpPlugin = () => {
      usePluginStore.setState({
        plugins: {
          canvas: {
            manifest: { id: 'canvas', name: 'Canvas', version: '1.0.0', engine: { api: 0.8 }, scope: 'app' },
            status: 'activated',
            source: 'builtin',
            pluginPath: '/builtin/canvas',
          },
          'group-project': {
            manifest: { id: 'group-project', name: 'Group Project', version: '0.1.0', engine: { api: 0.8 }, scope: 'dual', requiresMcp: true },
            status: 'activated',
            source: 'builtin',
            pluginPath: '/builtin/group-project',
          },
          'test-builtin': {
            manifest: { id: 'test-builtin', name: 'Test Builtin', version: '1.0.0', engine: { api: 0.5 }, scope: 'project' },
            status: 'activated',
            source: 'builtin',
            pluginPath: '/builtin/test',
          },
        },
        appEnabled: ['canvas', 'group-project', 'test-builtin'],
        externalPluginsEnabled: false,
      } as any);
    };

    it('shows MCP-dependent plugins when MCP is enabled', () => {
      setupMcpPlugin();
      useMcpSettingsStore.setState({ enabled: true, loaded: true } as any);
      render(<PluginListSettings />);
      expect(screen.getByText('Group Project')).toBeInTheDocument();
    });

    it('hides MCP-dependent plugins when MCP is disabled', () => {
      setupMcpPlugin();
      useMcpSettingsStore.setState({ enabled: false, loaded: true } as any);
      render(<PluginListSettings />);
      expect(screen.queryByText('Group Project')).not.toBeInTheDocument();
    });

    it('still shows non-MCP plugins when MCP is disabled', () => {
      setupMcpPlugin();
      useMcpSettingsStore.setState({ enabled: false, loaded: true } as any);
      render(<PluginListSettings />);
      expect(screen.getByText('Test Builtin')).toBeInTheDocument();
    });
  });
});
