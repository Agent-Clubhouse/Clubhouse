import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type StoreSubscriber = (...args: unknown[]) => void;

// ─── Mock window.clubhouse ──────────────────────────────────────────────────

const mockRemovers = {
  onOpenSettings: vi.fn(),
  onOpenAbout: vi.fn(),
  onNotificationClicked: vi.fn(),
  onRequestAgentState: vi.fn(),
  onRequestHubState: vi.fn(),
  onHubMutation: vi.fn(),
  onRequestCanvasState: vi.fn(),
  onCanvasMutation: vi.fn(),
  onRequestDurableReload: vi.fn(),
  onNavigateToAgent: vi.fn(),
  onNavigateToPluginSettings: vi.fn(),
  onExit: vi.fn(),
  onHookEvent: vi.fn(),
  onAgentWaking: vi.fn(),
  onAgentAwoke: vi.fn(),
  onAgentWakeFailed: vi.fn(),
  onAgentSleeping: vi.fn(),
  onAgentSpawned: vi.fn(),
  onEditCommand: vi.fn(),
  onStatusChanged: vi.fn(),
  onLockStateChanged: vi.fn(),
  onSatellitesChanged: vi.fn(),
  onDiscoveredChanged: vi.fn(),
  onSatelliteEvent: vi.fn(),
  onProtocolAction: vi.fn(),
};

vi.stubGlobal('window', {
  clubhouse: {
    app: {
      onOpenSettings: vi.fn(() => mockRemovers.onOpenSettings),
      onOpenAbout: vi.fn(() => mockRemovers.onOpenAbout),
      onNotificationClicked: vi.fn(() => mockRemovers.onNotificationClicked),
      onProtocolAction: vi.fn(() => mockRemovers.onProtocolAction),
      getPendingProtocolAction: vi.fn(() => Promise.resolve(null)),
    },
    window: {
      isPopout: vi.fn(() => false),
      onRequestAgentState: vi.fn(() => mockRemovers.onRequestAgentState),
      respondAgentState: vi.fn(),
      broadcastAgentState: vi.fn(),
      onRequestHubState: vi.fn(() => mockRemovers.onRequestHubState),
      respondHubState: vi.fn(),
      onHubMutation: vi.fn(() => mockRemovers.onHubMutation),
      onRequestCanvasState: vi.fn(() => mockRemovers.onRequestCanvasState),
      respondCanvasState: vi.fn(),
      onCanvasMutation: vi.fn(() => mockRemovers.onCanvasMutation),
      onRequestDurableReload: vi.fn(() => mockRemovers.onRequestDurableReload),
      onNavigateToAgent: vi.fn(() => mockRemovers.onNavigateToAgent),
      onNavigateToPluginSettings: vi.fn(() => mockRemovers.onNavigateToPluginSettings),
    },
    pty: {
      onExit: vi.fn(() => mockRemovers.onExit),
      kill: vi.fn(),
    },
    agent: {
      onHookEvent: vi.fn(() => mockRemovers.onHookEvent),
      onAgentWaking: vi.fn(() => mockRemovers.onAgentWaking),
      onAgentAwoke: vi.fn(() => mockRemovers.onAgentAwoke),
      onAgentWakeFailed: vi.fn(() => mockRemovers.onAgentWakeFailed),
      onAgentSleeping: vi.fn(() => mockRemovers.onAgentSleeping),
      readTranscript: vi.fn(),
      readQuickSummary: vi.fn(),
      killAgent: vi.fn(),
    },
    annex: {
      onAgentSpawned: vi.fn(() => mockRemovers.onAgentSpawned),
      onStatusChanged: vi.fn(() => mockRemovers.onStatusChanged),
      onLockStateChanged: vi.fn(() => mockRemovers.onLockStateChanged),
    },
    annexClient: {
      onSatellitesChanged: vi.fn(() => mockRemovers.onSatellitesChanged),
      onDiscoveredChanged: vi.fn(() => mockRemovers.onDiscoveredChanged),
      onSatelliteEvent: vi.fn(() => mockRemovers.onSatelliteEvent),
    },
    agentSettings: {
      computeConfigDiff: vi.fn(),
    },
    mcpBinding: {
      getBindings: vi.fn(async () => []),
      bind: vi.fn(),
      unbind: vi.fn(),
      registerWebview: vi.fn(),
      unregisterWebview: vi.fn(),
      onBindingsChanged: vi.fn(() => vi.fn()),
    },
    settings: {
      get: vi.fn(async () => null),
      save: vi.fn(),
    },
  },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

// ─── Mock stores ────────────────────────────────────────────────────────────

const agentSubscribers: StoreSubscriber[] = [];
const projectSubscribers: StoreSubscriber[] = [];
const uiSubscribers: StoreSubscriber[] = [];
const mockPlaySound = vi.fn();

function createAgentState(overrides: Record<string, unknown> = {}) {
  return {
    agents: {},
    activeAgentId: null,
    agentDetailedStatus: {},
    agentIcons: {},
    ...overrides,
  };
}

function createAgent(id: string, projectId: string) {
  return {
    id,
    name: `Agent ${id}`,
    projectId,
    status: 'running',
    kind: 'durable',
  };
}

vi.mock('./stores/agentStore', () => ({
  useAgentStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        agents: {},
        activeAgentId: null,
        agentDetailedStatus: {},
        agentIcons: {},
        updateAgentStatus: vi.fn(),
        handleHookEvent: vi.fn(),
        removeAgent: vi.fn(),
        clearStaleStatuses: vi.fn(),
        setActiveAgent: vi.fn(),
        restoreProjectAgent: vi.fn(),
        openConfigChangesDialog: vi.fn(),
        setSessionNamePrompt: vi.fn(),
      })),
      setState: vi.fn(),
      subscribe: vi.fn((cb: StoreSubscriber) => {
        agentSubscribers.push(cb);
        return vi.fn();
      }),
    },
  ),
  consumeCancelled: vi.fn(() => false),
}));

vi.mock('./stores/projectStore', () => ({
  useProjectStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        activeProjectId: null,
        projects: [],
        setActiveProject: vi.fn(),
      })),
      subscribe: vi.fn((cb: StoreSubscriber) => {
        projectSubscribers.push(cb);
        return vi.fn();
      }),
    },
  ),
}));

vi.mock('./stores/uiStore', () => ({
  useUIStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        explorerTab: 'agents',
        toggleSettings: vi.fn(),
        openAbout: vi.fn(),
        setSettingsSubPage: vi.fn(),
        setExplorerTab: vi.fn(),
      })),
      subscribe: vi.fn((cb: StoreSubscriber) => {
        uiSubscribers.push(cb);
        return vi.fn();
      }),
    },
  ),
}));

vi.mock('./stores/toastStore', () => ({
  useToastStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        addToast: vi.fn(),
        removeToast: vi.fn(),
      })),
    },
  ),
}));

vi.mock('./plugins/builtin/files/state', () => ({
  fileState: {
    openTab: vi.fn(),
  },
}));

vi.mock('./stores/notificationStore', () => ({
  useNotificationStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        checkAndNotify: vi.fn(),
        clearNotification: vi.fn(),
      })),
    },
  ),
  isAgentVisible: vi.fn(() => false),
}));

vi.mock('./stores/quickAgentStore', () => ({
  useQuickAgentStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        addCompleted: vi.fn(),
      })),
    },
  ),
}));

vi.mock('./stores/clubhouseModeStore', () => ({
  useClubhouseModeStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        isEnabledForProject: vi.fn(() => false),
      })),
    },
  ),
}));

vi.mock('./stores/commandPaletteStore', () => ({
  useCommandPaletteStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({ isOpen: false })),
    },
  ),
}));

vi.mock('./stores/keyboardShortcutsStore', () => ({
  useKeyboardShortcutsStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({ editingId: null, shortcuts: {} })),
    },
  ),
  eventToBinding: vi.fn(() => null),
}));

vi.mock('./features/command-palette/command-actions', () => ({
  getCommandActions: vi.fn(() => []),
}));

vi.mock('./plugins/plugin-hotkeys', () => ({
  pluginHotkeyRegistry: { findByBinding: vi.fn(() => null) },
}));

vi.mock('./plugins/plugin-events', () => ({
  pluginEventBus: { emit: vi.fn() },
}));

vi.mock('./plugins/builtin/hub/main', () => ({
  getProjectHubStore: vi.fn(() => ({ getState: () => ({ hubs: [] }) })),
  useAppHubStore: { getState: () => ({ hubs: [] }) },
}));

vi.mock('./plugins/builtin/hub/hub-sync', () => ({
  applyHubMutation: vi.fn(),
}));

vi.mock('./plugins/builtin/canvas/main', () => ({
  useAppCanvasStore: { getState: () => ({ canvases: [] }) },
  getProjectCanvasStore: vi.fn(() => ({ getState: () => ({ canvases: [] }) })),
  hasProjectCanvasStore: vi.fn(() => false),
}));

vi.mock('./plugins/builtin/canvas/canvas-sync', () => ({
  applyCanvasMutation: vi.fn(),
}));


vi.mock('./stores/soundStore', () => ({
  useSoundStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        playSound: mockPlaySound,
      })),
    },
  ),
}));

import { initAppEventBridge, handleProtocolAction } from './app-event-bridge';
import { useAgentStore } from './stores/agentStore';
import { useProjectStore } from './stores/projectStore';
import { useUIStore } from './stores/uiStore';
import { isAgentVisible } from './stores/notificationStore';
import { useToastStore } from './stores/toastStore';
import { fileState } from './plugins/builtin/files/state';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('initAppEventBridge', () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlaySound.mockResolvedValue(undefined);
    agentSubscribers.length = 0;
    projectSubscribers.length = 0;
    uiSubscribers.length = 0;
    cleanup = initAppEventBridge();
  });

  afterEach(() => {
    cleanup();
  });

  it('should register all window/app IPC listeners', () => {
    expect(window.clubhouse.app.onOpenSettings).toHaveBeenCalled();
    expect(window.clubhouse.app.onOpenAbout).toHaveBeenCalled();
    expect(window.clubhouse.app.onNotificationClicked).toHaveBeenCalled();
    expect(window.clubhouse.window.onRequestAgentState).toHaveBeenCalled();
    expect(window.clubhouse.window.onRequestHubState).toHaveBeenCalled();
    expect(window.clubhouse.window.onHubMutation).toHaveBeenCalled();
    expect(window.clubhouse.window.onRequestCanvasState).toHaveBeenCalled();
    expect(window.clubhouse.window.onCanvasMutation).toHaveBeenCalled();
    expect(window.clubhouse.window.onNavigateToAgent).toHaveBeenCalled();
    expect(window.clubhouse.window.onNavigateToPluginSettings).toHaveBeenCalled();
  });

  it('should register agent lifecycle listeners', () => {
    expect(window.clubhouse.pty.onExit).toHaveBeenCalled();
    expect(window.clubhouse.agent.onHookEvent).toHaveBeenCalled();
    expect(window.clubhouse.annex.onAgentSpawned).toHaveBeenCalled();
  });

  // Wave 10 #10: when a remote caller (MCP wake_agent, plugin) wakes an agent
  // in main, the renderer needs the AGENT_AWOKE signal to flip the card from
  // the sleeping mascot to the live PTY view.  Regression guard for the
  // missing subscription that left agents stuck in 'waking' forever.
  it('subscribes to onAgentAwoke and flips status to running', () => {
    expect(window.clubhouse.agent.onAgentAwoke).toHaveBeenCalled();
    const updateAgentStatus = vi.fn();
    vi.mocked(useAgentStore.getState).mockReturnValue({
      agents: {},
      activeAgentId: null,
      agentDetailedStatus: {},
      agentIcons: {},
      updateAgentStatus,
      handleHookEvent: vi.fn(),
      removeAgent: vi.fn(),
      clearStaleStatuses: vi.fn(),
      setActiveAgent: vi.fn(),
      restoreProjectAgent: vi.fn(),
      openConfigChangesDialog: vi.fn(),
      setSessionNamePrompt: vi.fn(),
    } as any);

    const awokeCallback = vi.mocked(window.clubhouse.agent.onAgentAwoke).mock.calls[0][0];
    awokeCallback('agent-7');

    expect(updateAgentStatus).toHaveBeenCalledWith('agent-7', 'running');
  });

  it('should register keyboard event listener', () => {
    expect(window.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should subscribe to agentStore for status change emitter', () => {
    expect(useAgentStore.subscribe).toHaveBeenCalled();
  });

  it('should subscribe to stores for notification clearing', () => {
    // Notification clearing subscribes to agent, project, and UI stores
    expect(useAgentStore.subscribe).toHaveBeenCalled();
    expect(useProjectStore.subscribe).toHaveBeenCalled();
    expect(useUIStore.subscribe).toHaveBeenCalled();
  });

  it('should return a cleanup function', () => {
    expect(typeof cleanup).toBe('function');
  });

  it('should remove keyboard listener on cleanup', () => {
    cleanup();
    expect(window.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('should access stores via getState() not hooks', () => {
    // The hook event handler should use getState()
    const hookCallback = vi.mocked(window.clubhouse.agent.onHookEvent).mock.calls[0][0];
    hookCallback('agent_1', {
      kind: 'pre_tool',
      toolName: 'Bash',
      timestamp: Date.now(),
    });

    expect(useAgentStore.getState).toHaveBeenCalled();
  });

  it('plays agent-focus when the active agent changes', () => {
    const agents = {
      a1: createAgent('a1', 'proj-1'),
      a2: createAgent('a2', 'proj-2'),
    };
    const prevState = createAgentState({ activeAgentId: 'a1', agents });
    const nextState = createAgentState({ activeAgentId: 'a2', agents });

    for (const subscriber of agentSubscribers) {
      subscriber(nextState, prevState);
    }

    expect(mockPlaySound).toHaveBeenCalledWith('agent-focus', 'proj-2');
  });

  it('plays permission-granted sound on permission_resolved with allow', () => {
    const agent = createAgent('a1', 'proj-1');
    vi.mocked(useAgentStore.getState).mockReturnValue({
      agents: { a1: agent },
      activeAgentId: null,
      agentDetailedStatus: {},
      agentIcons: {},
      updateAgentStatus: vi.fn(),
      handleHookEvent: vi.fn(),
      removeAgent: vi.fn(),
      clearStaleStatuses: vi.fn(),
      setActiveAgent: vi.fn(),
      restoreProjectAgent: vi.fn(),
      openConfigChangesDialog: vi.fn(),
      setSessionNamePrompt: vi.fn(),
    } as any);

    const hookCallback = vi.mocked(window.clubhouse.agent.onHookEvent).mock.calls[0][0];
    hookCallback('a1', {
      kind: 'permission_resolved',
      toolName: 'Bash',
      message: 'allow',
      timestamp: Date.now(),
    });

    expect(mockPlaySound).toHaveBeenCalledWith('permission-granted', 'proj-1');
  });

  it('plays permission-denied sound on permission_resolved with deny', () => {
    const agent = createAgent('a1', 'proj-1');
    vi.mocked(useAgentStore.getState).mockReturnValue({
      agents: { a1: agent },
      activeAgentId: null,
      agentDetailedStatus: {},
      agentIcons: {},
      updateAgentStatus: vi.fn(),
      handleHookEvent: vi.fn(),
      removeAgent: vi.fn(),
      clearStaleStatuses: vi.fn(),
      setActiveAgent: vi.fn(),
      restoreProjectAgent: vi.fn(),
      openConfigChangesDialog: vi.fn(),
      setSessionNamePrompt: vi.fn(),
    } as any);

    const hookCallback = vi.mocked(window.clubhouse.agent.onHookEvent).mock.calls[0][0];
    hookCallback('a1', {
      kind: 'permission_resolved',
      toolName: 'Bash',
      message: 'deny',
      timestamp: Date.now(),
    });

    expect(mockPlaySound).toHaveBeenCalledWith('permission-denied', 'proj-1');
  });

  it('does not play agent-focus when the active agent is unchanged or cleared', () => {
    const agents = {
      a1: createAgent('a1', 'proj-1'),
    };
    const activeState = createAgentState({ activeAgentId: 'a1', agents });
    const clearedState = createAgentState({ agents });

    for (const subscriber of agentSubscribers) {
      subscriber(activeState, createAgentState());
    }

    mockPlaySound.mockClear();

    for (const subscriber of agentSubscribers) {
      subscriber(activeState, activeState);
      subscriber(clearedState, activeState);
    }

    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it('shows toast notification when agent emits notification event and agent is not visible', () => {
    const agent = createAgent('a1', 'proj-1');
    vi.mocked(useAgentStore.getState).mockReturnValue({
      agents: { a1: agent },
      activeAgentId: null,
      agentDetailedStatus: {},
      agentIcons: {},
      updateAgentStatus: vi.fn(),
      handleHookEvent: vi.fn(),
      removeAgent: vi.fn(),
      clearStaleStatuses: vi.fn(),
      setActiveAgent: vi.fn(),
      restoreProjectAgent: vi.fn(),
      openConfigChangesDialog: vi.fn(),
      setSessionNamePrompt: vi.fn(),
    } as any);

    const mockAddToast = vi.fn();
    vi.mocked(useToastStore.getState).mockReturnValue({
      addToast: mockAddToast,
      removeToast: vi.fn(),
      toasts: [],
    } as any);

    vi.mocked(isAgentVisible).mockReturnValue(false);

    const hookCallback = vi.mocked(window.clubhouse.agent.onHookEvent).mock.calls[0][0];
    hookCallback('a1', {
      kind: 'notification',
      message: 'Agent completed successfully',
      timestamp: Date.now(),
    });

    expect(mockAddToast).toHaveBeenCalledWith('Agent completed successfully', 'info');
  });

  it('does not show toast when agent is visible and emits notification event', () => {
    const agent = createAgent('a1', 'proj-1');
    vi.mocked(useAgentStore.getState).mockReturnValue({
      agents: { a1: agent },
      activeAgentId: 'a1',
      agentDetailedStatus: {},
      agentIcons: {},
      updateAgentStatus: vi.fn(),
      handleHookEvent: vi.fn(),
      removeAgent: vi.fn(),
      clearStaleStatuses: vi.fn(),
      setActiveAgent: vi.fn(),
      restoreProjectAgent: vi.fn(),
      openConfigChangesDialog: vi.fn(),
      setSessionNamePrompt: vi.fn(),
    } as any);

    const mockAddToast = vi.fn();
    vi.mocked(useToastStore.getState).mockReturnValue({
      addToast: mockAddToast,
      removeToast: vi.fn(),
      toasts: [],
    } as any);

    vi.mocked(isAgentVisible).mockReturnValue(true);

    const hookCallback = vi.mocked(window.clubhouse.agent.onHookEvent).mock.calls[0][0];
    hookCallback('a1', {
      kind: 'notification',
      message: 'Agent is still running',
      timestamp: Date.now(),
    });

    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('does not show toast when notification event has no message', () => {
    const agent = createAgent('a1', 'proj-1');
    vi.mocked(useAgentStore.getState).mockReturnValue({
      agents: { a1: agent },
      activeAgentId: null,
      agentDetailedStatus: {},
      agentIcons: {},
      updateAgentStatus: vi.fn(),
      handleHookEvent: vi.fn(),
      removeAgent: vi.fn(),
      clearStaleStatuses: vi.fn(),
      setActiveAgent: vi.fn(),
      restoreProjectAgent: vi.fn(),
      openConfigChangesDialog: vi.fn(),
      setSessionNamePrompt: vi.fn(),
    } as any);

    const mockAddToast = vi.fn();
    vi.mocked(useToastStore.getState).mockReturnValue({
      addToast: mockAddToast,
      removeToast: vi.fn(),
      toasts: [],
    } as any);

    const hookCallback = vi.mocked(window.clubhouse.agent.onHookEvent).mock.calls[0][0];
    hookCallback('a1', {
      kind: 'notification',
      timestamp: Date.now(),
    });

    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('registers the protocol action listener and pulls any pending action', () => {
    expect(window.clubhouse.app.onProtocolAction).toHaveBeenCalled();
    expect(window.clubhouse.app.getPendingProtocolAction).toHaveBeenCalled();
  });

});

describe('handleProtocolAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('open-file activates the project, switches to the files tab, and opens the file', () => {
    vi.useFakeTimers();
    try {
      const setActiveProject = vi.fn();
      const setExplorerTab = vi.fn();
      vi.mocked(useProjectStore.getState).mockReturnValue({ setActiveProject } as never);
      vi.mocked(useUIStore.getState).mockReturnValue({ setExplorerTab } as never);

      handleProtocolAction({ kind: 'open-file', projectId: 'p1', relativePath: 'src/a.ts' });

      expect(setActiveProject).toHaveBeenCalledWith('p1');
      expect(setExplorerTab).toHaveBeenCalledWith('plugin:files', 'p1');
      // openTab is deferred to let the files panel mount
      expect(fileState.openTab).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(fileState.openTab).toHaveBeenCalledWith('src/a.ts', { preview: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('open-folder adds the project then switches to its files tab', async () => {
    const project = { id: 'p2', name: 'beta', path: '/tmp/beta' };
    const addProject = vi.fn().mockResolvedValue(project);
    const setExplorerTab = vi.fn();
    vi.mocked(useProjectStore.getState).mockReturnValue({ addProject } as never);
    vi.mocked(useUIStore.getState).mockReturnValue({ setExplorerTab } as never);

    handleProtocolAction({ kind: 'open-folder', folderPath: '/tmp/beta' });

    expect(addProject).toHaveBeenCalledWith('/tmp/beta');
    // Flush the addProject promise chain
    await Promise.resolve();
    await Promise.resolve();
    expect(setExplorerTab).toHaveBeenCalledWith('plugin:files', 'p2');
  });

  it('open-folder shows an error toast when adding the project fails', async () => {
    const addProject = vi.fn().mockRejectedValue(new Error('nope'));
    const addToast = vi.fn();
    vi.mocked(useProjectStore.getState).mockReturnValue({ addProject } as never);
    vi.mocked(useToastStore.getState).mockReturnValue({ addToast } as never);

    handleProtocolAction({ kind: 'open-folder', folderPath: '/tmp/beta' });

    // Flush the addProject rejection chain
    await Promise.resolve();
    await Promise.resolve();
    expect(addToast).toHaveBeenCalledWith('Failed to open folder as a project', 'error');
  });

  it('open-file-not-found shows an error toast naming the file', () => {
    const addToast = vi.fn();
    vi.mocked(useToastStore.getState).mockReturnValue({ addToast } as never);

    handleProtocolAction({ kind: 'open-file-not-found', filePath: '/x/y.ts' });

    expect(addToast).toHaveBeenCalledWith('No open project contains /x/y.ts', 'error');
  });
});
