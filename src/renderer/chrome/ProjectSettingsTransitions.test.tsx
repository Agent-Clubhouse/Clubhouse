import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useAnnexClientStore } from '../stores/annexClientStore';
import { namespacedProjectId, useRemoteProjectStore } from '../stores/remoteProjectStore';
import { useChromeStore } from './chromeStore';
import { useChromeFlagStore } from './chromeFlag';
import { handleProjectSwitch } from '../plugins/plugin-loader';
import type { LaunchWrapperConfig, Project, SatelliteSnapshot } from '../../shared/types';

vi.mock('../app-initializer', () => ({ initApp: async () => () => {} }));
vi.mock('../app-event-bridge', () => ({ initAppEventBridge: () => () => {} }));
vi.mock('../plugins/plugin-loader', () => ({ handleProjectSwitch: vi.fn(async () => {}), getBuiltinProjectPluginIds: () => [], pluginSystemReady: Promise.resolve(), getActiveContext: () => null }));
vi.mock('../features/agents/AgentTerminal', () => ({ AgentTerminal: () => null }));
vi.mock('../features/agents/chat/AgentRuntimePane', () => ({ AgentRuntimePane: () => null }));
vi.mock('./sidebar/ChromeAgentDialogs', () => ({ ChromeAgentDialogs: () => null }));

const projects: Project[] = [{ id: 'p1', name: 'Alpha', path: '/synthetic/alpha' }, { id: 'p2', name: 'Beta', path: '/synthetic/beta' }];
const snapshot: SatelliteSnapshot = { projects, agents: {}, quickAgents: {}, theme: null, orchestrators: null, pendingPermissions: [], lastSeq: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function openProjectMenu(target: string) {
  fireEvent.contextMenu(screen.getByTestId(`project-${target}`), { clientX: 50, clientY: 50 });
  fireEvent.click(screen.getByTestId('project-menu-settings'));
}

async function expectProject(target: string) {
  const project = projects.find((p) => p.id === target)!;
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: project.name })).toBeVisible());
  expect(screen.getByTitle(project.path)).toBeVisible();
  expect(screen.getByLabelText('Name')).toHaveValue(project.name);
  expect(screen.getByTestId(`settings-nav-project-${target}`)).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByTestId('settings-nav-project-page-project')).toHaveAttribute('aria-current', 'page');
  expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: target, settingsSubPage: 'project' });
}

beforeEach(() => {
  localStorage.clear();
  useChromeFlagStore.setState({ enabled: true });
  useProjectStore.setState({ projects, projectsLoaded: true, activeProjectId: 'p1', gitStatus: { p1: true, p2: true }, projectIcons: {} });
  useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: 'agents', settingsContext: 'app', settingsSubPage: 'display', activeHostId: null, projectExplorerTab: {}, dispatcherOpen: false });
  useAgentStore.setState({ agents: {}, activeAgentId: null, agentSettingsOpenFor: null, projectActiveAgent: {}, loadDurableAgents: vi.fn(async () => {}) });
  useQuickAgentStore.setState({ selectedCompletedId: null, completedAgents: {} });
  usePluginStore.setState({ plugins: {}, appEnabled: [], projectEnabled: {} });
  useChromeStore.setState({ sidebarCollapsed: false, lastProjectId: null, projectSort: 'manual', projectScopeId: null, newAgent: null, pinnedProjectIds: [], inactiveProjectIds: [], collapsedProjectIds: [], expandedFolds: [], idleOpen: true });
  useAnnexClientStore.setState({ satellites: [], satellitePaused: {} });
  useRemoteProjectStore.setState({ satelliteProjects: {}, remoteAgents: {}, remoteAgentDetailedStatus: {}, remoteProjectIcons: {}, pluginMatchState: {} });
});

describe('project Settings destination triage (#2854)', () => {
  it.each(['p1', 'p2'])('right-click opens %s while old project plugin config and project reload are pending', async (target) => {
    const config = deferred<undefined>();
    const listing = deferred<Project[]>();
    vi.spyOn(window.clubhouse.plugin, 'storageRead').mockReturnValue(config.promise);
    vi.spyOn(window.clubhouse.project, 'list').mockReturnValue(listing.promise);
    render(<App />);
    await waitFor(() => expect(window.clubhouse.plugin.storageRead).toHaveBeenCalled());
    let reload!: Promise<void>;
    act(() => { reload = useProjectStore.getState().loadProjects(); });
    fireEvent.click(screen.getByTestId('nav-settings'));
    openProjectMenu(target);
    await expectProject(target);
    await act(async () => { config.resolve(undefined); });
    await waitFor(() => expect(handleProjectSwitch).toHaveBeenCalled());
    await act(async () => { listing.resolve(projects.map((p) => ({ ...p }))); await reload; });
    await expectProject(target);
  });

  it('opens local Settings after a satellite visit and keeps it through a late satellite snapshot', async () => {
    useAnnexClientStore.setState({ satellites: [{ id: 'sat', alias: 'Synthetic satellite', icon: '', color: 'blue', fingerprint: 'sat', state: 'connected', host: 'synthetic.invalid', mainPort: 1, pairingPort: 2, snapshot, lastError: null }] });
    useRemoteProjectStore.getState().applySatelliteSnapshot('sat', 'Synthetic satellite', snapshot);
    useProjectStore.setState({ activeProjectId: namespacedProjectId('sat', 'p1') });
    useUIStore.setState({ activeHostId: 'sat' });
    render(<App />);
    fireEvent.click(screen.getByTestId('nav-settings'));
    fireEvent.contextMenu(screen.getByTestId(`project-${namespacedProjectId('sat', 'p1')}`));
    expect(screen.queryByTestId('project-menu-settings')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('host-switcher'));
    fireEvent.click(screen.getByTestId('host-menu-local'));
    openProjectMenu('p2');
    await expectProject('p2');
    await act(async () => { useRemoteProjectStore.getState().applySatelliteSnapshot('sat', 'Synthetic satellite', { ...snapshot, lastSeq: 2 }); });
    await expectProject('p2');
    expect(useUIStore.getState().activeHostId).toBeNull();
  });
});

describe('adjacent project wrapper state isolation', () => {
  it('does not display an old project wrapper when its pending read finishes after another scope opens', async () => {
    const oldWrapper = deferred<LaunchWrapperConfig | undefined>();
    vi.spyOn(window.clubhouse.project, 'readLaunchWrapper').mockImplementation((path) => path === projects[0].path
      ? oldWrapper.promise : Promise.resolve(undefined));
    useUIStore.setState({ settingsContext: 'p1', settingsSubPage: 'project' });
    render(<App />);
    await waitFor(() => expect(window.clubhouse.project.readLaunchWrapper).toHaveBeenCalledWith(projects[0].path));
    fireEvent.click(screen.getByTestId('settings-nav-project-p2'));
    await expectProject('p2');
    await waitFor(() => expect(window.clubhouse.project.readLaunchWrapper).toHaveBeenCalledWith(projects[1].path));
    await screen.findByText('No launch wrapper configured. A plugin can set one up automatically.');
    await act(async () => { oldWrapper.resolve({ binary: '/synthetic/alpha-wrapper', separator: '--', orchestratorMap: {} }); });
    await expectProject('p2');
    expect(screen.queryByText('/synthetic/alpha-wrapper')).toBeNull();
  });

  it('keeps a pending wrapper removal on its captured project after another scope opens', async () => {
    const removal = deferred<void>();
    const alpha = { binary: '/synthetic/alpha-wrapper', separator: '--', orchestratorMap: {} };
    const beta = { binary: '/synthetic/beta-wrapper', separator: '--', orchestratorMap: {} };
    vi.spyOn(window.clubhouse.project, 'readLaunchWrapper').mockImplementation(async (path) => path === projects[0].path ? alpha : beta);
    const writeWrapper = vi.spyOn(window.clubhouse.project, 'writeLaunchWrapper').mockReturnValue(removal.promise);
    const writeCatalog = vi.spyOn(window.clubhouse.project, 'writeMcpCatalog');
    const writeDefaults = vi.spyOn(window.clubhouse.project, 'writeDefaultMcps');
    const writeSnapshot = vi.spyOn(window.clubhouse.project, 'writeWrapperCatalogSnapshot');
    useUIStore.setState({ settingsContext: 'p1', settingsSubPage: 'project' });
    render(<App />);
    await screen.findByText(alpha.binary);
    fireEvent.click(screen.getByTestId('remove-wrapper-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove wrapper', exact: true }));
    await waitFor(() => expect(writeWrapper).toHaveBeenCalledWith(projects[0].path, undefined));
    fireEvent.click(screen.getByTestId('settings-nav-project-p2'));
    await screen.findByText(beta.binary);
    await act(async () => { removal.resolve(); });
    await expectProject('p2');
    expect(screen.getByText(beta.binary)).toBeVisible();
    expect(writeWrapper.mock.calls).toEqual([[projects[0].path, undefined]]);
    expect(writeCatalog.mock.calls).toEqual([[projects[0].path, []]]);
    expect(writeDefaults.mock.calls).toEqual([[projects[0].path, []]]);
    expect(writeSnapshot.mock.calls).toEqual([[projects[0].path, undefined]]);
  });
});
