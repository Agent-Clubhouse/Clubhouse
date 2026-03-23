import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useBadgeStore } from '../stores/badgeStore';
import { useBadgeSettingsStore } from '../stores/badgeSettingsStore';
import { usePanelStore } from '../stores/panelStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useAnnexClientStore } from '../stores/annexClientStore';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';
import { ProjectRail } from './ProjectRail';
import type { Project } from '../../shared/types';
import type { SatelliteConnection } from '../stores/annexClientStore';

// Mock window.clubhouse.annexClient for SatelliteHostRow retry
const mockAnnexClient = {
  retry: vi.fn(),
};

vi.stubGlobal('window', {
  ...globalThis.window,
  clubhouse: { annexClient: mockAnnexClient },
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'test-project',
    path: '/home/user/test-project',
    ...overrides,
  };
}

function makeSatellite(overrides: Partial<SatelliteConnection> = {}): SatelliteConnection {
  return {
    id: 'sat-1',
    alias: 'Office Mac',
    icon: '',
    color: 'emerald',
    fingerprint: 'ab:cd:ef',
    state: 'connected',
    host: '192.168.1.100',
    mainPort: 9090,
    pairingPort: 9091,
    snapshot: null,
    lastError: null,
    ...overrides,
  };
}

function resetStores() {
  useProjectStore.setState({
    projects: [],
    activeProjectId: null,
    projectIcons: {},
  });
  useUIStore.setState({
    explorerTab: 'agents',
    showHome: false,
    activeHostId: null,
  });
  usePluginStore.setState({
    plugins: {},
    appEnabled: [],
    pluginSettings: {},
  });
  useBadgeStore.setState({ badges: {} });
  useBadgeSettingsStore.setState({
    enabled: true,
    pluginBadges: true,
    projectRailBadges: true,
    projectOverrides: {},
  });
  usePanelStore.setState({
    railPinned: false,
    railWidth: 200,
  });
  useAnnexClientStore.setState({
    satellites: [],
  });
  useRemoteProjectStore.setState({
    satelliteProjects: {},
    pluginMatchState: {},
    remoteProjectIcons: {},
  });
}

describe('ProjectRail badge clipping', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
  });

  it('rail container uses asymmetric padding so badges are not clipped', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });

    const { container } = render(<ProjectRail />);
    // The rail container is the inner div with width transition
    const railContainer = container.querySelector('[style*="width"]');
    expect(railContainer).toBeInTheDocument();
    // Should have pr-[10px] (not pr-[14px]) to give badges room
    expect(railContainer!.className).toContain('pr-[10px]');
    expect(railContainer!.className).toContain('pl-[14px]');
  });

  it('scroll container has top padding to prevent first badge from being clipped', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });

    const { container } = render(<ProjectRail />);
    // The scroll container holds the project list with overflow-y-auto
    const scrollContainer = container.querySelector('.overflow-y-auto');
    expect(scrollContainer).toBeInTheDocument();
    expect(scrollContainer!.className).toContain('pt-1');
  });

  it('renders badge dot on project icon when badges are enabled', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });
    useBadgeStore.setState({
      badges: {
        'test::explorer-tab:p1:agents': {
          id: 'test::explorer-tab:p1:agents',
          source: 'test',
          type: 'dot',
          value: 1,
          target: { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' },
        },
      },
    });

    render(<ProjectRail />);
    expect(screen.getByTestId('badge-dot')).toBeInTheDocument();
  });

  it('badge wrapper uses negative positioning that requires adequate container space', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });
    useBadgeStore.setState({
      badges: {
        'test::explorer-tab:p1:agents': {
          id: 'test::explorer-tab:p1:agents',
          source: 'test',
          type: 'dot',
          value: 1,
          target: { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' },
        },
      },
    });

    render(<ProjectRail />);
    const badgeDot = screen.getByTestId('badge-dot');
    const badgeWrapper = badgeDot.parentElement!;
    // Badge wrapper uses -top-1 -right-1 to position outside icon bounds
    expect(badgeWrapper.className).toContain('-top-1');
    expect(badgeWrapper.className).toContain('-right-1');
  });
});

describe('ProjectRail context menu', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
  });

  it('shows context menu on right-click of a project icon', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
    });

    render(<ProjectRail />);
    const projectButton = screen.getByTestId('project-p1');
    fireEvent.contextMenu(projectButton.parentElement!);

    expect(screen.getByTestId('project-context-menu')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-project-settings')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-close-project')).toBeInTheDocument();
  });

  it('closes project when Close Project is clicked', () => {
    const removeProject = vi.fn();
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
      removeProject,
    });

    render(<ProjectRail />);
    const projectButton = screen.getByTestId('project-p1');
    fireEvent.contextMenu(projectButton.parentElement!);
    fireEvent.click(screen.getByTestId('ctx-close-project'));

    expect(removeProject).toHaveBeenCalledWith('p1');
  });

  it('does not show context menu initially', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
    });

    render(<ProjectRail />);
    expect(screen.queryByTestId('project-context-menu')).not.toBeInTheDocument();
  });
});

describe('ProjectRail pin button', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
  });

  it('renders pin button', () => {
    render(<ProjectRail />);
    expect(screen.getByTestId('rail-pin-button')).toBeInTheDocument();
  });

  it('pin button is invisible (pointer-events-none) when rail is collapsed', () => {
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    // When not expanded, opacity-0 and pointer-events-none
    expect(pinBtn.className).toContain('opacity-0');
    expect(pinBtn.className).toContain('pointer-events-none');
  });

  it('pin button becomes visible when rail is pinned', () => {
    usePanelStore.setState({ railPinned: true });
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    expect(pinBtn.className).toContain('opacity-100');
    expect(pinBtn.className).not.toContain('pointer-events-none');
  });

  it('clicking pin button toggles pinned state in store', () => {
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    fireEvent.click(pinBtn);
    expect(usePanelStore.getState().railPinned).toBe(true);
    fireEvent.click(pinBtn);
    expect(usePanelStore.getState().railPinned).toBe(false);
  });

  it('pin button shows filled icon when pinned', () => {
    usePanelStore.setState({ railPinned: true });
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    const svg = pinBtn.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg!.getAttribute('fill')).toBe('currentColor');
  });

  it('pin button shows outline icon when not pinned', () => {
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    const svg = pinBtn.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg!.getAttribute('fill')).toBe('none');
  });

  it('pin icon is rotated 45deg when unpinned', () => {
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    const svg = pinBtn.querySelector('svg');
    expect(svg!.getAttribute('class')).toContain('rotate-45');
  });

  it('pin icon is not rotated when pinned', () => {
    usePanelStore.setState({ railPinned: true });
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    const svg = pinBtn.querySelector('svg');
    expect(svg!.getAttribute('class') ?? '').not.toContain('rotate-45');
  });

  it('pin button has correct title when unpinned', () => {
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    expect(pinBtn.getAttribute('title')).toBe('Pin sidebar open');
  });

  it('pin button has correct title when pinned', () => {
    usePanelStore.setState({ railPinned: true });
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    expect(pinBtn.getAttribute('title')).toBe('Unpin sidebar');
  });

  it('pinned rail uses accent color for pin button', () => {
    usePanelStore.setState({ railPinned: true });
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    expect(pinBtn.className).toContain('text-ctp-accent');
  });

  it('unpinned rail uses subtext color for pin button', () => {
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    expect(pinBtn.className).toContain('text-ctp-subtext0');
  });

  it('pin button is absolutely positioned in its own column, not a flow row', () => {
    usePanelStore.setState({ railPinned: true });
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    // Pin button should be absolutely positioned top-right
    expect(pinBtn.className).toContain('absolute');
    expect(pinBtn.className).toContain('top-[20px]');
    expect(pinBtn.className).toContain('right-[10px]');
  });

  it('pin button does not shift rail items down (no wrapper row)', () => {
    usePanelStore.setState({ railPinned: true });
    render(<ProjectRail />);
    const pinBtn = screen.getByTestId('rail-pin-button');
    // Pin button is a direct child of the rail inner div, not inside a wrapper row
    const parent = pinBtn.parentElement!;
    expect(parent.className).toContain('relative');
    expect(parent.className).toContain('flex-col');
  });
});

describe('ProjectRail pinned behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
  });

  it('pinned rail uses railWidth from store', () => {
    usePanelStore.setState({ railPinned: true, railWidth: 300 });
    const { container } = render(<ProjectRail />);
    const railContainer = container.querySelector('[style*="width"]');
    expect(railContainer).toBeInTheDocument();
    expect((railContainer as HTMLElement).style.width).toBe('300px');
  });

  it('unpinned rail uses collapsed width', () => {
    const { container } = render(<ProjectRail />);
    const railContainer = container.querySelector('[style*="width"]');
    expect(railContainer).toBeInTheDocument();
    const width = parseInt((railContainer as HTMLElement).style.width);
    // collapsedWidth is 70 or 76
    expect(width).toBeLessThan(100);
  });

  it('pinned rail does not use overlay styling', () => {
    usePanelStore.setState({ railPinned: true });
    const { container } = render(<ProjectRail />);
    const railContainer = container.querySelector('[style*="width"]');
    expect(railContainer!.className).not.toContain('absolute');
    expect(railContainer!.className).not.toContain('z-30');
  });

  it('pinned rail shows project labels (expanded state)', () => {
    usePanelStore.setState({ railPinned: true });
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });
    render(<ProjectRail />);
    // Label spans should have opacity-100 when expanded
    const labels = screen.getAllByText('Alpha');
    const labelSpan = labels.find((el) => el.tagName === 'SPAN' && el.className.includes('truncate'));
    expect(labelSpan).toBeDefined();
    expect(labelSpan!.className).toContain('opacity-100');
  });

  it('unpinned collapsed rail hides project labels', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });
    render(<ProjectRail />);
    const labels = screen.getAllByText('Alpha');
    const labelSpan = labels.find((el) => el.tagName === 'SPAN' && el.className.includes('truncate'));
    expect(labelSpan).toBeDefined();
    expect(labelSpan!.className).toContain('opacity-0');
  });

  it('data-testid rail-container is present on outer container', () => {
    render(<ProjectRail />);
    expect(screen.getByTestId('rail-container')).toBeInTheDocument();
  });

  it('sets --rail-width CSS variable to railWidth when pinned', () => {
    usePanelStore.setState({ railPinned: true, railWidth: 250 });
    render(<ProjectRail />);
    const cssVar = document.documentElement.style.getPropertyValue('--rail-width');
    expect(cssVar).toBe('250px');
  });

  it('sets --rail-width CSS variable to collapsedWidth when unpinned', () => {
    render(<ProjectRail />);
    const cssVar = document.documentElement.style.getPropertyValue('--rail-width');
    // collapsedWidth is 70px (no scrollbar in test)
    expect(cssVar).toBe('70px');
  });
});

// ---------------------------------------------------------------------------
// Host switching tests
// ---------------------------------------------------------------------------

describe('ProjectRail host switching', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
    usePanelStore.setState({ railPinned: true }); // pinned so labels visible
  });

  it('renders satellites as single rows in local mode', () => {
    useAnnexClientStore.setState({
      satellites: [
        makeSatellite({ id: 'sat-1', alias: 'Office Mac' }),
        makeSatellite({ id: 'sat-2', alias: 'Home PC', state: 'disconnected' }),
      ],
    });

    render(<ProjectRail />);
    expect(screen.getByTestId('host-satellite-sat-1')).toBeInTheDocument();
    expect(screen.getByTestId('host-satellite-sat-2')).toBeInTheDocument();
    // No local host row in local mode
    expect(screen.queryByTestId('host-local')).not.toBeInTheDocument();
  });

  it('satellite rows show status dots', () => {
    useAnnexClientStore.setState({
      satellites: [
        makeSatellite({ id: 'sat-1', state: 'connected' }),
        makeSatellite({ id: 'sat-2', state: 'disconnected' }),
      ],
    });

    render(<ProjectRail />);
    const onlineDot = screen.getByTestId('host-status-sat-1');
    const offlineDot = screen.getByTestId('host-status-sat-2');
    expect(onlineDot.className).toContain('bg-emerald-500');
    expect(offlineDot.className).toContain('bg-surface-2');
  });

  it('clicking a satellite switches to satellite host mode', () => {
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1', alias: 'Office Mac' })],
    });

    render(<ProjectRail />);
    fireEvent.click(screen.getByTestId('host-satellite-sat-1'));

    expect(useUIStore.getState().activeHostId).toBe('sat-1');
  });

  it('satellite host mode shows local host row and hides local projects', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1', alias: 'Office Mac' })],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });

    render(<ProjectRail />);
    // Local host row should appear
    expect(screen.getByTestId('host-local')).toBeInTheDocument();
    // Local project should not be visible
    expect(screen.queryByTestId('project-p1')).not.toBeInTheDocument();
    // Add project button should not be visible
    expect(screen.queryByTestId('nav-add-project')).not.toBeInTheDocument();
  });

  it('clicking local host row switches back to local mode', () => {
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1', alias: 'Office Mac' })],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });

    render(<ProjectRail />);
    fireEvent.click(screen.getByTestId('host-local'));

    expect(useUIStore.getState().activeHostId).toBeNull();
  });

  it('satellite host mode shows active satellite highlighted', () => {
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1', alias: 'Office Mac', color: 'emerald' })],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });

    render(<ProjectRail />);
    // There should be two satellite host rows: the collapsed one in switcher
    // does not exist (it's filtered out), only the active highlighted one
    const rows = screen.getAllByTestId('host-satellite-sat-1');
    expect(rows).toHaveLength(1);
  });

  it('satellite host mode shows other satellites as collapsed rows', () => {
    useAnnexClientStore.setState({
      satellites: [
        makeSatellite({ id: 'sat-1', alias: 'Office Mac' }),
        makeSatellite({ id: 'sat-2', alias: 'Home PC' }),
      ],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });

    render(<ProjectRail />);
    // sat-2 should appear as a collapsed row
    expect(screen.getByTestId('host-satellite-sat-2')).toBeInTheDocument();
    // sat-1 is the active host (highlighted)
    expect(screen.getByTestId('host-satellite-sat-1')).toBeInTheDocument();
  });

  it('satellite host mode renders remote projects', () => {
    const sat = makeSatellite({ id: 'sat-1', alias: 'Office Mac', fingerprint: 'ab:cd:ef' });
    useAnnexClientStore.setState({ satellites: [sat] });
    useUIStore.setState({ activeHostId: 'sat-1' });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'ab:cd:ef': [
          {
            id: 'remote||sat-1||rp-1',
            name: 'RemoteProject',
            path: '__remote__',
            remote: true,
            satelliteId: 'sat-1',
            satelliteName: 'Office Mac',
          } as any,
        ],
      },
    });

    render(<ProjectRail />);
    expect(screen.getByTestId('project-remote||sat-1||rp-1')).toBeInTheDocument();
  });

  it('renders "No projects" when active satellite has no projects', () => {
    const sat = makeSatellite({ id: 'sat-1', alias: 'Office Mac', fingerprint: 'ab:cd:ef' });
    useAnnexClientStore.setState({ satellites: [sat] });
    useUIStore.setState({ activeHostId: 'sat-1' });
    useRemoteProjectStore.setState({
      satelliteProjects: { 'ab:cd:ef': [] },
    });

    render(<ProjectRail />);
    expect(screen.getByText('No projects')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Annex-gated plugin tests
// ---------------------------------------------------------------------------

describe('ProjectRail annex-gated plugins', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
    usePanelStore.setState({ railPinned: true });
  });

  it('renders app plugins normally in local mode', () => {
    usePluginStore.setState({
      plugins: {
        'canvas': {
          manifest: {
            id: 'canvas',
            name: 'Canvas',
            version: '1.0.0',
            scope: 'dual',
            permissions: ['annex'],
            contributes: {
              railItem: { label: 'Canvas', position: 'top' },
            },
          },
          status: 'activated',
          source: 'builtin',
        } as any,
      },
      appEnabled: ['canvas'],
    });

    render(<ProjectRail />);
    const canvasBtn = screen.getByTitle('Canvas');
    // Should not be dimmed
    expect(canvasBtn.className).not.toContain('cursor-not-allowed');
    expect(canvasBtn.className).not.toContain('opacity-40');
  });

  it('dims non-annex plugins when satellite is active host', () => {
    usePluginStore.setState({
      plugins: {
        'my-plugin': {
          manifest: {
            id: 'my-plugin',
            name: 'My Plugin',
            version: '1.0.0',
            scope: 'app',
            contributes: {
              railItem: { label: 'My Plugin', position: 'top' },
            },
          },
          status: 'activated',
          source: 'community',
        } as any,
      },
      appEnabled: ['my-plugin'],
    });
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1' })],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });
    useRemoteProjectStore.setState({
      pluginMatchState: {
        'sat-1': [
          { id: 'my-plugin', name: 'My Plugin', status: 'matched', annexEnabled: false },
        ],
      },
    });

    render(<ProjectRail />);
    const pluginBtn = screen.getByTitle('My Plugin — not annex enabled');
    expect(pluginBtn.className).toContain('cursor-not-allowed');
    expect(pluginBtn.className).toContain('opacity-40');
  });

  it('shows annex-enabled plugins normally when satellite is active host', () => {
    usePluginStore.setState({
      plugins: {
        'canvas': {
          manifest: {
            id: 'canvas',
            name: 'Canvas',
            version: '1.0.0',
            scope: 'dual',
            permissions: ['annex'],
            contributes: {
              railItem: { label: 'Canvas', position: 'top' },
            },
          },
          status: 'activated',
          source: 'builtin',
        } as any,
      },
      appEnabled: ['canvas'],
    });
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1' })],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });
    useRemoteProjectStore.setState({
      pluginMatchState: {
        'sat-1': [
          { id: 'canvas', name: 'Canvas', status: 'matched', annexEnabled: true },
        ],
      },
    });

    render(<ProjectRail />);
    const canvasBtn = screen.getByTitle('Canvas');
    expect(canvasBtn.className).not.toContain('cursor-not-allowed');
    expect(canvasBtn.className).not.toContain('opacity-40');
  });

  it('help and settings are always visible regardless of host mode', () => {
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1' })],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });

    render(<ProjectRail />);
    expect(screen.getByTestId('nav-help')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();
  });
});
