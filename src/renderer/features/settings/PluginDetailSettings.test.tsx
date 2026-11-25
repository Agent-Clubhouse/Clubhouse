import { render, screen, fireEvent } from '@testing-library/react';
import { PluginDetailSettings } from './PluginDetailSettings';
import { useUIStore } from '../../stores/uiStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useProjectStore } from '../../stores/projectStore';

vi.mock('../../plugins/plugin-context', () => ({
  PluginAPIProvider: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('../../plugins/plugin-api-factory', () => ({
  createPluginAPI: () => ({}),
}));

const mockActivatePlugin = vi.fn(async () => {});
const mockDeactivatePlugin = vi.fn(async () => {});
vi.mock('../../plugins/plugin-loader', () => ({
  getActiveContext: () => null,
  activatePlugin: (...args: unknown[]) => mockActivatePlugin(...args),
  deactivatePlugin: (...args: unknown[]) => mockDeactivatePlugin(...args),
  refreshCommunityPlugins: vi.fn(async () => ({ discovered: [], refreshed: [], activated: [], incompatible: [] })),
  approvePluginPermissions: vi.fn(),
  rejectPluginPermissions: vi.fn(),
}));

vi.mock('../../plugins/plugin-settings-renderer', () => ({
  PluginSettingsRenderer: () => <div data-testid="plugin-settings-renderer" />,
}));

vi.mock('../../panels/PluginContentView', () => ({
  PluginErrorBoundary: ({ children }: any) => <div>{children}</div>,
}));

const mockClosePluginSettings = vi.fn();

function resetStores() {
  useUIStore.setState({
    pluginSettingsId: null,
    settingsContext: 'app',
    setSettingsSubPage: vi.fn(),
    closePluginSettings: mockClosePluginSettings,
  });

  usePluginStore.setState({
    plugins: {},
    modules: {},
    appEnabled: [],
    projectEnabled: {},
  });

  useProjectStore.setState({
    activeProjectId: 'proj-1',
  });
}

describe('PluginDetailSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders "No plugin selected" when no plugin set', () => {
    render(<PluginDetailSettings />);
    expect(screen.getByText('No plugin selected')).toBeInTheDocument();
  });

  it('renders "Plugin not found" for unknown plugin', () => {
    useUIStore.setState({ pluginSettingsId: 'unknown-plugin' });
    render(<PluginDetailSettings />);
    expect(screen.getByText('Plugin not found')).toBeInTheDocument();
  });

  it('renders plugin name and version', () => {
    useUIStore.setState({ pluginSettingsId: 'test-plugin' });
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            scope: 'dual',
            permissions: [],
          },
        },
      } as any,
    });

    render(<PluginDetailSettings />);
    expect(screen.getByRole('heading', { level: 2, name: 'Test Plugin' })).toBeInTheDocument();
    expect(screen.getByTestId('plugin-detail-meta')).toHaveTextContent('1.0.0');
  });

  it('shows permissions section when plugin has permissions', () => {
    useUIStore.setState({ pluginSettingsId: 'test-plugin' });
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            scope: 'dual',
            permissions: ['terminal'],
          },
        },
      } as any,
    });

    render(<PluginDetailSettings />);
    expect(screen.getByText('Permissions')).toBeInTheDocument();
    expect(screen.getByText('terminal')).toBeInTheDocument();
  });

  it('shows "no configurable settings" message when no settings panel', () => {
    useUIStore.setState({ pluginSettingsId: 'test-plugin' });
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            scope: 'dual',
            permissions: [],
          },
        },
      } as any,
      modules: {},
    });

    render(<PluginDetailSettings />);
    expect(screen.getByText('This plugin has no settings.')).toBeInTheDocument();
  });

  it('has no in-pane back link (the sidebar keeps Plugins selected)', () => {
    useUIStore.setState({ pluginSettingsId: 'test-plugin' });
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: { id: 'test-plugin', name: 'Test Plugin', version: '1.0.0', scope: 'dual', permissions: [] },
        },
      } as any,
    });

    render(<PluginDetailSettings />);
    expect(screen.queryByText('Back to Plugins')).not.toBeInTheDocument();
    expect(mockClosePluginSettings).not.toHaveBeenCalled();
  });

  it('shows the enabled state in the header and toggles it', async () => {
    useUIStore.setState({ pluginSettingsId: 'test-plugin' });
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: { id: 'test-plugin', name: 'Test Plugin', version: '1.0.0', scope: 'dual', permissions: [] },
          status: 'activated',
          source: 'builtin',
        },
      } as any,
      appEnabled: ['test-plugin'],
    });
    (window as any).clubhouse.plugin.storageWrite = vi.fn(async () => {});

    render(<PluginDetailSettings />);
    expect(screen.getByText('On')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Test Plugin' }));
    await vi.waitFor(() => {
      expect(mockDeactivatePlugin).toHaveBeenCalledWith('test-plugin');
    });
    await vi.waitFor(() => {
      expect(screen.getByText('Off')).toBeInTheDocument();
    });
  });

  it('shows allowed commands when present', () => {
    useUIStore.setState({ pluginSettingsId: 'test-plugin' });
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            scope: 'dual',
            permissions: [],
            allowedCommands: ['git', 'npm'],
          },
        },
      } as any,
    });

    render(<PluginDetailSettings />);
    expect(screen.getByText('Allowed commands')).toBeInTheDocument();
    expect(screen.getByText('git')).toBeInTheDocument();
    expect(screen.getByText('npm')).toBeInTheDocument();
  });

  it('renders declarative settings renderer', () => {
    useUIStore.setState({ pluginSettingsId: 'test-plugin' });
    usePluginStore.setState({
      plugins: {
        'test-plugin': {
          manifest: {
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            scope: 'dual',
            permissions: [],
            settingsPanel: 'declarative',
            contributes: {
              settings: [{ key: 'foo', type: 'string', label: 'Foo' }],
            },
          },
        },
      } as any,
    });

    render(<PluginDetailSettings />);
    expect(screen.getByTestId('plugin-settings-renderer')).toBeInTheDocument();
  });

  describe('status lines', () => {
    const withEntry = (extra: Record<string, unknown>, manifest: Record<string, unknown> = {}) => {
      useUIStore.setState({ pluginSettingsId: 'test-plugin' });
      usePluginStore.setState({
        plugins: {
          'test-plugin': {
            manifest: { id: 'test-plugin', name: 'Test Plugin', version: '1.0.0', scope: 'dual', permissions: [], ...manifest },
            ...extra,
          },
        } as any,
      });
    };

    it('lets you approve pending permissions from the detail page', () => {
      withEntry({ status: 'pending-approval', pendingPermissions: ['terminal'] });
      render(<PluginDetailSettings />);
      expect(screen.getByTestId('pending-approval-test-plugin')).toHaveTextContent('terminal');
      expect(screen.getByTestId('approve-btn-test-plugin')).toBeInTheDocument();
      expect(screen.getByTestId('reject-btn-test-plugin')).toBeInTheDocument();
    });

    it('says "Error" for an errored plugin with no message', () => {
      withEntry({ status: 'errored' });
      render(<PluginDetailSettings />);
      expect(screen.getByTestId('plugin-error-test-plugin')).toHaveTextContent('Error');
    });

    it('shows the plugin API version in the meta line', () => {
      withEntry({}, { engine: { api: 0.8 } });
      render(<PluginDetailSettings />);
      expect(screen.getByTestId('plugin-detail-meta')).toHaveTextContent('Plugin API 0.8');
    });
  });
});
