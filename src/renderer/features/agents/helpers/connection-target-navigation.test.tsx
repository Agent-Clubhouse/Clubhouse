import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Project } from '../../../../shared/types';
import type { CanvasNavigationSnapshot, CanvasPopoutReveal, CanvasPopoutRevealResult, GroupProjectNavigationIndex } from '../../../../shared/canvas-index-types';
import type { PluginAPI, ScopedStorage } from '../../../../shared/plugin-types';
import { getProjectCanvasStore, MainPanel, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasInstanceData, CanvasView } from '../../../plugins/builtin/canvas/canvas-types';
import { consumeCanvasNavigationHandoff, getCanvasNavigationHandoff, viewStructure } from '../../../plugins/builtin/canvas/canvas-navigation-handoff';
import { applyCanvasMutation } from '../../../plugins/builtin/canvas/canvas-sync';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { usePluginStore } from '../../../plugins/plugin-store';
import { ConnectionOpenAction } from './ConnectionOpenAction';
import { ConnectionsCard } from './ConnectionsCard';
import { beginConnectionNavigationRequest, jumpToConnectionCanvas, mergeTargetCanvasHits, openConnectionAgent } from './connection-target-navigation';
import { manifest as browserManifest } from '../../../plugins/builtin/browser/manifest';
import { PopoutCanvasView } from '../../popout/PopoutCanvasView';
import { ChromeBody } from '../../../chrome/ChromeBody';
import { useChromeStore } from '../../../chrome/chromeStore';
import { useChromeFlagStore } from '../../../chrome/chromeFlag';
import { useAgentDetailsStore } from '../details/detailsStore';
import { resetChatFlag } from '../chat/chat-flag';
import { activatePlugin, _resetActiveContexts } from '../../../plugins/plugin-loader';
import { manifest as canvasManifest } from '../../../plugins/builtin/canvas/manifest';

vi.mock('../../../chrome/ChromeSidebar', () => ({ ChromeSidebar: () => null }));
vi.mock('../../../chrome/sidebar/ChromeAgentDialogs', () => ({ ChromeAgentDialogs: () => null }));
vi.mock('../../dispatcher/useDispatcherSync', () => ({ useDispatcherSync: () => {} }));
vi.mock('../AgentTerminal', () => ({ AgentTerminal: () => <div data-testid="navigation-terminal" /> }));

const projects: Project[] = [
  { id: 'nav-one', name: 'Same project name', path: '/nav/one' },
  { id: 'nav-two', name: 'Same project name', path: '/nav/two' },
];
const lead: Agent = { id: 'lead', projectId: 'nav-one', name: 'Lead', kind: 'durable', status: 'running', color: 'teal' };
const groupProject = { id: 'gp_actual', name: 'Renamed project', description: '', instructions: '', createdAt: 'today', metadata: {} };
const hit = { scope: 'project' as const, projectId: 'nav-two', projectName: 'Renamed project folder', canvasId: 'board', name: 'Renamed Canvas', viewId: 'node', nodeName: 'Renamed project' };
const groupView = (id = 'node', groupProjectId = 'gp_actual'): CanvasView => ({
  id, type: 'plugin', pluginId: 'group-project', pluginWidgetType: 'plugin:group-project:group-project',
  title: 'Renamed project', displayName: 'Renamed project', metadata: { groupProjectId },
  position: { x: 5000, y: 6000 }, size: { width: 400, height: 300 }, zIndex: 1,
});
const board = (id = 'board', views: CanvasView[] = [groupView()]): CanvasInstanceData => ({
  id, name: 'Renamed Canvas', views, viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: views.length,
});
const indexed = (): GroupProjectNavigationIndex => ({
  stores: [
    { scope: 'app', hits: [] },
    { scope: 'project', projectId: 'nav-one', projectName: 'Same project name', hits: [] },
    { scope: 'project', projectId: 'nav-two', projectName: hit.projectName, hits: [hit] },
  ],
  groupProjects: [groupProject],
});
const snapshot = (): CanvasNavigationSnapshot => ({
  canvases: [board('other', []), board()],
  wires: [{ agentId: 'sleeping', targetId: 'gp_actual', targetKind: 'group-project', label: 'Suspended wire' }],
  zoneWires: [],
  groupProjects: [groupProject],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function panelApi(data: CanvasNavigationSnapshot): { api: PluginAPI; storage: ScopedStorage } {
  const map = new Map<string, unknown>([
    ['canvas-instances', data.canvases], ['canvas-wires', data.wires], ['canvas-zone-wires', data.zoneWires],
  ]);
  const storage: ScopedStorage = {
    read: vi.fn(async (key) => map.get(key)),
    write: vi.fn(async (key, value) => { map.set(key, value); }),
    delete: vi.fn(async (key) => { map.delete(key); }),
    list: vi.fn(async () => [...map.keys()]),
  };
  const api = {
    context: { mode: 'project', projectId: 'nav-two', projectPath: '/nav/two' },
    storage: { global: storage, projectLocal: storage, project: storage },
    agents: { list: () => [], onAnyChange: () => ({ dispose: () => {} }), getDetailedStatus: () => null },
    projects: { list: () => projects },
    window: { setTitle: vi.fn(), resetTitle: vi.fn() },
    widgets: { AgentAvatar: () => null, AgentTerminal: () => null, SleepingAgent: () => null },
    settings: { get: () => undefined, getAll: () => ({}), set: vi.fn(), onChange: () => ({ dispose: () => {} }) },
  } as PluginAPI;
  return { api, storage };
}

async function registerNavigationPanels() {
  const plugins = usePluginStore.getState();
  plugins.registerPlugin(canvasManifest, 'builtin', '/builtin/canvas', 'activated');
  plugins.setPluginModule('canvas', { MainPanel });
  await activatePlugin('canvas');
  await activatePlugin('canvas', 'nav-two', '/nav/two');
  useChromeFlagStore.setState({ enabled: true });
  useChromeStore.setState({ sidebarCollapsed: true, projectScopeId: null, newAgent: null });
  useAgentDetailsStore.setState({ open: true, settingsOpen: false, focus: { agentId: lead.id, card: 'connections', nonce: 1 } });
  window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ chat: false }));
  resetChatFlag();
}

function dragCanvasView(container: HTMLElement, viewId: string, dx: number, dy: number) {
  const titlebar = within(within(container).getByTestId(`canvas-view-${viewId}`)).getByTestId('canvas-view-titlebar');
  fireEvent.mouseDown(titlebar, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: dx, clientY: dy });
  fireEvent.mouseUp(window);
}

beforeEach(() => {
  useProjectStore.setState({ projects, activeProjectId: 'nav-one', projectsLoaded: true, gitStatus: { 'nav-one': false, 'nav-two': false } });
  useUIStore.setState({ explorerTab: 'agents', activeHostId: null, dispatcherOpen: false });
  useAgentStore.setState({ agents: { lead }, activeAgentId: lead.id });
  useMcpBindingStore.setState({ bindings: [] });
  useGroupProjectStore.setState({ projects: [], loaded: false, loadError: null });
  _resetActiveContexts();
  usePluginStore.setState({ plugins: {}, modules: {}, pluginSettings: {}, appEnabled: [], projectEnabled: {} });
  for (const store of [useAppCanvasStore, ...projects.map((project) => getProjectCanvasStore(project.id))]) {
    const handoff = getCanvasNavigationHandoff(store);
    if (handoff) consumeCanvasNavigationHandoff(store, handoff);
    store.setState({ canvases: [], views: [], loaded: false, dataOrigin: null, wiresLoaded: false, selectedViewId: null, wireDefinitions: [], zoneWireDefinitions: [] });
  }
  window.clubhouse.canvas.getTargetCanvases = vi.fn(async () => indexed());
  window.clubhouse.canvas.readForNavigation = vi.fn(async () => snapshot());
  window.clubhouse.canvas.resolveAgentTarget = vi.fn(async () => ({
    project: projects[1], config: { id: 'actual-agent', name: 'Renamed agent', color: 'teal', createdAt: 'today' },
  }));
  window.clubhouse.window.listPopouts = vi.fn(async () => []);
  window.clubhouse.window.onCanvasPopoutReveal = vi.fn(() => () => {});
  window.clubhouse.window.onCanvasPopoutRevealCanceled = vi.fn(() => () => {});
  window.clubhouse.window.canvasPopoutRevealed = vi.fn();
  window.clubhouse.window.cancelCanvasPopoutReveal = vi.fn();
  window.clubhouse.window.onCanvasStateChanged = vi.fn(() => () => {});
  window.clubhouse.window.broadcastCanvasState = vi.fn();
  window.clubhouse.window.sendCanvasMutation = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  _resetActiveContexts();
  useChromeFlagStore.setState({ enabled: false });
  useAgentDetailsStore.setState({ open: false, focus: null });
  vi.useRealTimers();
});

describe('connection Open navigation', () => {
  it('opens exact same/cross-project agent IDs missing from the rail, and gives a retryable unavailable state rather than a name match', async () => {
    const sameName: Agent = { ...lead, id: 'wrong-id', name: 'Renamed agent' };
    useAgentStore.setState({ agents: { lead, 'wrong-id': sameName } });
    await openConnectionAgent('actual-agent', beginConnectionNavigationRequest().signal);
    expect(useProjectStore.getState().activeProjectId).toBe('nav-two');
    expect(useAgentStore.getState().activeAgentId).toBe('actual-agent');
    expect(useAgentStore.getState().agents['actual-agent'].projectId).toBe('nav-two');
    vi.mocked(window.clubhouse.canvas.resolveAgentTarget).mockResolvedValue({
      project: projects[0], config: { id: 'same-project', name: 'Renamed again', color: 'teal', createdAt: 'today' },
    });
    await openConnectionAgent('same-project', beginConnectionNavigationRequest().signal);
    expect(useProjectStore.getState().activeProjectId).toBe('nav-one');
    expect(useAgentStore.getState().activeAgentId).toBe('same-project');
    vi.mocked(window.clubhouse.canvas.resolveAgentTarget).mockResolvedValue({ error: 'Agent unavailable. Restore its original project and retry Open.' });
    render(<ConnectionOpenAction targetId="deleted-id" targetKind="agent" name="Renamed agent" projectId="nav-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Restore its original project');
    expect(screen.getByRole('button', { name: 'Retry Open' })).toBeEnabled();
    expect(useAgentStore.getState().activeAgentId).toBe('same-project');
  });

  it('waits for unvisited persisted hydration, then focuses/reveals the real node without writes or reconnecting inactive wires; explicit edits and manual reopening still work', async () => {
    const data: CanvasNavigationSnapshot = {
      ...snapshot(),
      wires: [...snapshot().wires, { agentId: 'edit-sleeper', targetId: 'gp_actual', targetKind: 'group-project', label: 'Edited board wire' }],
      canvases: [board('other', []), board('board', [
        groupView(),
        {
          id: 'zone', type: 'zone', title: 'Zone', displayName: 'Zone', metadata: {}, themeId: 'catppuccin-mocha',
          position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, zIndex: 0, containedViewIds: ['zone-agent'],
        },
        {
          id: 'zone-agent', type: 'agent', agentId: 'zone-sleeper', title: 'Zone member', displayName: 'Zone member', metadata: {},
          position: { x: 50, y: 50 }, size: { width: 200, height: 200 }, zIndex: 1,
        },
      ])],
      zoneWires: [{ id: 'zone-wire', sourceZoneId: 'zone', targetId: 'gp_actual', targetType: 'group-project' }],
    };
    const loading = deferred<CanvasNavigationSnapshot>();
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockReturnValue(loading.promise);
    const store = getProjectCanvasStore('nav-two');
    const focus = vi.spyOn(store.getState(), 'focusView');
    const create = vi.spyOn(store.getState(), 'addCanvas');
    const remove = vi.spyOn(store.getState(), 'removeCanvas');
    const bind = vi.spyOn(window.clubhouse.mcpBinding, 'bind');
    const unbind = vi.spyOn(window.clubhouse.mcpBinding, 'unbind');
    const projectCreate = vi.spyOn(window.clubhouse.project, 'add');
    const groupCreate = vi.spyOn(window.clubhouse.groupProject, 'create');
    const policy = vi.spyOn(window.clubhouse.agent, 'setOrchestrationPolicy');
    let onAwoke: ((agentId: string) => void) | undefined;
    vi.spyOn(window.clubhouse.agent, 'onAgentAwoke').mockImplementation((callback) => {
      onAwoke = callback;
      return () => {};
    });
    const { api, storage } = panelApi(data);
    const card = render(<ConnectionOpenAction targetId="gp_actual" targetKind="group-project" name="Old project name" projectId="nav-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(window.clubhouse.canvas.readForNavigation).toHaveBeenCalledWith('group-project', 'gp_actual', 'nav-two'));
    expect(focus).not.toHaveBeenCalled();
    expect(store.getState().loaded).toBe(false);
    expect(useUIStore.getState().explorerTab).toBe('agents');
    await act(async () => { loading.resolve(data); });
    await waitFor(() => expect(useUIStore.getState().explorerTab).toBe('plugin:canvas'));
    expect(store.getState().activeCanvasId).toBe('board');
    expect(store.getState().selectedViewId).toBe('node');
    expect(focus).toHaveBeenCalledWith('node');
    card.unmount();
    vi.useFakeTimers();
    const panel = render(<MainPanel api={api} />);
    expect(screen.getByTestId('canvas-workspace')).toBeInTheDocument();
    expect(store.getState().viewport).toEqual({ panX: -4800, panY: -5850, zoom: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    for (const mutation of [bind, unbind, create, remove, projectCreate, groupCreate, policy]) expect(mutation).not.toHaveBeenCalled();
    expect(useMcpBindingStore.getState().bindings).toEqual([]);
    expect(useGroupProjectStore.getState().projects[0].metadata).toEqual({});

    await act(async () => { onAwoke?.('sleeping'); });
    expect(bind).toHaveBeenCalledWith('sleeping', expect.objectContaining({ targetId: 'gp_actual' }));
    bind.mockClear();
    act(() => { store.getState().moveView('node', { x: 5200, y: 6200 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(storage.write).toHaveBeenCalledWith('canvas-instances', expect.any(Array));
    expect(bind).toHaveBeenCalledWith('edit-sleeper', expect.objectContaining({ targetId: 'gp_actual' }));
    expect(bind).toHaveBeenCalledWith('zone-sleeper', expect.objectContaining({ targetId: 'gp_actual' }));
    panel.unmount();
    const manualLoad = vi.spyOn(store.getState(), 'loadCanvas');
    const manualWires = vi.spyOn(store.getState(), 'loadWires');
    await act(async () => { render(<MainPanel api={api} />); });
    expect(manualLoad).toHaveBeenCalledWith(storage);
    expect(manualWires).toHaveBeenCalledWith(storage);
  });

  it('offers labeled Home/project/Canvas/node choices, revalidates the selected ID, and explains no owner or incomplete lookup', async () => {
    const multiple = indexed();
    multiple.stores[0].hits = [{ ...hit, canvasId: 'home-board', viewId: 'home-node' }];
    vi.mocked(window.clubhouse.canvas.getTargetCanvases).mockResolvedValue(multiple);
    render(<ConnectionOpenAction targetId="gp_actual" targetKind="group-project" name="Renamed project" projectId="nav-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const chooser = await screen.findByTestId('connection-open-dialog');
    expect(within(chooser).getByRole('button', { name: /Home.*home-board.*home-node/ })).toBeInTheDocument();
    fireEvent.click(within(chooser).getByRole('button', { name: /Project:.*nav-two.*Canvas:.*board.*Node:.*node/ }));
    await waitFor(() => expect(getProjectCanvasStore('nav-two').getState().selectedViewId).toBe('node'));
    cleanup();

    const none = indexed();
    none.stores.forEach((entry) => { entry.hits = []; });
    getProjectCanvasStore('nav-two').setState({ loaded: false, dataOrigin: null });
    vi.mocked(window.clubhouse.canvas.getTargetCanvases).mockResolvedValue(none);
    render(<ConnectionOpenAction targetId="gp_actual" targetKind="group-project" name="Renamed project" projectId="nav-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No owning Canvas is available');
    none.stores[0].error = 'Permission denied';
    fireEvent.click(screen.getByRole('button', { name: 'Retry Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('lookup is incomplete');
  });

  it('keeps a mounted Canvas navigation-only when another owning board is opened', async () => {
    const activeWire = { agentId: 'active', targetId: 'gp_actual', targetKind: 'group-project' as const, label: 'Existing active pair' };
    const data: CanvasNavigationSnapshot = {
      ...snapshot(),
      wires: [...snapshot().wires, activeWire],
      canvases: [
        board(),
        board('second', [
          { ...groupView('second-node'), position: { x: 9000, y: 10000 } },
          {
            id: 'second-zone', type: 'zone', title: 'Zone', displayName: 'Zone', metadata: {}, themeId: 'catppuccin-mocha',
            position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, zIndex: 0, containedViewIds: ['second-agent'],
          },
          {
            id: 'second-agent', type: 'agent', agentId: 'zone-sleeper', title: 'Zone member', displayName: 'Zone member', metadata: {},
            position: { x: 50, y: 50 }, size: { width: 200, height: 200 }, zIndex: 1,
          },
        ]),
      ],
      zoneWires: [{ id: 'second-zone-wire', sourceZoneId: 'second-zone', targetId: 'gp_actual', targetType: 'group-project' }],
    };
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockResolvedValue(data);
    const store = getProjectCanvasStore('nav-two');
    store.getState().hydrateForNavigation(data, 'board');
    store.getState().renameCanvas('second', 'Unsaved board name');
    store.setState((state) => ({
      canvases: state.canvases.map((canvas) => canvas.id === 'second' ? {
        ...canvas,
        views: canvas.views.map((view) => view.id === 'second-node' ? {
          ...view, position: { x: 9100, y: 10100 }, metadata: { ...view.metadata, draft: 'Unsaved node data' },
        } : view),
      } : canvas),
    }));
    useMcpBindingStore.setState({ bindings: [activeWire] });
    await jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
    const load = vi.spyOn(store.getState(), 'loadCanvas');
    const loadWires = vi.spyOn(store.getState(), 'loadWires');
    const bind = vi.spyOn(window.clubhouse.mcpBinding, 'bind');
    const unbind = vi.spyOn(window.clubhouse.mcpBinding, 'unbind');
    const create = vi.spyOn(store.getState(), 'addCanvas');
    const remove = vi.spyOn(store.getState(), 'removeCanvas');
    const policy = vi.spyOn(window.clubhouse.agent, 'setOrchestrationPolicy');
    const { api, storage } = panelApi(data);
    vi.useFakeTimers();
    render(<MainPanel api={api} />);
    await act(async () => {
      await jumpToConnectionCanvas('group-project', 'gp_actual', { ...hit, canvasId: 'second', viewId: 'second-node' }, beginConnectionNavigationRequest().signal);
    });
    expect(store.getState().activeCanvasId).toBe('second');
    expect(store.getState().selectedViewId).toBe('second-node');
    expect(store.getState().viewport).toEqual({ panX: -8900, panY: -9950, zoom: 1 });
    expect(store.getState().canvases.find((canvas) => canvas.id === 'second')?.name).toBe('Unsaved board name');
    expect(store.getState().views.find((view) => view.id === 'second-node')?.metadata.draft).toBe('Unsaved node data');
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    for (const mutation of [bind, unbind, create, remove, policy, storage.write, load, loadWires]) expect(mutation).not.toHaveBeenCalled();
    expect(window.clubhouse.canvas.readForNavigation).not.toHaveBeenCalled();
    expect(useMcpBindingStore.getState().bindings).toEqual([activeWire]);
    expect(getCanvasNavigationHandoff(store)).toBeUndefined();
  });

  it('releases a superseded Open row immediately without waiting for its canceled hydration', async () => {
    const loading = deferred<CanvasNavigationSnapshot>();
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockReturnValue(loading.promise);
    render(
      <>
        <div data-testid="pending-open">
          <ConnectionOpenAction targetId="gp_actual" targetKind="group-project" name="Group project" projectId="nav-one" />
        </div>
        <div data-testid="replacement-open">
          <ConnectionOpenAction targetId="actual-agent" targetKind="agent" name="Agent" projectId="nav-one" />
        </div>
      </>,
    );
    const pending = within(screen.getByTestId('pending-open')).getByRole('button', { name: 'Open' });
    fireEvent.click(pending);
    await waitFor(() => expect(window.clubhouse.canvas.readForNavigation).toHaveBeenCalled());
    expect(pending).toBeDisabled();
    fireEvent.click(within(screen.getByTestId('replacement-open')).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(useAgentStore.getState().activeAgentId).toBe('actual-agent'));
    expect(pending).toBeEnabled();
    await act(async () => { loading.resolve(snapshot()); });
    expect(getProjectCanvasStore('nav-two').getState().loaded).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the genuine local snapshot for remote-projected Home, never its same-ID remote board or an unreadable local copy', async () => {
    const homeHit = { scope: 'app' as const, canvasId: 'home-board', viewId: 'home-node', name: 'Local saved board', nodeName: 'Local node' };
    const index = indexed();
    index.stores.forEach((entry) => { entry.hits = entry.scope === 'app' ? [homeHit] : []; });
    const remoteBoard = board('home-board', [{ ...groupView('home-node'), title: 'Remote projected node', position: { x: 700, y: 900 } }]);
    useAppCanvasStore.getState().hydrateFromRemote([remoteBoard], 'home-board', [], []);
    useUIStore.setState({ activeHostId: 'satellite' });
    const unreadable = { ...index, stores: [{ scope: 'app' as const, hits: [], error: 'Local saved copy unreadable' }] };
    expect(mergeTargetCanvasHits('group-project', 'gp_actual', unreadable)).toEqual({ hits: [], errors: ['Home: Local saved copy unreadable'] });
    vi.mocked(window.clubhouse.canvas.getTargetCanvases).mockResolvedValue(index);
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockRejectedValueOnce(new Error('Local Canvas primary is unavailable. Restore it and retry Open.'));
    const create = vi.spyOn(useAppCanvasStore.getState(), 'addCanvas');
    const bind = vi.spyOn(window.clubhouse.mcpBinding, 'bind');
    const unbind = vi.spyOn(window.clubhouse.mcpBinding, 'unbind');
    await expect(jumpToConnectionCanvas('group-project', 'gp_actual', homeHit, beginConnectionNavigationRequest().signal)).rejects.toThrow('Local Canvas primary is unavailable');
    expect(useAppCanvasStore.getState().views[0].title).toBe('Remote projected node');
    expect(useUIStore.getState().activeHostId).toBe('satellite');

    const loading = deferred<CanvasNavigationSnapshot>();
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockReturnValue(loading.promise);
    const opening = jumpToConnectionCanvas('group-project', 'gp_actual', homeHit, beginConnectionNavigationRequest().signal);
    await waitFor(() => expect(window.clubhouse.canvas.readForNavigation).toHaveBeenCalledTimes(2));
    expect(window.clubhouse.canvas.readForNavigation).toHaveBeenLastCalledWith('group-project', 'gp_actual', undefined);
    expect(useAppCanvasStore.getState().views[0].title).toBe('Remote projected node');
    loading.resolve({ ...snapshot(), canvases: [board('home-board', [groupView('home-node')])] });
    await opening;
    expect(useAppCanvasStore.getState().views[0].title).toBe('Renamed project');
    expect(useAppCanvasStore.getState().views[0].position).toEqual({ x: 5000, y: 6000 });
    expect(useAppCanvasStore.getState().selectedViewId).toBe('home-node');
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(useUIStore.getState().activeHostId).toBeNull();
    for (const mutation of [create, bind, unbind]) expect(mutation).not.toHaveBeenCalled();
  });

  it('lets loaded live deletions override saved hits and unreadable saved copies, but never hides an incomplete scope inventory', () => {
    const index = indexed();
    index.stores[2].error = 'Unreadable saved copy';
    getProjectCanvasStore('nav-two').setState({ loaded: true, dataOrigin: 'local', canvases: [] });
    expect(mergeTargetCanvasHits('group-project', 'gp_actual', index)).toEqual({ hits: [], errors: [] });
    index.error = 'Project list unreadable';
    expect(mergeTargetCanvasHits('group-project', 'gp_actual', index).errors).toEqual(['Project list unreadable']);
  });

  it.each([
    ['deleted board', [board('unrelated', [])]],
    ['deleted node', [board('board', [groupView('same-label-wrong-id', 'gp_other')])]],
  ] as const)('rejects a %s at the hydration boundary without focusing another board or creating anything', async (_label, canvases) => {
    const store = getProjectCanvasStore('nav-two');
    const focus = vi.spyOn(store.getState(), 'focusView');
    const create = vi.spyOn(store.getState(), 'addCanvas');
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockResolvedValue({ ...snapshot(), canvases: [...canvases] });
    await expect(jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal)).rejects.toThrow(/no longer available|deleted while loading/);
    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(focus).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('cancels outdated/departed jumps during deferred hydration, including when the destination project is removed', async () => {
    const loading = deferred<CanvasNavigationSnapshot>();
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockReturnValue(loading.promise);
    const first = beginConnectionNavigationRequest();
    const opening = jumpToConnectionCanvas('group-project', 'gp_actual', hit, first.signal);
    const rejected = expect(opening).rejects.toThrow();
    await waitFor(() => expect(window.clubhouse.canvas.readForNavigation).toHaveBeenCalled());
    beginConnectionNavigationRequest();
    loading.resolve(snapshot());
    await rejected;
    expect(getProjectCanvasStore('nav-two').getState().loaded).toBe(false);
    expect(useUIStore.getState().explorerTab).toBe('agents');

    const secondLoad = deferred<CanvasNavigationSnapshot>();
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockReturnValue(secondLoad.promise);
    const second = jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
    const removed = expect(second).rejects.toThrow(/project was removed while loading/);
    await waitFor(() => expect(window.clubhouse.canvas.readForNavigation).toHaveBeenCalledTimes(2));
    useProjectStore.setState({ projects: [projects[0]] });
    secondLoad.resolve(snapshot());
    await removed;
    expect(getProjectCanvasStore('nav-two').getState().loaded).toBe(false);
  });

  it('discards an unconsumed handoff when its tab closes and reports a target removed between hydration and mount', async () => {
    const store = getProjectCanvasStore('nav-two');
    await jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
    expect(getCanvasNavigationHandoff(store)).toBeDefined();
    useUIStore.getState().setExplorerTab('agents', 'nav-two');
    expect(getCanvasNavigationHandoff(store)).toBeUndefined();
    await jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
    store.setState((state) => ({
      canvases: state.canvases.map((canvas) => canvas.id === 'board' ? { ...canvas, views: [] } : canvas),
    }));
    const { api, storage } = panelApi(snapshot());
    const create = vi.spyOn(store.getState(), 'addCanvas');
    const bind = vi.spyOn(window.clubhouse.mcpBinding, 'bind');
    render(<MainPanel api={api} />);
    expect(screen.getByRole('alert')).toHaveTextContent('deleted before it opened');
    expect(screen.queryByTestId('canvas-workspace')).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('keeps suspended-row Open distinct from Edit/Remove and disables unsupported plugin navigation with an accessible explanation', async () => {
    window.clubhouse.mcpBinding.getDispatcherLinks = vi.fn(async () => [{
      agentId: 'lead', targetId: 'actual-agent', agentName: 'Lead', targetName: 'Old name', status: 'suspended', reason: 'dispatcher_off',
    }]);
    window.clubhouse.mcpBinding.getConnectionSources = vi.fn(async () => ({ pairs: [], unreadable: [] }));
    render(<ConnectionsCard agent={lead} helperIds={new Set()} open onToggle={() => {}} onDisconnect={vi.fn()} />);
    const row = await screen.findByTestId('connection-row');
    expect(row).toHaveTextContent('suspended');
    expect(within(row).getByRole('button', { name: 'Open' })).toBeEnabled();
    fireEvent.click(within(row).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(useAgentStore.getState().activeAgentId).toBe('actual-agent'));
    cleanup();
    render(<ConnectionOpenAction targetId="widget-only" targetKind="plugin" name="Widget only" projectId="nav-one" />);
    const unsupported = screen.getByRole('button', { name: 'Open' });
    expect(unsupported).toBeDisabled();
    expect(unsupported).toHaveAccessibleDescription('This plugin has no standalone navigation view.');
  });

  it('uses a genuine enabled plugin tab, including Home for a dual-scope plugin, without enabling or creating anything', () => {
    render(<ConnectionOpenAction targetId="browser" targetKind="plugin" name="Browser plugin" projectId="nav-one" />);
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    act(() => {
      usePluginStore.getState().registerPlugin(browserManifest, 'builtin', '/builtin/browser', 'activated');
      usePluginStore.getState().enableApp('browser');
    });
    const before = usePluginStore.getState().appEnabled;
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(useUIStore.getState().explorerTab).toBe('plugin:app:browser');
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(usePluginStore.getState().appEnabled).toBe(before);
  });

  it('opens Home and an enabled app plugin from the real Card through Chrome and the registered app context, without a project fallback', async () => {
    await registerNavigationPanels();
    useMcpBindingStore.setState({ bindings: [
      { agentId: lead.id, targetId: 'gp_actual', targetKind: 'group-project', label: 'Home target' },
    ] });
    const homeHit = { ...hit, scope: 'app' as const, projectId: undefined, projectName: undefined };
    vi.mocked(window.clubhouse.canvas.getTargetCanvases).mockResolvedValue({
      stores: [{ scope: 'app', hits: [homeHit] }], groupProjects: [groupProject],
    });
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockResolvedValue({ ...snapshot(), wires: [] });
    const projectCreate = vi.spyOn(window.clubhouse.project, 'add');
    const canvasCreate = vi.spyOn(useAppCanvasStore.getState(), 'addCanvas');
    const writes = vi.spyOn(window.clubhouse.plugin, 'storageWrite');
    render(<ChromeBody />);
    const row = await screen.findByTestId('connection-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Open' }));
    const target = await screen.findByTestId('canvas-view-node');
    expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
    expect(target).toHaveTextContent('Renamed project');
    expect(screen.getByTestId('canvas-workspace')).toHaveFocus();
    expect(useAppCanvasStore.getState().selectedViewId).toBe('node');
    expect(useAppCanvasStore.getState().viewport).toEqual({ panX: -4800, panY: -5850, zoom: 1 });
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(getProjectCanvasStore('nav-two').getState().loaded).toBe(false);
    expect(projectCreate).not.toHaveBeenCalled();
    expect(canvasCreate).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();

    cleanup();
    act(() => {
      useProjectStore.getState().setActiveProject('nav-one');
      useUIStore.getState().setExplorerTab('agents', 'nav-one');
      usePluginStore.getState().registerPlugin(browserManifest, 'builtin', '/builtin/browser', 'activated');
      usePluginStore.getState().setPluginModule('browser', {
        MainPanel: ({ api }) => <div data-testid="registered-browser-panel">{api.context.mode}:{api.context.projectId ?? 'Home'}</div>,
      });
      usePluginStore.getState().enableApp('browser');
      useMcpBindingStore.setState({ bindings: [{ agentId: lead.id, targetId: 'browser', targetKind: 'plugin', label: 'Browser' }] });
    });
    await activatePlugin('browser');
    const enabled = usePluginStore.getState().appEnabled;
    writes.mockClear();
    render(<ChromeBody />);
    fireEvent.click(within(await screen.findByTestId('connection-row')).getByRole('button', { name: 'Open' }));
    expect(await screen.findByTestId('registered-browser-panel')).toHaveTextContent('app:Home');
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(usePluginStore.getState().appEnabled).toBe(enabled);
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps the actual routed Card alive until popout ACK, shows Retry on failure, and cancels genuine departure', async () => {
    await registerNavigationPanels();
    useMcpBindingStore.setState({ bindings: [{ agentId: lead.id, targetId: 'gp_actual', targetKind: 'group-project', label: 'Target' }] });
    const store = getProjectCanvasStore('nav-two');
    store.getState().hydrateForNavigation({ ...snapshot(), wires: [] }, 'board');
    vi.spyOn(useProjectStore.getState(), 'loadProjects').mockResolvedValue(undefined);
    vi.spyOn(useAgentStore.getState(), 'loadDurableAgents').mockResolvedValue(undefined);
    window.clubhouse.window.getCanvasState = vi.fn(async () => null);
    window.clubhouse.window.listPopouts = vi.fn(async () => [{ windowId: 7, params: { type: 'canvas', canvasId: 'board', projectId: 'nav-two' } }]);
    let receive: ((request: CanvasPopoutReveal) => void) | undefined;
    let cancelDestination: ((requestId: string) => void) | undefined;
    let answer = deferred<CanvasPopoutRevealResult>();
    let delivered: CanvasPopoutReveal | undefined;
    window.clubhouse.window.onCanvasPopoutReveal = vi.fn((callback) => { receive = callback; return () => {}; });
    window.clubhouse.window.onCanvasPopoutRevealCanceled = vi.fn((callback) => { cancelDestination = callback; return () => {}; });
    window.clubhouse.window.revealCanvasPopout = vi.fn((request) => {
      delivered = request;
      receive?.(request);
      return answer.promise;
    });
    window.clubhouse.window.cancelCanvasPopoutReveal = vi.fn((requestId) => {
      cancelDestination?.(requestId);
      answer.resolve({ requestId, error: 'Canvas navigation was canceled.' });
    });
    const mutations = [
      vi.spyOn(window.clubhouse.mcpBinding, 'bind'),
      vi.spyOn(window.clubhouse.mcpBinding, 'unbind'),
      vi.spyOn(window.clubhouse.mcpBinding, 'makeTwoWay'),
      vi.spyOn(window.clubhouse.mcpBinding, 'removeConnectionSource'),
      vi.spyOn(window.clubhouse.mcpBinding, 'saveConnectionGuidance'),
      vi.spyOn(window.clubhouse.groupProject, 'update'),
      vi.spyOn(window.clubhouse.agent, 'setOrchestrationPolicy'),
    ];
    const bindingsBefore = JSON.stringify(useMcpBindingStore.getState().bindings);
    render(<><ChromeBody /><PopoutCanvasView canvasId="board" projectId="nav-two" /></>);
    const open = within(await screen.findByTestId('connection-row')).getByRole('button', { name: 'Open' });
    fireEvent.click(open);
    await waitFor(() => expect(window.clubhouse.window.canvasPopoutRevealed).toHaveBeenCalled());
    expect(screen.getByTestId('agent-details')).toBeInTheDocument();
    expect(open).toBeDisabled();
    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(window.clubhouse.window.cancelCanvasPopoutReveal).not.toHaveBeenCalled();
    await act(async () => { answer.resolve({ requestId: delivered!.requestId, error: 'The Canvas window closed. Retry Open.' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('window closed');
    expect(screen.getByRole('button', { name: 'Retry Open' })).toBeEnabled();
    answer = deferred<CanvasPopoutRevealResult>();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Open' }));
    await waitFor(() => expect(window.clubhouse.window.revealCanvasPopout).toHaveBeenCalledTimes(2));
    act(() => { useUIStore.getState().setExplorerTab('help'); });
    await waitFor(() => expect(window.clubhouse.window.cancelCanvasPopoutReveal).toHaveBeenCalledWith(delivered!.requestId));
    act(() => { useUIStore.getState().setExplorerTab('agents', 'nav-one'); });
    answer = deferred<CanvasPopoutRevealResult>();
    fireEvent.click(within(await screen.findByTestId('connection-row')).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(window.clubhouse.window.revealCanvasPopout).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(window.clubhouse.window.canvasPopoutRevealed).toHaveBeenCalledWith({
      requestId: delivered!.requestId, viewport: { panX: -4800, panY: -5850, zoom: 1 },
    }));
    const result = vi.mocked(window.clubhouse.window.canvasPopoutRevealed).mock.calls.at(-1)![0];
    expect('error' in result).toBe(false);
    expect(useUIStore.getState().explorerTab).toBe('agents');
    await act(async () => { answer.resolve(result); });
    expect(await screen.findByTestId('popped-out-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-details')).not.toBeInTheDocument();
    expect(useProjectStore.getState().activeProjectId).toBe('nav-two');
    expect(JSON.stringify(useMcpBindingStore.getState().bindings)).toBe(bindingsBefore);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  });

  it.each([
    ['browser', 'plugin:browser:webview'],
    ['terminal', 'plugin:terminal:shell'],
  ] as const)('opens the actual %s widget through its owning Canvas rather than inventing a page', async (kind, pluginWidgetType) => {
    const widget = { ...groupView('widget-id'), pluginWidgetType, metadata: {}, title: 'Same widget name', displayName: 'Same widget name' };
    const data = { ...snapshot(), canvases: [board('board', [widget])], wires: [] };
    vi.mocked(window.clubhouse.canvas.readForNavigation).mockResolvedValue(data);
    vi.mocked(window.clubhouse.canvas.getTargetCanvases).mockResolvedValue({
      stores: [{ scope: 'project', projectId: 'nav-two', hits: [{ ...hit, viewId: 'widget-id', nodeName: 'Same widget name' }] }],
      groupProjects: [],
    });
    render(<ConnectionOpenAction targetId="widget-id" targetKind={kind} name="Same widget name" projectId="nav-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(getProjectCanvasStore('nav-two').getState().selectedViewId).toBe('widget-id'));
    expect(useUIStore.getState().explorerTab).toBe('plugin:canvas');
    expect(window.clubhouse.canvas.readForNavigation).toHaveBeenCalledWith(kind, 'widget-id', 'nav-two');
  });

  it('reveals a dirty local node with the real leader broadcast, preserving inactive zones and exact scope after ACK without domain writes', async () => {
    const store = getProjectCanvasStore('nav-two');
    const data: CanvasNavigationSnapshot = {
      ...snapshot(),
      canvases: [board('board', [
        groupView(),
        {
          id: 'popout-zone', type: 'zone', title: 'Zone', displayName: 'Zone', metadata: {}, themeId: 'catppuccin-mocha',
          position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, zIndex: 0, containedViewIds: ['popout-member', 'popout-active'],
        },
        {
          id: 'popout-member', type: 'agent', agentId: 'zone-sleeper', title: 'Member', displayName: 'Member', metadata: {},
          position: { x: 50, y: 50 }, size: { width: 200, height: 200 }, zIndex: 1,
        },
        {
          id: 'popout-active', type: 'agent', agentId: 'existing', title: 'Active member', displayName: 'Active member', metadata: {},
          position: { x: 300, y: 50 }, size: { width: 200, height: 200 }, zIndex: 1,
        },
      ])],
      zoneWires: [],
    };
    store.getState().hydrateForNavigation(data, 'board');
    store.getState().moveView('node', { x: 9100, y: 10100 });
    store.getState().renameCanvas('board', 'Unsaved local Canvas');
    store.getState().addZoneWireDefinition({ sourceZoneId: 'popout-zone', targetId: 'gp_actual', targetType: 'group-project' });
    const existing = { agentId: 'existing', targetId: 'gp_actual', targetKind: 'group-project' as const, label: 'Active pair' };
    useMcpBindingStore.setState({ bindings: [existing] });
    vi.spyOn(useProjectStore.getState(), 'loadProjects').mockResolvedValue(undefined);
    vi.spyOn(useAgentStore.getState(), 'loadDurableAgents').mockResolvedValue(undefined);
    const oldSnapshot = deferred<null>();
    window.clubhouse.window.getCanvasState = vi.fn(() => oldSnapshot.promise);
    window.clubhouse.window.listPopouts = vi.fn(async () => [
      { windowId: 99, params: { type: 'canvas', canvasId: 'board' } },
      { windowId: 7, params: { type: 'canvas', canvasId: 'board', projectId: 'nav-two' } },
    ]);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const destination = !!this.closest('[data-testid="popout-canvas-view"]');
      const width = destination ? 1000 : 800;
      const height = destination ? 700 : 600;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    });
    const focusedWindow = vi.fn();
    let receive: ((request: CanvasPopoutReveal) => void) | undefined;
    window.clubhouse.window.onCanvasPopoutReveal = vi.fn((callback) => { receive = callback; return () => {}; });
    const acknowledged = deferred<CanvasPopoutRevealResult>();
    let receiveBroadcast: Parameters<typeof window.clubhouse.window.onCanvasStateChanged>[0] | undefined;
    window.clubhouse.window.onCanvasStateChanged = vi.fn((callback) => { receiveBroadcast = callback; return () => { receiveBroadcast = undefined; }; });
    window.clubhouse.window.broadcastCanvasState = vi.fn((state) => { receiveBroadcast?.(JSON.parse(JSON.stringify(state))); });
    window.clubhouse.window.revealCanvasPopout = vi.fn((request) => {
      expect(request.windowId).toBe(7);
      expect(request.snapshot.name).toBe('Unsaved local Canvas');
      receive?.(request);
      return acknowledged.promise;
    });
    window.clubhouse.window.canvasPopoutRevealed = vi.fn((result) => {
      expect('error' in result).toBe(false);
      const destination = screen.getByTestId('popout-canvas-view');
      const workspace = within(destination).getByTestId('canvas-workspace');
      expect(document.activeElement).toBe(workspace);
      expect(workspace.firstElementChild).toHaveStyle({ transform: 'scale(1) translate(-8800px, -9900px)' });
      expect(result).toMatchObject({ viewport: { panX: -8800, panY: -9900, zoom: 1 } });
      focusedWindow();
      acknowledged.resolve(result);
    });
    const bind = vi.spyOn(window.clubhouse.mcpBinding, 'bind');
    const unbind = vi.spyOn(window.clubhouse.mcpBinding, 'unbind');
    const create = vi.spyOn(store.getState(), 'addCanvas');
    const remove = vi.spyOn(store.getState(), 'removeCanvas');
    const policy = vi.spyOn(window.clubhouse.agent, 'setOrchestrationPolicy');
    const createWindow = vi.spyOn(window.clubhouse.window, 'createPopout');
    const closeWindow = vi.spyOn(window.clubhouse.window, 'closePopout');
    const membership = vi.spyOn(window.clubhouse.groupProject, 'update');
    const projectCreate = vi.spyOn(window.clubhouse.project, 'add');
    render(<PopoutCanvasView canvasId="board" projectId="nav-two" />);
    await waitFor(() => expect(receive).toBeDefined());
    expect(screen.getByText('Loading canvas...')).toBeInTheDocument();
    let opening!: Promise<void>;
    await act(async () => {
      opening = jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
    });
    await waitFor(() => expect(focusedWindow).toHaveBeenCalledOnce());
    await opening;
    expect(focusedWindow).toHaveBeenCalledOnce();
    expect(store.getState().viewport).toEqual({ panX: -8800, panY: -9900, zoom: 1 });
    expect(store.getState().selectedViewId).toBe('node');
    const { api, storage } = panelApi(data);
    render(<MainPanel api={api} />);
    await waitFor(() => expect(within(screen.getByTestId('canvas-panel')).getByTestId('popped-out-placeholder')).toBeInTheDocument());
    expect(window.clubhouse.window.broadcastCanvasState).toHaveBeenCalled();
    const broadcast = vi.mocked(window.clubhouse.window.broadcastCanvasState).mock.calls.at(-1)![0];
    await act(async () => {
      receiveBroadcast?.(JSON.parse(JSON.stringify(broadcast)));
      receiveBroadcast?.({ ...broadcast, projectId: undefined, views: [groupView('home-node')], viewport: { panX: 123, panY: 456, zoom: 1 } });
    });
    const destination = screen.getByTestId('popout-canvas-view');
    expect(within(destination).getByTestId('canvas-view-node')).toBeInTheDocument();
    expect(within(destination).queryByTestId('canvas-view-home-node')).not.toBeInTheDocument();
    expect(within(destination).getByTestId('canvas-workspace').firstElementChild).toHaveStyle({
      transform: 'scale(1) translate(-8800px, -9900px)',
    });
    await act(async () => {
      receiveBroadcast?.({ ...broadcast, viewport: { panX: -8700, panY: -9800, zoom: 1 } });
    });
    expect(within(destination).getByTestId('canvas-workspace').firstElementChild).toHaveStyle({
      transform: 'scale(1) translate(-8700px, -9800px)',
    });
    oldSnapshot.resolve(null);
    await act(async () => { await oldSnapshot.promise; });
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
    expect(screen.queryByText('Loading canvas...')).not.toBeInTheDocument();
    for (const mutation of [bind, unbind, create, remove, policy, createWindow, closeWindow, membership, projectCreate, storage.write]) expect(mutation).not.toHaveBeenCalled();
    expect(useMcpBindingStore.getState().bindings).toEqual([existing]);
    expect(window.clubhouse.canvas.readForNavigation).not.toHaveBeenCalled();
  });

  it('fences an older periodic snapshot after real destination ACK and after receiver departure', async () => {
    const store = getProjectCanvasStore('nav-two');
    store.getState().hydrateForNavigation({ ...snapshot(), wires: [] }, 'board');
    store.getState().moveView('node', { x: 9100, y: 10100 });
    vi.spyOn(useProjectStore.getState(), 'loadProjects').mockResolvedValue(undefined);
    vi.spyOn(useAgentStore.getState(), 'loadDurableAgents').mockResolvedValue(undefined);
    const stale = deferred<Awaited<ReturnType<typeof window.clubhouse.window.getCanvasState>>>();
    const departed = deferred<Awaited<ReturnType<typeof window.clubhouse.window.getCanvasState>>>();
    const initial = {
      canvasId: 'board', name: 'Old snapshot', views: [groupView()],
      viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null, projectId: 'nav-two',
    };
    window.clubhouse.window.getCanvasState = vi.fn().mockResolvedValue({
      ...initial, canvasId: 'other', views: [groupView('other-node')], viewport: { panX: 77, panY: 88, zoom: 1 },
    })
      .mockResolvedValueOnce(initial).mockReturnValueOnce(stale.promise).mockReturnValueOnce(departed.promise);
    window.clubhouse.window.listPopouts = vi.fn(async () => [{ windowId: 7, params: { type: 'canvas', canvasId: 'board', projectId: 'nav-two' } }]);
    let receive: ((request: CanvasPopoutReveal) => void) | undefined;
    const answer = deferred<CanvasPopoutRevealResult>();
    window.clubhouse.window.onCanvasPopoutReveal = vi.fn((callback) => { receive = callback; return () => { receive = undefined; }; });
    window.clubhouse.window.revealCanvasPopout = vi.fn((request) => { receive?.(request); return answer.promise; });
    window.clubhouse.window.canvasPopoutRevealed = vi.fn((result) => { answer.resolve(result); });
    vi.useFakeTimers();
    const destination = render(<PopoutCanvasView canvasId="board" projectId="nav-two" />);
    await act(async () => {});
    expect(screen.getByTestId('canvas-view-node')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(window.clubhouse.window.getCanvasState).toHaveBeenCalledTimes(2);
    let opening!: Promise<void>;
    await act(async () => {
      opening = jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
    });
    await opening;
    const workspace = screen.getByTestId('canvas-workspace');
    expect(workspace.firstElementChild).toHaveStyle({ transform: 'scale(1) translate(-8900px, -9950px)' });
    await act(async () => { stale.resolve({ ...initial, views: [groupView('stale-node')], viewport: { panX: 555, panY: 666, zoom: 1 } }); });
    expect(screen.queryByTestId('canvas-view-stale-node')).not.toBeInTheDocument();
    expect(workspace.firstElementChild).toHaveStyle({ transform: 'scale(1) translate(-8900px, -9950px)' });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(window.clubhouse.window.getCanvasState).toHaveBeenCalledTimes(3);
    destination.rerender(<PopoutCanvasView canvasId="other" projectId="nav-two" />);
    await act(async () => {});
    expect(screen.getByTestId('canvas-view-other-node')).toBeInTheDocument();
    await act(async () => { departed.resolve({ ...initial, views: [groupView('departed-node')] }); });
    expect(screen.queryByTestId('canvas-view-departed-node')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-view-other-node')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-workspace').firstElementChild).toHaveStyle({ transform: 'scale(1) translate(77px, 88px)' });
    destination.unmount();
  });

  it('renders the manually selected Canvas B while the popout list is pending, never the navigation A placeholder', async () => {
    const store = getProjectCanvasStore('nav-two');
    const data = { ...snapshot(), canvases: [board(), board('manual-b', [groupView('manual-node')])], wires: [] };
    store.getState().hydrateForNavigation(data, 'board');
    const entries = [{ windowId: 7, params: { type: 'canvas' as const, canvasId: 'board', projectId: 'nav-two' } }];
    const pending = deferred<typeof entries>();
    window.clubhouse.window.listPopouts = vi.fn().mockResolvedValueOnce(entries).mockReturnValue(pending.promise);
    window.clubhouse.window.revealCanvasPopout = vi.fn(async (request) => ({
      requestId: request.requestId, viewport: { panX: -4800, panY: -5850, zoom: 1 },
    }));
    await jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
    const { api } = panelApi(data);
    const create = vi.spyOn(store.getState(), 'addCanvas');
    const remove = vi.spyOn(store.getState(), 'removeCanvas');
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('popped-out-placeholder')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[1]);
    expect(screen.getByTestId('canvas-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-view-manual-node')).toBeInTheDocument();
    expect(screen.queryByTestId('popped-out-placeholder')).not.toBeInTheDocument();
    await act(async () => { pending.resolve(entries); });
    expect(screen.getByTestId('canvas-view-manual-node')).toBeInTheDocument();
    fireEvent.click(tabs[0]);
    expect(screen.getByTestId('popped-out-placeholder')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['leader', 'receiver'] as const)('retires navigation suppression permanently after real %s zone enter and exact-baseline leave', async (mode) => {
    const data: CanvasNavigationSnapshot = {
      ...snapshot(),
      canvases: [board('board', [
        groupView(),
        { id: 'manual-zone', type: 'zone', title: 'Zone', displayName: 'Zone', metadata: {}, themeId: 'catppuccin-mocha',
          position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, zIndex: 0, containedViewIds: ['bounds-note'] },
        { id: 'bounds-note', type: 'sticky-note', title: 'Zone bounds', displayName: 'Zone bounds', metadata: {}, content: '', color: 'yellow',
          position: { x: 40, y: 60 }, size: { width: 520, height: 300 }, zIndex: 0 },
        { id: 'manual-member', type: 'agent', agentId: 'manual-agent', title: 'Member', displayName: 'Member', metadata: {},
          position: { x: 700, y: 60 }, size: { width: 200, height: 200 }, zIndex: 1 },
      ])],
      zoneWires: [{ id: 'manual-zone-wire', sourceZoneId: 'manual-zone', targetId: 'gp_actual', targetType: 'group-project' }],
    };
    const store = getProjectCanvasStore('nav-two');
    store.getState().hydrateForNavigation(data, 'board');
    const unrelated = { agentId: 'unrelated', targetId: 'other-target', targetKind: 'group-project' as const, label: 'Unrelated active pair' };
    useMcpBindingStore.setState({ bindings: [unrelated] });
    const bind = vi.spyOn(window.clubhouse.mcpBinding, 'bind');
    const unbind = vi.spyOn(window.clubhouse.mcpBinding, 'unbind');
    vi.useFakeTimers();
    if (mode === 'leader') {
      await jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal);
      render(<MainPanel api={panelApi(data).api} />);
    } else {
      vi.spyOn(useProjectStore.getState(), 'loadProjects').mockResolvedValue(undefined);
      vi.spyOn(useAgentStore.getState(), 'loadDurableAgents').mockResolvedValue(undefined);
      window.clubhouse.window.getCanvasState = vi.fn(async () => null);
      const answer = deferred<CanvasPopoutRevealResult>();
      let receive: ((request: CanvasPopoutReveal) => void) | undefined;
      window.clubhouse.window.onCanvasPopoutReveal = vi.fn((callback) => { receive = callback; return () => {}; });
      window.clubhouse.window.listPopouts = vi.fn(async () => [{ windowId: 7, params: { type: 'canvas', canvasId: 'board', projectId: 'nav-two' } }]);
      window.clubhouse.window.revealCanvasPopout = vi.fn((request) => { receive?.(request); return answer.promise; });
      window.clubhouse.window.canvasPopoutRevealed = vi.fn((result) => { answer.resolve(result); });
      let receiveBroadcast: Parameters<typeof window.clubhouse.window.onCanvasStateChanged>[0] | undefined;
      window.clubhouse.window.onCanvasStateChanged = vi.fn((callback) => { receiveBroadcast = callback; return () => {}; });
      window.clubhouse.window.broadcastCanvasState = vi.fn((state) => { receiveBroadcast?.(JSON.parse(JSON.stringify(state))); });
      window.clubhouse.window.sendCanvasMutation = vi.fn((canvasId, scope, mutation, projectId) => {
        applyCanvasMutation(store, canvasId, mutation, projectId, scope);
      });
      render(<PopoutCanvasView canvasId="board" projectId="nav-two" />);
      await act(async () => {});
      expect(receive).toBeDefined();
      let opening!: Promise<void>;
      await act(async () => { opening = jumpToConnectionCanvas('group-project', 'gp_actual', hit, beginConnectionNavigationRequest().signal); });
      await opening;
    }
    const workspace = screen.getByTestId('canvas-workspace');
    expect(bind).not.toHaveBeenCalled();
    await act(async () => { dragCanvasView(workspace, 'manual-member', -640, 0); });
    expect(within(workspace).getByTestId('canvas-view-manual-member')).toHaveStyle({ left: '60px', top: '60px' });
    expect(bind).toHaveBeenCalledWith('manual-agent', expect.objectContaining({ targetId: 'gp_actual' }));
    await act(async () => { dragCanvasView(workspace, 'manual-member', 640, 0); });
    expect(within(workspace).getByTestId('canvas-view-manual-member')).toHaveStyle({ left: '700px', top: '60px' });
    expect(unbind).toHaveBeenCalledWith('manual-agent', 'gp_actual', expect.any(String));
    expect(viewStructure(store.getState().views)).toBe(viewStructure(data.canvases[0].views));
    expect(useMcpBindingStore.getState().bindings).toContainEqual(unrelated);
    expect(useMcpBindingStore.getState().bindings.some((wire) => wire.agentId === 'manual-agent')).toBe(false);
    expect(unbind.mock.calls.every(([agentId]) => agentId === 'manual-agent')).toBe(true);
    if (mode === 'leader') {
      expect(store.getState().views.find((view) => view.id === 'manual-member')?.position).toEqual({ x: 700, y: 60 });
      act(() => { useMcpBindingStore.setState({ bindings: [unrelated] }); });
      bind.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(2200); });
      expect(bind).toHaveBeenCalledWith('sleeping', expect.objectContaining({ targetId: 'gp_actual' }));
    }
  });

  it('cancels queued destination reveals before measured layout and ignores stale scope or deleted nodes', async () => {
    const store = getProjectCanvasStore('nav-two');
    store.getState().hydrateForNavigation(snapshot(), 'board');
    vi.spyOn(useProjectStore.getState(), 'loadProjects').mockResolvedValue(undefined);
    vi.spyOn(useAgentStore.getState(), 'loadDurableAgents').mockResolvedValue(undefined);
    window.clubhouse.window.getCanvasState = vi.fn(async () => null);
    window.clubhouse.window.listPopouts = vi.fn(async () => [
      { windowId: 7, params: { type: 'canvas', canvasId: 'board', projectId: 'nav-two' } },
    ]);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}),
    });
    let receive: ((request: CanvasPopoutReveal) => void) | undefined;
    let cancelDestination: ((requestId: string) => void) | undefined;
    window.clubhouse.window.onCanvasPopoutReveal = vi.fn((callback) => { receive = callback; return () => {}; });
    window.clubhouse.window.onCanvasPopoutRevealCanceled = vi.fn((callback) => { cancelDestination = callback; return () => {}; });
    const answer = deferred<CanvasPopoutRevealResult>();
    let delivered: CanvasPopoutReveal | undefined;
    window.clubhouse.window.revealCanvasPopout = vi.fn((request) => { delivered = request; receive?.(request); return answer.promise; });
    window.clubhouse.window.cancelCanvasPopoutReveal = vi.fn((requestId) => {
      cancelDestination?.(requestId);
      answer.resolve({ requestId, error: 'Canvas navigation was canceled.' });
    });
    const destination = render(<PopoutCanvasView canvasId="board" projectId="nav-two" />);
    await waitFor(() => expect(receive).toBeDefined());
    const controller = beginConnectionNavigationRequest();
    const opening = jumpToConnectionCanvas('group-project', 'gp_actual', hit, controller.signal);
    const rejected = expect(opening).rejects.toThrow();
    await waitFor(() => expect(delivered).toBeDefined());
    expect(window.clubhouse.window.canvasPopoutRevealed).not.toHaveBeenCalled();
    await act(async () => { beginConnectionNavigationRequest(); await rejected; });
    expect(window.clubhouse.window.cancelCanvasPopoutReveal).toHaveBeenCalledWith(delivered?.requestId);
    await act(async () => {
      receive?.({ ...delivered!, requestId: 'wrong-scope', projectId: undefined });
      receive?.({ ...delivered!, requestId: 'deleted-node', snapshot: { ...delivered!.snapshot, views: [] } });
    });
    expect(vi.mocked(window.clubhouse.window.canvasPopoutRevealed).mock.calls.every(([result]) => 'error' in result)).toBe(true);
    expect(getCanvasNavigationHandoff(store)).toBeUndefined();
    if (!delivered) throw new Error('Expected the original reveal request to be delivered.');
    const original = delivered;
    await act(async () => {
      receive?.({ ...original, requestId: 'new-navigation' });
      cancelDestination?.(original.requestId);
    });
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}),
    });
    destination.rerender(<PopoutCanvasView canvasId="board" projectId="nav-two" />);
    await waitFor(() => expect(window.clubhouse.window.canvasPopoutRevealed).toHaveBeenCalledWith({
      requestId: 'new-navigation', viewport: { panX: -4800, panY: -5850, zoom: 1 },
    }));
  });
});
