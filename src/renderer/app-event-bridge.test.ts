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
  onNavigateToAgent: vi.fn(),
  onExit: vi.fn(),
  onHookEvent: vi.fn(),
  onAgentSpawned: vi.fn(),
  onEditCommand: vi.fn(),
};

vi.stubGlobal('window', {
  clubhouse: {
    app: {
      onOpenSettings: vi.fn(() => mockRemovers.onOpenSettings),
      onOpenAbout: vi.fn(() => mockRemovers.onOpenAbout),
      onNotificationClicked: vi.fn(() => mockRemovers.onNotificationClicked),
      onEditCommand: vi.fn(() => mockRemovers.onEditCommand),
    },
    window: {
      isPopout: vi.fn(() => false),
      onRequestAgentState: vi.fn(() => mockRemovers.onRequestAgentState),
      respondAgentState: vi.fn(),
      broadcastAgentState: vi.fn(),
      onRequestHubState: vi.fn(() => mockRemovers.onRequestHubState),
      respondHubState: vi.fn(),
      onHubMutation: vi.fn(() => mockRemovers.onHubMutation),
      onNavigateToAgent: vi.fn(() => mockRemovers.onNavigateToAgent),
    },
    pty: {
      onExit: vi.fn(() => mockRemovers.onExit),
      kill: vi.fn(),
    },
    agent: {
      onHookEvent: vi.fn(() => mockRemovers.onHookEvent),
      readTranscript: vi.fn(),
      readQuickSummary: vi.fn(),
      killAgent: vi.fn(),
    },
    annex: {
      onAgentSpawned: vi.fn(() => mockRemovers.onAgentSpawned),
    },
    agentSettings: {
      computeConfigDiff: vi.fn(),
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

const mockHandleTerminalEditCommand = vi.fn(() => false);
vi.mock('./features/terminal/terminal-edit-handler', () => ({
  handleTerminalEditCommand: (...args: unknown[]) => mockHandleTerminalEditCommand(...args),
}));

const mockHandleMonacoEditCommand = vi.fn(() => false);
vi.mock('./plugins/builtin/files/MonacoEditor', () => ({
  handleMonacoEditCommand: (...args: unknown[]) => mockHandleMonacoEditCommand(...args),
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

import { initAppEventBridge } from './app-event-bridge';
import { useAgentStore } from './stores/agentStore';
import { useProjectStore } from './stores/projectStore';
import { useUIStore } from './stores/uiStore';

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
    expect(window.clubhouse.window.onNavigateToAgent).toHaveBeenCalled();
  });

  it('should register agent lifecycle listeners', () => {
    expect(window.clubhouse.pty.onExit).toHaveBeenCalled();
    expect(window.clubhouse.agent.onHookEvent).toHaveBeenCalled();
    expect(window.clubhouse.annex.onAgentSpawned).toHaveBeenCalled();
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

  it('should register edit command listener', () => {
    expect(window.clubhouse.app.onEditCommand).toHaveBeenCalled();
  });

  describe('edit command dispatch', () => {
    let editCommandHandler: (command: string) => void;

    beforeEach(() => {
      editCommandHandler = vi.mocked(window.clubhouse.app.onEditCommand).mock.calls[0][0];
      mockHandleTerminalEditCommand.mockReturnValue(false);
      mockHandleMonacoEditCommand.mockReturnValue(false);
    });

    // ─── Terminal routing ──────────────────────────────────────────

    it('routes paste to focused terminal before trying Monaco', () => {
      mockHandleTerminalEditCommand.mockReturnValue(true);
      editCommandHandler('paste');
      expect(mockHandleTerminalEditCommand).toHaveBeenCalledWith('paste');
      expect(mockHandleMonacoEditCommand).not.toHaveBeenCalled();
    });

    it('routes copy to focused terminal before trying Monaco', () => {
      mockHandleTerminalEditCommand.mockReturnValue(true);
      editCommandHandler('copy');
      expect(mockHandleTerminalEditCommand).toHaveBeenCalledWith('copy');
      expect(mockHandleMonacoEditCommand).not.toHaveBeenCalled();
    });

    it('routes selectAll to focused terminal before trying Monaco', () => {
      mockHandleTerminalEditCommand.mockReturnValue(true);
      editCommandHandler('selectAll');
      expect(mockHandleTerminalEditCommand).toHaveBeenCalledWith('selectAll');
      expect(mockHandleMonacoEditCommand).not.toHaveBeenCalled();
    });

    it('falls through to Monaco when terminal does not handle the command', async () => {
      mockHandleTerminalEditCommand.mockReturnValue(false);
      mockHandleMonacoEditCommand.mockReturnValue(true);
      editCommandHandler('selectAll');
      await vi.dynamicImportSettled();
      expect(mockHandleTerminalEditCommand).toHaveBeenCalledWith('selectAll');
      expect(mockHandleMonacoEditCommand).toHaveBeenCalledWith('selectAll');
    });

    // ─── Monaco routing ────────────────────────────────────────────

    it('routes edit commands to Monaco when Monaco has focus', async () => {
      mockHandleMonacoEditCommand.mockReturnValue(true);
      editCommandHandler('selectAll');
      await vi.dynamicImportSettled();
      expect(mockHandleMonacoEditCommand).toHaveBeenCalledWith('selectAll');
    });

    it('routes copy command to Monaco when Monaco has focus', async () => {
      mockHandleMonacoEditCommand.mockReturnValue(true);
      editCommandHandler('copy');
      await vi.dynamicImportSettled();
      expect(mockHandleMonacoEditCommand).toHaveBeenCalledWith('copy');
    });

    // ─── Fallback ──────────────────────────────────────────────────

    it('falls back to document.execCommand when neither terminal nor Monaco handles it', async () => {
      mockHandleTerminalEditCommand.mockReturnValue(false);
      mockHandleMonacoEditCommand.mockReturnValue(false);
      const execCommand = vi.fn(() => true);
      (document as any).execCommand = execCommand;
      editCommandHandler('copy');
      await vi.dynamicImportSettled();
      expect(execCommand).toHaveBeenCalledWith('copy');
      delete (document as any).execCommand;
    });

    it('scopes selectAll to markdown preview container when present', async () => {
      mockHandleMonacoEditCommand.mockReturnValue(false);

      // Create a mock .help-content element in the stub document
      const preview = document.createElement('div');
      preview.className = 'help-content';
      preview.textContent = 'Hello markdown world';
      document.body.appendChild(preview);

      const mockSelection = {
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      (window as any).getSelection = vi.fn(() => mockSelection);

      editCommandHandler('selectAll');
      await vi.dynamicImportSettled();

      expect(mockSelection.removeAllRanges).toHaveBeenCalled();
      expect(mockSelection.addRange).toHaveBeenCalled();

      document.body.removeChild(preview);
      delete (window as any).getSelection;
    });
  });
});
