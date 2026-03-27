import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from '../stores/uiStore';
import { useUpdateStore } from '../stores/updateStore';
import { useProjectStore } from '../stores/projectStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';
import { AccessoryPanel } from './AccessoryPanel';

vi.mock('../plugins/plugin-loader', () => ({
  getActiveContext: () => null,
}));
vi.mock('../plugins/plugin-api-factory', () => ({
  createPluginAPI: () => ({}),
}));

function resetStores(opts: { previewChannel?: boolean } = {}) {
  useUIStore.setState({
    explorerTab: 'settings',
    settingsContext: 'app',
    settingsSubPage: 'about',
  });
  useUpdateStore.setState({
    settings: {
      autoUpdate: true,
      previewChannel: opts.previewChannel ?? false,
      lastCheck: null,
      dismissedVersion: null,
      lastSeenVersion: null,
    },
  });
}

describe('SettingsCategoryNav (via AccessoryPanel)', () => {
  beforeEach(() => resetStores());

  it('settings category nav is scrollable when content overflows', () => {
    const { container } = render(<AccessoryPanel />);
    const nav = container.querySelector('nav');
    expect(nav).toBeInTheDocument();
    expect(nav!.className).toContain('overflow-y-auto');
    expect(nav!.className).toContain('min-h-0');
  });

  it('shows Experimental nav item when isPreviewEligible returns true', async () => {
    window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(true);
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    unmount();
  });

  it('hides Experimental nav item when isPreviewEligible returns false', async () => {
    window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(false);
    const { unmount } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(window.clubhouse.app.isPreviewEligible).toHaveBeenCalled();
    });
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
    unmount();
  });

  it('re-evaluates preview eligibility when previewChannel changes', async () => {
    window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(false);
    const { unmount, rerender } = render(<AccessoryPanel />);
    await waitFor(() => {
      expect(window.clubhouse.app.isPreviewEligible).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();

    // Simulate preview channel being enabled
    window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(true);
    resetStores({ previewChannel: true });
    rerender(<AccessoryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    unmount();
  });

  it('shows External Editor nav item in app settings', async () => {
    window.clubhouse.app.isPreviewEligible = vi.fn().mockResolvedValue(false);
    render(<AccessoryPanel />);
    expect(screen.getByText('External Editor')).toBeInTheDocument();
  });
});

describe('AccessoryPanel annex plugin sidebar gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for non-annex-enabled plugin sidebar on remote project', () => {
    const satelliteId = 'sat-fp';
    const remoteProjectId = `remote||${satelliteId}||proj-1`;

    useUIStore.setState({ explorerTab: 'plugin:my-plugin' });
    useProjectStore.setState({ activeProjectId: remoteProjectId });
    usePluginStore.setState({
      plugins: {
        'my-plugin': {
          manifest: { id: 'my-plugin', name: 'My Plugin', contributes: { tab: { label: 'My Plugin', layout: 'sidebar-content' } } },
          status: 'activated',
        } as any,
      },
      modules: {
        'my-plugin': { SidebarPanel: () => <div data-testid="sidebar-panel">Sidebar Content</div> } as any,
      },
    });
    useRemoteProjectStore.setState({
      pluginMatchState: {
        [satelliteId]: [
          { id: 'my-plugin', name: 'My Plugin', status: 'matched', annexEnabled: false, scope: 'project' },
        ],
      },
    });

    const { container } = render(<AccessoryPanel />);
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when plugin not found in match state on remote project', () => {
    const satelliteId = 'sat-fp';
    const remoteProjectId = `remote||${satelliteId}||proj-1`;

    useUIStore.setState({ explorerTab: 'plugin:unknown-plugin' });
    useProjectStore.setState({ activeProjectId: remoteProjectId });
    usePluginStore.setState({
      plugins: {
        'unknown-plugin': {
          manifest: { id: 'unknown-plugin', name: 'Unknown', contributes: { tab: { label: 'Unknown', layout: 'sidebar-content' } } },
          status: 'activated',
        } as any,
      },
      modules: {
        'unknown-plugin': { SidebarPanel: () => <div data-testid="sidebar-panel">Sidebar Content</div> } as any,
      },
    });
    useRemoteProjectStore.setState({
      pluginMatchState: { [satelliteId]: [] },
    });

    const { container } = render(<AccessoryPanel />);
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
    expect(container.innerHTML).toBe('');
  });

  it('renders sidebar for annex-enabled plugin on remote project', () => {
    const satelliteId = 'sat-fp';
    const remoteProjectId = `remote||${satelliteId}||proj-1`;

    useUIStore.setState({ explorerTab: 'plugin:my-plugin' });
    useProjectStore.setState({ activeProjectId: remoteProjectId });
    usePluginStore.setState({
      plugins: {
        'my-plugin': {
          manifest: { id: 'my-plugin', name: 'My Plugin', contributes: { tab: { label: 'My Plugin', layout: 'sidebar-content' } } },
          status: 'activated',
        } as any,
      },
      modules: {
        'my-plugin': { SidebarPanel: () => <div data-testid="sidebar-panel">Sidebar Content</div> } as any,
      },
    });
    useRemoteProjectStore.setState({
      pluginMatchState: {
        [satelliteId]: [
          { id: 'my-plugin', name: 'My Plugin', status: 'matched', annexEnabled: true, scope: 'project' },
        ],
      },
    });

    render(<AccessoryPanel />);
    // getActiveContext returns null so PluginSidebarPanel returns null, but the wrapper div renders.
    // The key assertion is that the annex gate did NOT block: we should see the sidebar wrapper div.
    expect(screen.queryByTestId('sidebar-panel')).not.toBeInTheDocument();
    expect(document.querySelector('.bg-ctp-base.border-r')).toBeInTheDocument();
  });

  it('renders sidebar for local (non-remote) project regardless of annex state', () => {
    useUIStore.setState({ explorerTab: 'plugin:my-plugin' });
    useProjectStore.setState({ activeProjectId: 'local-proj-1' });
    usePluginStore.setState({
      plugins: {
        'my-plugin': {
          manifest: { id: 'my-plugin', name: 'My Plugin', contributes: { tab: { label: 'My Plugin', layout: 'sidebar-content' } } },
          status: 'activated',
        } as any,
      },
      modules: {
        'my-plugin': { SidebarPanel: () => <div data-testid="sidebar-panel">Sidebar Content</div> } as any,
      },
    });

    render(<AccessoryPanel />);
    // Not a remote project — annex gate should not apply. Wrapper div should render.
    expect(document.querySelector('.bg-ctp-base.border-r')).toBeInTheDocument();
  });
});
