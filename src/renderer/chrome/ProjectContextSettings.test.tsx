import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { ChromeSidebar } from './ChromeSidebar';
import { MainContentView } from '../panels/MainContentView';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useChromeStore } from './chromeStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useChromeFlagStore } from './chromeFlag';
import type { SettingsSubPage } from '../../shared/types';

vi.mock('../app-initializer', () => ({ initApp: async () => () => {} }));
vi.mock('../app-event-bridge', () => ({ initAppEventBridge: () => () => {} }));
vi.mock('../plugins/plugin-loader', () => ({ handleProjectSwitch: async () => {}, getBuiltinProjectPluginIds: () => [], pluginSystemReady: Promise.resolve(), getActiveContext: () => null }));

// The routing destination and actual ProjectSettings/SettingsNav stay real.
// Only terminal rendering is irrelevant to this synthetic settings navigation.
vi.mock('../features/agents/AgentTerminal', () => ({ AgentTerminal: () => null }));
vi.mock('../features/agents/chat/AgentRuntimePane', () => ({ AgentRuntimePane: () => null }));
vi.mock('./sidebar/ChromeAgentDialogs', () => ({ ChromeAgentDialogs: () => null,
  useChromeDialogStore: { getState: () => ({ close: () => {} }) } }));
const projects = [{ id: 'p1', name: 'Alpha', path: '/synthetic/alpha' }, { id: 'p2', name: 'Beta', path: '/synthetic/beta' }];
beforeEach(() => {
  useChromeFlagStore.setState({ enabled: true });
  useProjectStore.setState({ projects, projectsLoaded: true, activeProjectId: 'p1', gitStatus: { p1: true, p2: true }, projectIcons: {} });
  useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: 'agents', settingsContext: 'app', settingsSubPage: 'display', activeHostId: null });
  useAgentStore.setState({ agents: {}, activeAgentId: null, agentSettingsOpenFor: null, loadDurableAgents: vi.fn(async () => {}) });
  useQuickAgentStore.setState({ selectedCompletedId: null, completedAgents: {} });
  usePluginStore.setState({ plugins: {}, appEnabled: [] });
  useChromeStore.setState({ projectSort: 'manual', projectScopeId: null, newAgent: null, pinnedProjectIds: [], inactiveProjectIds: [], collapsedProjectIds: [], expandedFolds: [], idleOpen: true });
});

describe('project menu reaches the actual Settings destination', () => {
  it.each([
    ['app', 'display', 'p1'], ['app', 'display', 'p2'], ['p1', 'notifications', 'p2'], ['p2', 'project', 'p1'],
  ] as Array<[string, SettingsSubPage, string]>)('from %s/%s opens clicked %s General and expands that scope', async (context, page, target) => {
    useUIStore.setState({ settingsContext: context, settingsSubPage: page });
    // Include an inactive target without changing which project is active.
    useChromeStore.setState({ inactiveProjectIds: ['p2'] });
    render(<><ChromeSidebar /><MainContentView /></>);
    fireEvent.click(screen.getByTestId('nav-settings'));
    fireEvent.click(screen.getByTestId(`project-menu-button-${target}`));
    fireEvent.click(screen.getByTestId('project-menu-settings'));
    const project = projects.find((item) => item.id === target)!;
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: project.name })).toBeVisible());
    expect(screen.getByTitle(project.path)).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue(project.name);
    const nav = screen.getByTestId('settings-nav');
    expect(within(nav).getByTestId(`settings-nav-project-${target}`)).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByTestId('settings-nav-project-page-project')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByTestId(`settings-nav-project-${target === 'p1' ? 'p2' : 'p1'}`)).toHaveAttribute('aria-expanded', 'false');
    await act(async () => {});
  });
  it('keeps clicked scope after actual App/ChromeBody project-switch and display-refresh effects settle', async () => {
    useUIStore.setState({ settingsContext: 'app', settingsSubPage: 'orchestrators', projectExplorerTab: { p2: 'plugin:files' } });
    render(<App />);
    fireEvent.click(screen.getByTestId('nav-settings'));
    fireEvent.click(screen.getByTestId('project-menu-button-p2'));
    fireEvent.click(screen.getByTestId('project-menu-settings'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Beta' })).toBeVisible());
    await act(async () => { useProjectStore.getState().setActiveProject('p2'); });
    vi.spyOn(window.clubhouse.project, 'list').mockResolvedValue(projects);
    await act(async () => { await useProjectStore.getState().syncProjectDisplay(); });
    expect(screen.getByRole('heading', { level: 2, name: 'Beta' })).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('Beta');
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'p2', settingsSubPage: 'project' });
    expect(screen.getByTestId('settings-nav-project-p2')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps an unsaved name and editor focus when persisted project order changes', async () => {
    useUIStore.setState({ settingsContext: 'p2', settingsSubPage: 'project' });
    render(<><ChromeSidebar /><MainContentView /></>);
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Unfinished name' } });
    act(() => name.focus());
    vi.spyOn(window.clubhouse.project, 'reorder').mockResolvedValue([projects[1], projects[0]]);

    await act(async () => { await useProjectStore.getState().reorderProjects(['p2', 'p1']); });

    expect(screen.getByLabelText('Name')).toBe(name);
    expect(name).toHaveValue('Unfinished name');
    expect(document.activeElement).toBe(name);
    expect(useUIStore.getState()).toMatchObject({ settingsContext: 'p2', settingsSubPage: 'project' });
    expect(screen.getByTestId('settings-nav-project-p2')).toHaveAttribute('aria-expanded', 'true');
  });
});
