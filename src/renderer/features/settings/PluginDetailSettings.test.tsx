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

vi.mock('../../plugins/plugin-loader', () => ({
  getActiveContext: () => null,
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
    expect(screen.getByText('Test Plugin Settings')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
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
    expect(screen.getByText('This plugin has no configurable settings.')).toBeInTheDocument();
  });

  it('shows back button and calls closePluginSettings when clicked', () => {
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
    fireEvent.click(screen.getByText('Back to Plugins'));
    expect(mockClosePluginSettings).toHaveBeenCalled();
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
    expect(screen.getByText('Allowed Commands')).toBeInTheDocument();
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
});
