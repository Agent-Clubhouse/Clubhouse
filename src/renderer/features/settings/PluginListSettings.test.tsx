import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PluginListSettings } from './PluginListSettings';
import { usePluginStore } from '../../plugins/plugin-store';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';

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
});
