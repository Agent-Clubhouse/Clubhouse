import { render, screen, fireEvent } from '@testing-library/react';
import { Profiler } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useBadgeStore } from '../stores/badgeStore';
import { useBadgeSettingsStore } from '../stores/badgeSettingsStore';
import { usePanelStore } from '../stores/panelStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useAnnexClientStore } from '../stores/annexClientStore';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';
import { useAgentStore } from '../stores/agentStore';
import { ProjectRail } from './ProjectRail';
import { showConfirmDialog } from '../plugins/PluginDialog';
import * as nameGenerator from '../../shared/name-generator';
import type { Agent, AgentDetailedStatus, Project } from '../../shared/types';

vi.mock('../plugins/PluginDialog', () => ({
  showConfirmDialog: vi.fn(() => ({ promise: Promise.resolve(true), cleanup: vi.fn() })),
}));
import type { SatelliteConnection } from '../stores/annexClientStore';

// Mock window.clubhouse.annexClient for SatelliteHostRow retry
const mockAnnexClient = {
  retry: vi.fn(),
};

// Mock the app IPC surface used by the rail's experimental-flag fetch.
// Default: assistant disabled, so the rail renders the Help button (the
// pre-experiment default). Tests can override per-case via vi.spyOn.
const mockApp = {
  getExperimentalSettings: vi.fn(() => Promise.resolve({} as Record<string, boolean>)),
};

vi.stubGlobal('window', {
  ...globalThis.window,
  clubhouse: { ...globalThis.window.clubhouse, annexClient: mockAnnexClient, app: { ...globalThis.window.clubhouse.app, ...mockApp } },
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

  it('scroll container extends into the left padding so the bottom-left activity dot is not clipped', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });

    const { container } = render(<ProjectRail />);
    const scrollContainer = container.querySelector('.overflow-y-auto');
    // pl-2 + -ml-2: icons stay put, but the overflow clip box gains 8px on the left
    expect(scrollContainer!.className).toContain('pl-2');
    expect(scrollContainer!.className).toContain('-ml-2');
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

  it('closes project when Close Project is clicked', async () => {
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

    await vi.waitFor(() => {
      expect(showConfirmDialog).toHaveBeenCalled();
      expect(removeProject).toHaveBeenCalledWith('p1');
    });
  });

  it('does not show context menu initially', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
    });

    render(<ProjectRail />);
    expect(screen.queryByTestId('project-context-menu')).not.toBeInTheDocument();
  });

  it('opens that project\'s settings when Settings is clicked (GH context-menu fix)', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' }), makeProject({ id: 'p2', name: 'Beta' })],
      activeProjectId: 'p2',
    });

    render(<ProjectRail />);
    const projectButton = screen.getByTestId('project-p1');
    fireEvent.contextMenu(projectButton.parentElement!);
    fireEvent.click(screen.getByTestId('ctx-project-settings'));

    const ui = useUIStore.getState();
    expect(ui.explorerTab).toBe('settings');
    // Must scope to the right-clicked project, not the literal string 'project'.
    expect(ui.settingsContext).toBe('p1');
    expect(ui.settingsSubPage).toBe('project');
    // Also makes it the active project.
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
  });
});

describe('ProjectRail store subscriptions', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
  });

  it('does not re-render when only gitStatus/projectIcons change without project list changes', async () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
    });

    const onRender = vi.fn();
    render(
      <Profiler id="project-rail" onRender={onRender}>
        <ProjectRail />
      </Profiler>,
    );

    await vi.waitFor(() => {
      expect(onRender).toHaveBeenCalledTimes(1);
    });

    useProjectStore.setState({ gitStatus: { p1: true } });
    useProjectStore.setState({ projectIcons: { p1: 'data:image/png;base64,abc123' } });

    await vi.waitFor(() => {
      expect(onRender).toHaveBeenCalledTimes(1);
    });
  });

  it('does not re-render other project icons when one project badge changes', async () => {
    useProjectStore.setState({
      projects: [
        makeProject({ id: 'p1', name: 'Alpha', color: 'red' }),
        makeProject({ id: 'p2', name: 'Beta', color: 'blue' }),
      ],
    });

    const getAgentColorHex = vi.spyOn(nameGenerator, 'getAgentColorHex');
    render(<ProjectRail />);
    await vi.waitFor(() => {
      expect(getAgentColorHex).toHaveBeenCalledWith('red');
      expect(getAgentColorHex).toHaveBeenCalledWith('blue');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    getAgentColorHex.mockClear();

    useBadgeStore.getState().setBadge('test', 'dot', 1, {
      kind: 'explorer-tab',
      projectId: 'p1',
      tabId: 'agents',
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId('badge-dot')).toBeInTheDocument();
    });
    expect(getAgentColorHex.mock.calls.map(([color]) => color)).toEqual(['red']);
  });

  it('updates project badges when badge settings change', async () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
    });
    useBadgeStore.getState().setBadge('test', 'dot', 1, {
      kind: 'explorer-tab',
      projectId: 'p1',
      tabId: 'agents',
    });

    render(<ProjectRail />);
    expect(screen.getByTestId('badge-dot')).toBeInTheDocument();

    useBadgeSettingsStore.setState({ projectRailBadges: false });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('badge-dot')).not.toBeInTheDocument();
    });

    useBadgeSettingsStore.setState({ projectRailBadges: true });
    await vi.waitFor(() => {
      expect(screen.getByTestId('badge-dot')).toBeInTheDocument();
    });
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
    expect(onlineDot.className).toContain('bg-ctp-success');
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

  it('shows non-annex plugins as clickable but dimmed when satellite is active host', () => {
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
    const pluginBtn = screen.getByTitle('My Plugin');
    // Button is clickable (navigable) but visually dimmed
    expect(pluginBtn.className).toContain('cursor-pointer');
    expect(pluginBtn.className).toContain('opacity-60');
    expect(pluginBtn.className).not.toContain('cursor-not-allowed');
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

  it('help (default) and settings are always visible regardless of host mode', () => {
    useAnnexClientStore.setState({
      satellites: [makeSatellite({ id: 'sat-1' })],
    });
    useUIStore.setState({ activeHostId: 'sat-1' });

    render(<ProjectRail />);
    // With the assistant flag off (default), the rail shows the Help button.
    expect(screen.getByTestId('nav-help')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Experimental: assistant feature flag tests
// ---------------------------------------------------------------------------

describe('ProjectRail assistant feature flag gating', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
    mockApp.getExperimentalSettings.mockReset();
  });

  it('renders the Help button (and not Assistant) when experimental.assistant is off', async () => {
    mockApp.getExperimentalSettings.mockResolvedValue({});
    render(<ProjectRail />);
    await vi.waitFor(() => {
      expect(screen.getByTestId('nav-help')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('nav-assistant')).not.toBeInTheDocument();
  });

  it('renders the Assistant button (and not Help) when experimental.assistant is on', async () => {
    mockApp.getExperimentalSettings.mockResolvedValue({ assistant: true });
    render(<ProjectRail />);
    await vi.waitFor(() => {
      expect(screen.getByTestId('nav-assistant')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('nav-help')).not.toBeInTheDocument();
  });

  it('falls back to Help when the experimental settings IPC fails', async () => {
    mockApp.getExperimentalSettings.mockRejectedValue(new Error('IPC down'));
    render(<ProjectRail />);
    await vi.waitFor(() => {
      expect(screen.getByTestId('nav-help')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('nav-assistant')).not.toBeInTheDocument();
  });

  it('Help button toggles help mode in the UI store', async () => {
    mockApp.getExperimentalSettings.mockResolvedValue({});
    render(<ProjectRail />);
    const helpBtn = await screen.findByTestId('nav-help');
    fireEvent.click(helpBtn);
    expect(useUIStore.getState().explorerTab).toBe('help');
  });

  it('Assistant button toggles assistant mode when flag is on', async () => {
    mockApp.getExperimentalSettings.mockResolvedValue({ assistant: true });
    render(<ProjectRail />);
    const assistantBtn = await screen.findByTestId('nav-assistant');
    fireEvent.click(assistantBtn);
    expect(useUIStore.getState().explorerTab).toBe('assistant');
  });
});

describe('ProjectRail exitSettingsAndNavigate', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
  });

  it('clicking the active project while in assistant mode restores the previous tab', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
      gitStatus: { p1: true },
    });
    useUIStore.setState({
      explorerTab: 'assistant',
      previousExplorerTab: 'agents',
      showHome: true,
    });

    render(<ProjectRail />);

    fireEvent.click(screen.getByTestId('project-p1'));

    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(useUIStore.getState().previousExplorerTab).toBeNull();
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
  });

  it('clicking a different project while in assistant mode exits assistant and switches project', () => {
    useProjectStore.setState({
      projects: [
        makeProject({ id: 'p1', name: 'Alpha' }),
        makeProject({ id: 'p2', name: 'Beta' }),
      ],
      activeProjectId: 'p1',
      gitStatus: { p1: true, p2: true },
    });
    useUIStore.setState({
      explorerTab: 'assistant',
      previousExplorerTab: 'agents',
      showHome: true,
    });

    render(<ProjectRail />);

    fireEvent.click(screen.getByTestId('project-p2'));

    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(useProjectStore.getState().activeProjectId).toBe('p2');
  });

  it('clicking the active project while in settings mode restores the previous tab', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
      gitStatus: { p1: true },
    });
    useUIStore.setState({
      explorerTab: 'settings',
      previousExplorerTab: 'agents',
      showHome: true,
    });

    render(<ProjectRail />);

    fireEvent.click(screen.getByTestId('project-p1'));

    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(useUIStore.getState().previousExplorerTab).toBeNull();
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
  });

  it('clicking the active project while in help mode restores the previous tab', () => {
    useProjectStore.setState({
      projects: [makeProject({ id: 'p1', name: 'Alpha' })],
      activeProjectId: 'p1',
      gitStatus: { p1: true },
    });
    useUIStore.setState({
      explorerTab: 'help',
      previousExplorerTab: 'agents',
      showHome: true,
    });

    render(<ProjectRail />);

    fireEvent.click(screen.getByTestId('project-p1'));

    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(useUIStore.getState().previousExplorerTab).toBeNull();
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
  });
});

describe('ProjectRail activity indicator and view modes', () => {
  function runningAgent(id: string, projectId: string): Agent {
    return { id, projectId, name: id, kind: 'durable', status: 'running', color: 'emerald' };
  }
  function detail(state: AgentDetailedStatus['state']): AgentDetailedStatus {
    return { state, message: '', timestamp: 0 };
  }
  function renderedProjectIds(): string[] {
    return screen.queryAllByTestId(/^project-(?!view|activity|rail)/).map((el) => el.getAttribute('data-testid')!.replace('project-', ''));
  }

  const reorderProjects = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: () => void) {}
      observe = vi.fn();
      disconnect = vi.fn();
    });
    resetStores();
    reorderProjects.mockClear();
    useUIStore.setState({ projectRailMode: 'all' });
    useProjectStore.setState({
      projects: [
        makeProject({ id: 'p1', name: 'Alpha' }),
        makeProject({ id: 'p2', name: 'Beta' }),
        makeProject({ id: 'p3', name: 'Gamma' }),
      ],
      reorderProjects,
    });
    useAgentStore.setState({
      agents: { a1: runningAgent('a1', 'p2') },
      agentDetailedStatus: {},
    });
  });

  it('shows a green dot only on projects with a running agent', () => {
    render(<ProjectRail />);
    const beta = screen.getByTestId('project-p2');
    expect(beta.querySelector('[data-testid="project-activity-indicator"]')).toHaveAttribute('data-level', 'running');
    expect(screen.getByTestId('project-p1').querySelector('[data-testid="project-activity-indicator"]')).toBeNull();
    expect(beta).toHaveAttribute('aria-label', 'Beta — 1 running agent');
  });

  it('does not show a dot for sleeping agents', () => {
    useAgentStore.setState({ agents: { a1: { ...runningAgent('a1', 'p2'), status: 'sleeping' } } });
    render(<ProjectRail />);
    expect(screen.queryByTestId('project-activity-indicator')).toBeNull();
  });

  it('pulses while working and turns amber when an agent needs permission', () => {
    useAgentStore.setState({
      agents: { a1: runningAgent('a1', 'p2'), a2: runningAgent('a2', 'p3'), a3: runningAgent('a3', 'p3') },
      agentDetailedStatus: { a1: detail('working'), a2: detail('working'), a3: detail('needs_permission') },
    });
    render(<ProjectRail />);
    const working = screen.getByTestId('project-p2').querySelector('[data-testid="project-activity-indicator"]')!;
    const permission = screen.getByTestId('project-p3').querySelector('[data-testid="project-activity-indicator"]')!;
    expect(working).toHaveAttribute('data-level', 'working');
    expect(working.innerHTML).toContain('motion-safe:animate-pulse');
    expect(permission).toHaveAttribute('data-level', 'needs_permission');
    expect(permission.textContent).toBe('!');
  });

  it('all: keeps manual order', () => {
    render(<ProjectRail />);
    expect(renderedProjectIds()).toEqual(['p1', 'p2', 'p3']);
  });

  it('active-first: moves active projects to the top without persisting a reorder', () => {
    useUIStore.setState({ projectRailMode: 'active-first' });
    render(<ProjectRail />);
    expect(renderedProjectIds()).toEqual(['p2', 'p1', 'p3']);
    expect(reorderProjects).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('active-only: hides inactive projects but keeps the selected one', () => {
    useUIStore.setState({ projectRailMode: 'active-only' });
    useProjectStore.setState({ activeProjectId: 'p3' });
    render(<ProjectRail />);
    expect(renderedProjectIds()).toEqual(['p2', 'p3']);
  });

  it('active-only with nothing running shows an empty state that restores all', () => {
    useUIStore.setState({ projectRailMode: 'active-only' });
    useAgentStore.setState({ agents: {} });
    render(<ProjectRail />);
    expect(renderedProjectIds()).toEqual([]);
    fireEvent.click(screen.getByTestId('project-rail-empty-active'));
    expect(useUIStore.getState().projectRailMode).toBe('all');
    expect(renderedProjectIds()).toEqual(['p1', 'p2', 'p3']);
  });

  it('drag reorder works in all but is disabled in sorted/filtered views', () => {
    const { unmount } = render(<ProjectRail />);
    let rows = screen.getAllByTestId(/^project-p/).map((el) => el.parentElement!);
    expect(rows[0]).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(rows[0], { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    fireEvent.drop(rows[2], { dataTransfer: {} });
    expect(reorderProjects).toHaveBeenCalledWith(['p2', 'p3', 'p1']);
    unmount();

    reorderProjects.mockClear();
    useUIStore.setState({ projectRailMode: 'active-first' });
    render(<ProjectRail />);
    rows = screen.getAllByTestId(/^project-p/).map((el) => el.parentElement!);
    expect(rows[0]).toHaveAttribute('draggable', 'false');
    fireEvent.dragStart(rows[0], { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    fireEvent.drop(rows[2], { dataTransfer: {} });
    expect(reorderProjects).not.toHaveBeenCalled();
  });

  it('view menu switches modes and persists the choice', () => {
    render(<ProjectRail />);
    fireEvent.click(screen.getByTestId('project-view-button'));
    expect(screen.getByTestId('project-view-all')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('project-view-active-first'));
    expect(useUIStore.getState().projectRailMode).toBe('active-first');
    expect(screen.queryByTestId('project-view-menu')).toBeNull();
    expect(renderedProjectIds()).toEqual(['p2', 'p1', 'p3']);
  });

  it('view menu closes on Escape and returns focus to its button', () => {
    render(<ProjectRail />);
    const button = screen.getByTestId('project-view-button');
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByTestId('project-view-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('project-view-menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  describe('satellite projects', () => {
    const nsP1 = 'remote||sat-1||p1';
    const nsP2 = 'remote||sat-1||p2';

    beforeEach(() => {
      useAgentStore.setState({ agents: {} });
      useUIStore.setState({ activeHostId: 'sat-1', projectRailMode: 'active-only' });
      useRemoteProjectStore.setState({
        satelliteProjects: {
          'ab:cd:ef': [
            { ...makeProject({ id: nsP1, name: 'Remote One' }), remote: true, satelliteId: 'sat-1', satelliteName: 'Office Mac' },
            { ...makeProject({ id: nsP2, name: 'Remote Two' }), remote: true, satelliteId: 'sat-1', satelliteName: 'Office Mac' },
          ],
        },
        remoteAgents: { 'remote||sat-1||a1': runningAgent('remote||sat-1||a1', nsP2) },
        remoteAgentDetailedStatus: {},
      });
    });

    it('shows dots and applies the view mode for a connected satellite', () => {
      useAnnexClientStore.setState({ satellites: [makeSatellite({ id: 'sat-1', state: 'connected' })] });
      render(<ProjectRail />);
      expect(renderedProjectIds()).toEqual([nsP2]);
      expect(screen.getByTestId(`project-${nsP2}`).querySelector('[data-testid="project-activity-indicator"]')).not.toBeNull();
    });

    it('shows all cached projects without dots when the satellite is disconnected', () => {
      useAnnexClientStore.setState({ satellites: [makeSatellite({ id: 'sat-1', state: 'disconnected' })] });
      render(<ProjectRail />);
      expect(renderedProjectIds()).toEqual([nsP1, nsP2]);
      expect(screen.queryByTestId('project-activity-indicator')).toBeNull();
    });
  });
});
