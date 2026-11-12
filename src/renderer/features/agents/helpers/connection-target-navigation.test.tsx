import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Project } from '../../../../shared/types';
import type { CanvasNavigationSnapshot, GroupProjectNavigationIndex } from '../../../../shared/canvas-index-types';
import type { PluginAPI, ScopedStorage } from '../../../../shared/plugin-types';
import { getProjectCanvasStore, MainPanel, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasInstanceData, CanvasView } from '../../../plugins/builtin/canvas/canvas-types';
import { consumeCanvasNavigationHandoff, getCanvasNavigationHandoff } from '../../../plugins/builtin/canvas/canvas-navigation-handoff';
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

beforeEach(() => {
  useProjectStore.setState({ projects, activeProjectId: 'nav-one', projectsLoaded: true, gitStatus: { 'nav-one': false, 'nav-two': false } });
  useUIStore.setState({ explorerTab: 'agents', activeHostId: null, dispatcherOpen: false });
  useAgentStore.setState({ agents: { lead }, activeAgentId: lead.id });
  useMcpBindingStore.setState({ bindings: [] });
  useGroupProjectStore.setState({ projects: [], loaded: false, loadError: null });
  usePluginStore.setState({ plugins: {}, appEnabled: [], projectEnabled: {} });
  for (const store of [useAppCanvasStore, ...projects.map((project) => getProjectCanvasStore(project.id))]) {
    const handoff = getCanvasNavigationHandoff(store);
    if (handoff) consumeCanvasNavigationHandoff(store, handoff);
    store.setState({ canvases: [], views: [], loaded: false, wiresLoaded: false, selectedViewId: null, wireDefinitions: [], zoneWireDefinitions: [] });
  }
  window.clubhouse.canvas.getTargetCanvases = vi.fn(async () => indexed());
  window.clubhouse.canvas.readForNavigation = vi.fn(async () => snapshot());
  window.clubhouse.canvas.resolveAgentTarget = vi.fn(async () => ({
    project: projects[1], config: { id: 'actual-agent', name: 'Renamed agent', color: 'teal', createdAt: 'today' },
  }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
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
    getProjectCanvasStore('nav-two').setState({ loaded: false });
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

  it('lets loaded live deletions override saved hits and unreadable saved copies, but never hides an incomplete scope inventory', () => {
    const index = indexed();
    index.stores[2].error = 'Unreadable saved copy';
    getProjectCanvasStore('nav-two').setState({ loaded: true, canvases: [] });
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
    expect(useUIStore.getState().explorerTab).toBe('plugin:browser');
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(usePluginStore.getState().appEnabled).toBe(before);
  });
});
