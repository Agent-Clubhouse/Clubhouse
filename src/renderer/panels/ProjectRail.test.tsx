import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { useBadgeStore } from '../stores/badgeStore';
import { useBadgeSettingsStore } from '../stores/badgeSettingsStore';
import { usePluginStore } from '../plugins/plugin-store';
import { ProjectRail } from './ProjectRail';
import type { Project } from '../../shared/types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'test-project',
    path: '/home/user/test-project',
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
