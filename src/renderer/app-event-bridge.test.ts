import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type StoreSubscriber = (...args: unknown[]) => void;

// ─── Mock window.clubhouse ──────────────────────────────────────────────────

const mockRemovers = {
  onOpenSettings: vi.fn(),
  onOpenAbout: vi.fn(),
  onNotificationClicked: vi.fn(),
  onAgentAttention: vi.fn(),
  onRequestAgentState: vi.fn(),
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
  onAgentMaterializationFailed: vi.fn(),
  onAgentSleeping: vi.fn(),
  onAgentSleepReason: vi.fn(),
  onDurableCreationEvent: vi.fn(),
  onHelperDisposeRequest: vi.fn(),
  onAgentSpawned: vi.fn(),
  onEditCommand: vi.fn(),
  onStatusChanged: vi.fn(),
  onLockStateChanged: vi.fn(),
  onSatellitesChanged: vi.fn(),
  onDiscoveredChanged: vi.fn(),
  onSatelliteEvent: vi.fn(),
  onProtocolAction: vi.fn(),
  onPermissionPending: vi.fn(),
  onPermissionSettled: vi.fn(),
  onChatEvent: vi.fn(),
  onChatRuntimeNotice: vi.fn(),
};

vi.stubGlobal('window', {
  clubhouse: {
    app: {
      onOpenSettings: vi.fn(() => mockRemovers.onOpenSettings),
      onOpenAbout: vi.fn(() => mockRemovers.onOpenAbout),
      onNotificationClicked: vi.fn(() => mockRemovers.onNotificationClicked),
      onAgentAttention: vi.fn(() => mockRemovers.onAgentAttention),
      onProtocolAction: vi.fn(() => mockRemovers.onProtocolAction),
      getPendingProtocolAction: vi.fn(() => Promise.resolve(null)),
    },
    window: {
      isPopout: vi.fn(() => false),
      onRequestAgentState: vi.fn(() => mockRemovers.onRequestAgentState),
      respondAgentState: vi.fn(),
      broadcastAgentState: vi.fn(),
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
      onAgentMaterializationFailed: vi.fn(() => mockRemovers.onAgentMaterializationFailed),
      onAgentSleeping: vi.fn(() => mockRemovers.onAgentSleeping),
      onAgentSleepReason: vi.fn(() => mockRemovers.onAgentSleepReason),
      onDurableCreationEvent: vi.fn(() => mockRemovers.onDurableCreationEvent),
      onHelperDisposeRequest: vi.fn(() => mockRemovers.onHelperDisposeRequest),
      readTranscript: vi.fn(),
      readQuickSummary: vi.fn(),
      killAgent: vi.fn(),
      listPendingPermissions: vi.fn(async () => []),
      resolvePendingPermission: vi.fn(async () => ({ status: 'resolved' })),
      onPermissionPending: vi.fn(() => mockRemovers.onPermissionPending),
      onPermissionSettled: vi.fn(() => mockRemovers.onPermissionSettled),
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
    chat: {
      onEvent: vi.fn(() => mockRemovers.onChatEvent),
      onRuntimeNotice: vi.fn(() => mockRemovers.onChatRuntimeNotice),
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

const mockNoteLaunchFailure = vi.fn();
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
        noteLaunchFailure: mockNoteLaunchFailure,
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

const mockAddToast = vi.hoisted(() => vi.fn());
vi.mock('./stores/toastStore', () => ({
  useToastStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        addToast: mockAddToast,
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

const mockCheckAndNotify = vi.hoisted(() => vi.fn());
vi.mock('./stores/notificationStore', () => ({
  useNotificationStore: Object.assign(
    vi.fn(),
    {
      getState: vi.fn(() => ({
        checkAndNotify: mockCheckAndNotify,
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

vi.mock('./plugins/builtin/canvas/main', () => ({
  useAppCanvasStore: { getState: () => ({ canvases: [] }) },
  getProjectCanvasStore: vi.fn(() => ({ getState: () => ({ canvases: [] }) })),
  hasProjectCanvasStore: vi.fn(() => false),
}));

vi.mock('./plugins/builtin/canvas/canvas-sync', () => ({
  applyCanvasMutation: vi.fn(),
}));

const mockShowStructuredModeRemovedNotice = vi.fn(async () => {});
vi.mock('./services/structured-mode-removal-notice', () => ({
  showStructuredModeRemovedNotice: () => mockShowStructuredModeRemovedNotice(),
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

import { useHelperDisposeRequestStore } from './stores/helperDisposeRequestStore';
import { initAppEventBridge, handleProtocolAction } from './app-event-bridge';
import { useAgentStore } from './stores/agentStore';
import { useQuickAgentStore } from './stores/quickAgentStore';
import { useProjectStore } from './stores/projectStore';
import { useUIStore } from './stores/uiStore';
import { useToastStore } from './stores/toastStore';
import { fileState } from './plugins/builtin/files/state';
import { usePendingPermissionStore } from './stores/pendingPermissionStore';

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
    expect(window.clubhouse.app.onAgentAttention).toHaveBeenCalled();
    expect(window.clubhouse.window.onRequestAgentState).toHaveBeenCalled();
    expect(window.clubhouse.window.onRequestCanvasState).toHaveBeenCalled();
    expect(window.clubhouse.window.onCanvasMutation).toHaveBeenCalled();
    expect(window.clubhouse.window.onNavigateToAgent).toHaveBeenCalled();
    expect(window.clubhouse.window.onNavigateToPluginSettings).toHaveBeenCalled();
  });

  it('shows the one-time structured-mode-removed notice on init', () => {
    expect(mockShowStructuredModeRemovedNotice).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing structured-mode-removed notice break init', () => {
    cleanup();
    mockShowStructuredModeRemovedNotice.mockRejectedValueOnce(new Error('IPC down'));
    expect(() => { cleanup = initAppEventBridge(); }).not.toThrow();
    expect(mockShowStructuredModeRemovedNotice).toHaveBeenCalledTimes(2);
  });

  it('subscribes to chat events and unsubscribes on cleanup', () => {
    expect(window.clubhouse.chat.onEvent).toHaveBeenCalledTimes(1);
    cleanup();
    expect(mockRemovers.onChatEvent).toHaveBeenCalledTimes(1);
    cleanup = initAppEventBridge();
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

  describe('quick agent completion (#2033)', () => {
    let lastSelectCompleted: ReturnType<typeof vi.fn> = vi.fn();
    async function exitQuickAgent(agent: Record<string, unknown>, transcript: string | null, exitCode: number, lastOutput?: string, activeAgentId: string | null = null) {
      const addCompleted = vi.fn();
      const removeAgent = vi.fn();
      const selectCompleted = vi.fn();
      lastSelectCompleted = selectCompleted;
      vi.mocked(useAgentStore.getState).mockReturnValue({
        agents: { q1: agent },
        agentSpawnedAt: { q1: 1_000 },
        activeAgentId,
        agentDetailedStatus: {},
        agentIcons: {},
        updateAgentStatus: vi.fn(),
        handleHookEvent: vi.fn(),
        removeAgent,
        clearStaleStatuses: vi.fn(),
        setActiveAgent: vi.fn(),
        restoreProjectAgent: vi.fn(),
        openConfigChangesDialog: vi.fn(),
        setSessionNamePrompt: vi.fn(),
      } as any);
      vi.mocked(useQuickAgentStore.getState).mockReturnValue({ addCompleted, selectCompleted } as any);
      vi.mocked(window.clubhouse.agent.readTranscript).mockResolvedValue(transcript as any);

      const onExit = vi.mocked(window.clubhouse.pty.onExit).mock.calls[0][0];
      await onExit('q1', exitCode, lastOutput);
      expect(removeAgent).toHaveBeenCalledWith('q1');
      return addCompleted.mock.calls[0][0];
    }

    const headlessAgent = {
      id: 'q1', projectId: 'p1', name: 'quick-fox', kind: 'quick', status: 'running', mission: 'fix it',
      headless: true, orchestrator: 'claude-code', freeAgentMode: true, runCwd: '/repo/wt', runBaseSha: 'abc1234',
    };

    it('records files, stats, cwd, base sha and start time for a finished headless run', async () => {
      const lines = [
        { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/repo/wt/a.ts' } }], usage: { input_tokens: 10, output_tokens: 2 } }, _ts: 2_000 },
        { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/wt/b.ts' } }], usage: { input_tokens: 5, output_tokens: 1 } }, _ts: 3_000 },
        { type: 'result', result: 'Edited two files', total_cost_usd: 0.12, duration_ms: 4_000, _ts: 5_000 },
      ];
      const record = await exitQuickAgent(headlessAgent, lines.map((l) => JSON.stringify(l)).join('\n'), 0);

      expect(record).toMatchObject({
        id: 'q1',
        summary: 'Edited two files',
        filesModified: ['/repo/wt/a.ts', '/repo/wt/b.ts'],
        exitCode: 0,
        headless: true,
        costUsd: 0.12,
        durationMs: 4_000,
        toolsUsed: ['Write', 'Edit'],
        toolCalls: 2,
        inputTokens: 15,
        outputTokens: 3,
        cwd: '/repo/wt',
        baseSha: 'abc1234',
        startedAt: 1_000,
        freeAgentMode: true,
      });
      expect(record.stderrTail).toBeUndefined();
    });

    it('keeps the stderr tail and the failing exit code when a headless run fails', async () => {
      const record = await exitQuickAgent(headlessAgent, '', 1, 'Error: invalid API key');
      expect(record).toMatchObject({ summary: null, exitCode: 1, stderrTail: 'Error: invalid API key', filesModified: [] });
    });

    it('keeps the finished run on screen when it was the agent being viewed (#2019)', async () => {
      await exitQuickAgent(headlessAgent, '', 0, undefined, 'q1');
      expect(lastSelectCompleted).toHaveBeenCalledWith('q1');
    });

    it('does not select the finished run when another agent is on screen', async () => {
      await exitQuickAgent(headlessAgent, '', 0, undefined, 'other');
      expect(lastSelectCompleted).not.toHaveBeenCalled();
    });

    it('does not treat PTY output as stderr for non-headless quick agents', async () => {
      vi.mocked(window.clubhouse.agent.readQuickSummary).mockResolvedValue({ summary: 'done', filesModified: ['x.ts'] } as any);
      const record = await exitQuickAgent({ ...headlessAgent, headless: undefined }, null, 0, 'terminal noise');
      expect(record).toMatchObject({ summary: 'done', filesModified: ['x.ts'], cwd: '/repo/wt', startedAt: 1_000 });
      expect(record.stderrTail).toBeUndefined();
    });
  });

  it('shows a toast when materialization fails but the agent continues waking', () => {
    expect(window.clubhouse.agent.onAgentMaterializationFailed).toHaveBeenCalled();
    const onMaterializationFailed = vi.mocked(window.clubhouse.agent.onAgentMaterializationFailed).mock.calls[0][0];

    onMaterializationFailed('agent-1', 'malformed wildcard template');

    expect(mockAddToast).toHaveBeenCalledWith(
      'Agent agent-1 started without the latest Clubhouse Mode settings: malformed wildcard template',
      'error',
    );
  });

  it('shows a toast with the reason when an agent falls back from chat', () => {
    const onRuntimeNotice = vi.mocked(window.clubhouse.chat.onRuntimeNotice).mock.calls[0][0];
    onRuntimeNotice('agent-unknown', { level: 'warn', code: 'fallback', message: 'Opened in the terminal: Claude Code (Agent SDK) handshake failed: boom' });
    expect(mockAddToast).toHaveBeenCalledWith('agent-unknown: Opened in the terminal: Claude Code (Agent SDK) handshake failed: boom', 'info');
  });

  it('keeps the chat fallback reason for the launch error card (#2088)', () => {
    const onRuntimeNotice = vi.mocked(window.clubhouse.chat.onRuntimeNotice).mock.calls[0][0];
    onRuntimeNotice('agent-1', { level: 'warn', code: 'fallback', message: 'Opened in the terminal: Codex (app-server) failed to start: no rollout found for thread id 562a' });
    expect(mockNoteLaunchFailure).toHaveBeenCalledWith('agent-1', 'Codex (app-server) failed to start: no rollout found for thread id 562a');

    mockNoteLaunchFailure.mockClear();
    onRuntimeNotice('agent-1', { level: 'info', code: 'untested_cli_version', message: 'Codex 0.200 is untested' });
    expect(mockNoteLaunchFailure).not.toHaveBeenCalled();
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

  it('does NOT surface a toast for orchestrator notification-hook events (auto-grab removed)', () => {
    // Regression guard for the #1507 auto-grab: Claude Code's own "Claude is
    // waiting for your input" Notification hook must no longer produce a toast.
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
      message: 'Claude is waiting for your input',
      timestamp: Date.now(),
    });

    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('routes agent attention (notify_user) to checkAndNotify with the attention kind', () => {
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

    const attentionCallback = vi.mocked(window.clubhouse.app.onAgentAttention).mock.calls[0][0];
    attentionCallback('a1', { message: 'Need a decision', title: 'Blocked' });

    expect(mockCheckAndNotify).toHaveBeenCalledWith(
      agent.name,
      'attention',
      undefined,
      'a1',
      'proj-1',
      { message: 'Need a decision', title: 'Blocked' },
    );
  });

  it('routes agent attention for an unknown agent with a generic name and no crash', () => {
    vi.mocked(useAgentStore.getState).mockReturnValue({
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
    } as any);

    const attentionCallback = vi.mocked(window.clubhouse.app.onAgentAttention).mock.calls[0][0];
    attentionCallback('ghost', { message: 'hello' });

    expect(mockCheckAndNotify).toHaveBeenCalledWith(
      'Agent',
      'attention',
      undefined,
      'ghost',
      undefined,
      { message: 'hello' },
    );
  });

  it('puts a dispose the user decides under Needs you with the facts, without opening the delete dialog (#2229)', () => {
    const openDeleteDialog = vi.fn();
    useHelperDisposeRequestStore.setState({ requests: {} });
    vi.mocked(useAgentStore.getState).mockReturnValue({
      agents: {
        orch: { id: 'orch', name: 'Orchestrator', projectId: 'proj-1', kind: 'durable', status: 'running' },
        helper: { id: 'helper', name: 'Docs', projectId: 'proj-1', kind: 'durable', status: 'running' },
      },
      deleteDialogAgent: null,
      openDeleteDialog,
    } as any);

    const callback = vi.mocked(window.clubhouse.agent.onHelperDisposeRequest).mock.calls[0][0];
    const request = {
      projectPath: '/p', orchestratorId: 'orch', helperId: 'helper', helperName: 'Docs',
      checks: { dirty: 2, unpushed: 1, unmerged: 0 }, forceRequested: true,
    };
    callback(request);

    expect(openDeleteDialog).not.toHaveBeenCalled();
    expect(useHelperDisposeRequestStore.getState().requests.helper).toMatchObject({ request, orchestratorName: 'Orchestrator' });
    // The notification is on the helper, so clicking it selects the helper.
    expect(mockCheckAndNotify).toHaveBeenCalledWith(
      'Docs', 'attention', undefined, 'helper', 'proj-1',
      {
        title: 'Orchestrator asked to dispose Docs',
        message: 'Orchestrator asked to dispose this helper (forced). 2 uncommitted files, 1 unpushed commit.',
      },
    );
  });

  it('ignores a dispose request for a helper this window does not have', () => {
    useHelperDisposeRequestStore.setState({ requests: {} });
    vi.mocked(useAgentStore.getState).mockReturnValue({ agents: {}, deleteDialogAgent: null, openDeleteDialog: vi.fn() } as any);
    const callback = vi.mocked(window.clubhouse.agent.onHelperDisposeRequest).mock.calls[0][0];
    callback({
      projectPath: '/p', orchestratorId: 'orch', helperId: 'ghost', helperName: 'Ghost',
      checks: { dirty: 0, unpushed: 0, unmerged: 0 }, forceRequested: false,
    });
    expect(useHelperDisposeRequestStore.getState().requests).toEqual({});
    expect(mockCheckAndNotify).not.toHaveBeenCalled();
  });

  it('registers the protocol action listener and pulls any pending action', () => {
    expect(window.clubhouse.app.onProtocolAction).toHaveBeenCalled();
    expect(window.clubhouse.app.getPendingProtocolAction).toHaveBeenCalled();
  });


  // ── Durable permission queue (issue #1553) ───────────────────────────
  describe('permission queue listeners', () => {
    it('subscribes to pending and settled permission broadcasts', () => {
      expect(window.clubhouse.agent.onPermissionPending).toHaveBeenCalled();
      expect(window.clubhouse.agent.onPermissionSettled).toHaveBeenCalled();
    });

    it('seeds the store from the main process so a reload keeps live prompts', async () => {
      const pending = {
        requestId: 'req-hydrate', agentId: 'agent-1', toolName: 'Skill',
        createdAt: 1_000, timeoutMs: 110_000,
      };
      vi.mocked(window.clubhouse.agent.listPendingPermissions).mockResolvedValueOnce([pending]);

      cleanup();
      cleanup = initAppEventBridge();
      await vi.waitFor(() => {
        expect(usePendingPermissionStore.getState().byRequestId['req-hydrate']).toBeDefined();
      });
    });

    it('adds a request when the pending broadcast fires', () => {
      usePendingPermissionStore.setState({ byRequestId: {} });
      const callback = vi.mocked(window.clubhouse.agent.onPermissionPending).mock.calls[0][0];

      callback('agent-1', {
        requestId: 'req-new', agentId: 'agent-1', toolName: 'AskUserQuestion',
        createdAt: 2_000, timeoutMs: 110_000,
      });

      expect(usePendingPermissionStore.getState().byRequestId['req-new']).toMatchObject({
        toolName: 'AskUserQuestion',
      });
    });

    it('drops a request when the settled broadcast fires', () => {
      usePendingPermissionStore.setState({
        byRequestId: {
          'req-gone': {
            requestId: 'req-gone', agentId: 'agent-1', toolName: 'Skill',
            createdAt: 1_000, timeoutMs: 110_000,
          },
        },
      });
      const callback = vi.mocked(window.clubhouse.agent.onPermissionSettled).mock.calls[0][0];

      callback('agent-1', { requestId: 'req-gone', agentId: 'agent-1', decision: 'ask' });

      expect(usePendingPermissionStore.getState().byRequestId['req-gone']).toBeUndefined();
    });

    it('removes the listeners on cleanup', () => {
      cleanup();
      expect(mockRemovers.onPermissionPending).toHaveBeenCalled();
      expect(mockRemovers.onPermissionSettled).toHaveBeenCalled();
      cleanup = initAppEventBridge();
    });
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
