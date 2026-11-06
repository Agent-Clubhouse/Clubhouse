import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { requestCloseProject } from './close-project';
import { ChromeSidebar } from '../../chrome/ChromeSidebar';
import { ProjectRail } from '../../panels/ProjectRail';
import { ProjectSettings } from '../settings/ProjectSettings';
import { showConfirmDialog } from '../../plugins/PluginDialog';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { useAgentStore } from '../../stores/agentStore';
import { useChromeStore } from '../../chrome/chromeStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { useToastStore } from '../../stores/toastStore';
import type { Agent } from '../../../shared/types';

vi.mock('../../plugins/PluginDialog', () => ({ showConfirmDialog: vi.fn() }));
const projects = [
  { id: 'p1', name: 'Alpha', path: '/synthetic/alpha' },
  { id: 'p2', name: 'Beta', path: '/synthetic/beta' },
];
const agents: Record<string, Agent> = {
  a: { id: 'a', projectId: 'p1', name: 'a', kind: 'durable', status: 'running', color: 'blue' },
  b: { id: 'b', projectId: 'p2', name: 'b', kind: 'quick', status: 'running', color: 'blue' },
};
const realRemoveProject = useProjectStore.getState().removeProject;

beforeEach(() => {
  useProjectStore.setState({ projects, activeProjectId: 'p1', projectIcons: {}, gitStatus: { p1: true, p2: true }, removeProject: realRemoveProject });
  useUIStore.setState({ explorerTab: 'agents', previousExplorerTab: null, activeHostId: null, settingsContext: 'app' });
  useAgentStore.setState({ agents, activeAgentId: null, agentSettingsOpenFor: null });
  useChromeStore.setState({ projectSort: 'manual', pinnedProjectIds: [], inactiveProjectIds: [], projectScopeId: null, collapsedProjectIds: [], idleDays: 0 });
  usePluginStore.setState({ plugins: {}, appEnabled: [] });
  useToastStore.setState({ toasts: [] });
  vi.spyOn(window.clubhouse.project, 'remove').mockResolvedValue(undefined);
  vi.spyOn(window.clubhouse.project, 'resetProject');
  vi.spyOn(window.clubhouse.agent, 'killAgent');
  vi.spyOn(window.clubhouse.pty, 'kill');
  vi.mocked(showConfirmDialog).mockReturnValue({ promise: Promise.resolve(true), cleanup: vi.fn() });
});

function openClose(surface: 'sidebar' | 'classic' | 'settings') {
  if (surface === 'sidebar') {
    render(<ChromeSidebar />);
    fireEvent.click(screen.getByTestId('project-menu-button-p2'));
    fireEvent.click(screen.getByTestId('project-menu-close-project'));
  } else if (surface === 'classic') {
    render(<ProjectRail />);
    fireEvent.contextMenu(screen.getByTestId('project-p2').parentElement!);
    fireEvent.click(screen.getByTestId('ctx-close-project'));
  } else {
    useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: 'agents', settingsContext: 'p2', settingsSubPage: 'project' });
    render(<ProjectSettings projectId="p2" />);
    fireEvent.click(screen.getByText('Close…'));
  }
}

describe('shared non-destructive Close project', () => {
  it.each(['sidebar', 'classic', 'settings'] as const)('%s confirms and unregisters the clicked project while preserving running agents/files', async (surface) => {
    openClose(surface);
    await waitFor(() => expect(window.clubhouse.project.remove).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(useProjectStore.getState().projects.map((item) => item.id)).toEqual(['p1']));
    expect(showConfirmDialog).toHaveBeenCalledWith('Close this project? Project-specific settings may need to be reconfigured.');
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    expect(useAgentStore.getState().agents).toEqual(agents);
    expect(window.clubhouse.project.resetProject).not.toHaveBeenCalled();
    expect(window.clubhouse.agent.killAgent).not.toHaveBeenCalled();
    expect(window.clubhouse.pty.kill).not.toHaveBeenCalled();
    await act(async () => {});
  });
  it.each(['sidebar', 'classic', 'settings'] as const)('%s cancellation leaves registration, settings and running agents untouched', async (surface) => {
    vi.mocked(showConfirmDialog).mockReturnValue({ promise: Promise.resolve(false), cleanup: vi.fn() });
    openClose(surface);
    await act(async () => {});
    expect(window.clubhouse.project.remove).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects).toEqual(projects);
    expect(useAgentStore.getState().agents).toEqual(agents);
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    expect(useUIStore.getState().explorerTab).toBe(surface === 'settings' ? 'settings' : 'agents');
  });
  it('keeps the captured project when selection changes during confirmation', async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(showConfirmDialog).mockReturnValue({ promise: new Promise((done) => { resolve = done; }), cleanup: vi.fn() });
    useProjectStore.setState({ activeProjectId: 'p2' });
    const close = requestCloseProject('p2');
    useProjectStore.setState({ activeProjectId: 'p1' });
    resolve(true);
    expect(await close).toBe(true);
    expect(window.clubhouse.project.remove).toHaveBeenCalledWith('p2');
    expect(useProjectStore.getState().projects.map((item) => item.id)).toEqual(['p1']);
  });
  it('shows a fixed failure and keeps registration on rejected removal', async () => {
    vi.spyOn(window.clubhouse.project, 'remove').mockRejectedValue(new Error('private path'));
    expect(await requestCloseProject('p2')).toBe(false);
    expect(useProjectStore.getState().projects).toEqual(projects);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Could not close the project. Try again.');
  });

  it.each(['agents', 'other-project-settings'] as const)('does not navigate after pending removal when the user chooses %s', async (destination) => {
    let resolve!: () => void;
    vi.spyOn(window.clubhouse.project, 'remove').mockImplementation(() => new Promise((done) => { resolve = done; }));
    openClose('settings');
    await waitFor(() => expect(window.clubhouse.project.remove).toHaveBeenCalledWith('p2'));
    expect(useUIStore.getState().explorerTab).toBe('agents');
    act(() => {
      if (destination === 'other-project-settings') useUIStore.getState().openProjectSettings('p1');
      else useUIStore.getState().setExplorerTab('agents');
    });
    await act(async () => { resolve(); });
    expect(useUIStore.getState().explorerTab).toBe(destination === 'agents' ? 'agents' : 'settings');
    if (destination === 'other-project-settings') {
      expect(useUIStore.getState()).toMatchObject({ settingsContext: 'p1', settingsSubPage: 'project' });
    }
    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(['p1']);
  });

  it('does not close another settings scope opened during confirmation', async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(showConfirmDialog).mockReturnValue({ promise: new Promise((done) => { resolve = done; }), cleanup: vi.fn() });
    openClose('settings');
    act(() => useUIStore.getState().openProjectSettings('p1'));
    await act(async () => { resolve(true); });
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'p1', settingsSubPage: 'project' });
    expect(window.clubhouse.project.remove).toHaveBeenCalledWith('p2');
  });
});
