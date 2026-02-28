import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
};

vi.stubGlobal('window', {
  clubhouse: {
    app: {
      onOpenSettings: vi.fn(() => mockRemovers.onOpenSettings),
      onOpenAbout: vi.fn(() => mockRemovers.onOpenAbout),
      onNotificationClicked: vi.fn(() => mockRemovers.onNotificationClicked),
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

const agentSubscribers: (() => void)[] = [];
const projectSubscribers: (() => void)[] = [];
const uiSubscribers: (() => void)[] = [];

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
      })),
      setState: vi.fn(),
      subscribe: vi.fn((cb: () => void) => {
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
      subscribe: vi.fn((cb: () => void) => {
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
      subscribe: vi.fn((cb: () => void) => {
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

import { initAppEventBridge } from './app-event-bridge';
import { useAgentStore } from './stores/agentStore';
import { useProjectStore } from './stores/projectStore';
import { useUIStore } from './stores/uiStore';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('initAppEventBridge', () => {
  let cleanup: () => void;

  beforeEach(() => {
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
});
