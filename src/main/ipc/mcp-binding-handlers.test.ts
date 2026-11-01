import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: vi.fn(),
  },
}));

vi.mock('../services/mcp-settings', () => ({
  isMcpEnabledForAny: vi.fn(() => true),
  notifyMcpEnablementChanged: vi.fn(),
  mcpSettingsStore: { get: vi.fn(() => ({})), save: vi.fn() },
}));

vi.mock('../services/orchestration-policy', () => ({
  watchMcpForOrchestration: vi.fn(() => () => undefined),
}));

vi.mock('../services/clubhouse-mcp', () => ({
  bindingManager: {
    bind: vi.fn(),
    unbind: vi.fn(),
    setInstructions: vi.fn(),
    setDisabledTools: vi.fn(),
    getAllBindings: vi.fn(() => []),
    getBindingsForAgent: vi.fn(() => []),
    onChange: vi.fn(),
  },
  bridgeServer: { start: vi.fn(async () => 0), getAgentConnection: vi.fn(() => null) },
}));

vi.mock('../services/clubhouse-mcp/tools/agent-tools', () => ({
  registerAgentTools: vi.fn(),
}));

vi.mock('../services/clubhouse-mcp/tools/browser-tools', () => ({
  registerBrowserTools: vi.fn(),
  registerWebview: vi.fn(),
  unregisterWebview: vi.fn(),
}));

vi.mock('../services/clubhouse-mcp/tools/group-project-tools', () => ({
  registerGroupProjectTools: vi.fn(),
}));

vi.mock('../services/clubhouse-mcp/tools/connection-tools', () => ({
  registerConnectionTools: vi.fn(),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock('../services/agent-registry', () => ({
  agentRegistry: { get: vi.fn() },
}));

vi.mock('../services/persisted-bindings', () => ({
  registerPersistedBindingSource: vi.fn(),
  rebuildPersistedBindings: vi.fn(async () => ({ sources: [] })),
  markBindingRemovedByUser: vi.fn(),
  clearBindingRemovedByUser: vi.fn(),
  keepHeldBinding: vi.fn(() => false),
  listSoleOwnedPairs: vi.fn(() => [{ agentId: 'h1', targetId: 'h2' }]),
}));

vi.mock('../services/canvas-wire-source', () => ({
  canvasWireBindingSource: { id: 'canvas-wires', collect: vi.fn(async () => []) },
}));

vi.mock('../services/helper-wire-source', () => ({
  helperWireBindingSource: { id: 'helper-wires', prune: true, collect: vi.fn(async () => []) },
  watchHelperWires: vi.fn(() => () => undefined),
}));

vi.mock('../services/orchestrator-connections', () => ({
  ORCHESTRATOR_CONNECTION_SOURCE_ID: 'orchestrator-connections',
  orchestratorConnectionSource: { id: 'orchestrator-connections', prune: true, collect: vi.fn(async () => []) },
  watchOrchestratorConnections: vi.fn(() => () => undefined),
}));

vi.mock('../services/dispatcher-wire-source', () => ({
  dispatcherWireBindingSource: { id: 'dispatcher-wires', prune: true, collect: vi.fn(async () => []) },
  watchDispatcherWires: vi.fn(() => () => undefined),
}));

import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { MCP_UNBIND_CANVAS_CLEANUP } from '../../shared/mcp-unbind';
import { bindingManager, bridgeServer } from '../services/clubhouse-mcp';
import { agentRegistry } from '../services/agent-registry';
import { registerWebview, unregisterWebview } from '../services/clubhouse-mcp/tools/browser-tools';
import { isMcpEnabledForAny, notifyMcpEnablementChanged } from '../services/mcp-settings';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import {
  registerPersistedBindingSource,
  rebuildPersistedBindings,
  markBindingRemovedByUser,
  clearBindingRemovedByUser,
  keepHeldBinding,
  listSoleOwnedPairs,
} from '../services/persisted-bindings';
import { canvasWireBindingSource } from '../services/canvas-wire-source';
import { helperWireBindingSource, watchHelperWires } from '../services/helper-wire-source';
import { orchestratorConnectionSource, watchOrchestratorConnections } from '../services/orchestrator-connections';
import { dispatcherWireBindingSource, watchDispatcherWires } from '../services/dispatcher-wire-source';
import { registerConnectionTools } from '../services/clubhouse-mcp/tools/connection-tools';
import {
  registerMcpBindingHandlers,
  maybeStartMcpBridge,
  onMcpSettingsChanged,
  restorePersistedBindings,
  _resetHandlersForTesting,
} from './mcp-binding-handlers';

type HandlerFn = (...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();

const mockGet = vi.mocked(agentRegistry.get);
const mockFromWebContents = vi.mocked(BrowserWindow.fromWebContents);

const fakeEvent = { sender: { id: 1 } } as any;

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: HandlerFn) => {
    handlers.set(channel, handler);
    return undefined as any;
  });
  _resetHandlersForTesting();
  registerMcpBindingHandlers();
  mockGet.mockReset();
  mockFromWebContents.mockReset();
  // Default: sender is a valid app window
  mockFromWebContents.mockReturnValue({} as any);
  vi.mocked(bindingManager.bind).mockClear();
  vi.mocked(bindingManager.unbind).mockClear();
  vi.mocked(bindingManager.setInstructions).mockClear();
  vi.mocked(bindingManager.setDisabledTools).mockClear();
  vi.mocked(bindingManager.getBindingsForAgent).mockReturnValue([]);
});

function getHandler(channel: string): HandlerFn {
  const h = handlers.get(channel);
  if (!h) throw new Error(`No handler for ${channel}. Registered: ${Array.from(handlers.keys()).join(', ')}`);
  return h;
}

// ── Registration ──────────────────────────────────────────────────────

describe('mcp-binding-handlers registration', () => {
  it('registers all expected IPC handlers', () => {
    const expectedChannels = [
      IPC.MCP_BINDING.GET_BINDINGS,
      IPC.MCP_BINDING.BIND,
      IPC.MCP_BINDING.UNBIND,
      IPC.MCP_BINDING.SET_INSTRUCTIONS,
      IPC.MCP_BINDING.SET_DISABLED_TOOLS,
      IPC.MCP_BINDING.GET_AGENT_CONNECTION,
      IPC.MCP_BINDING.GET_TOOL_CONNECTIONS,
      IPC.MCP_BINDING.REGISTER_WEBVIEW,
      IPC.MCP_BINDING.UNREGISTER_WEBVIEW,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel), `Missing handler for ${channel}`).toBe(true);
    }
  });

  it('is idempotent — second call does not re-register', () => {
    const callCount = vi.mocked(ipcMain.handle).mock.calls.length;
    registerMcpBindingHandlers();
    expect(vi.mocked(ipcMain.handle).mock.calls.length).toBe(callCount);
  });

  it('does not register when MCP is disabled', () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(false);
    handlers.clear();
    vi.mocked(ipcMain.handle).mockClear();
    _resetHandlersForTesting();
    registerMcpBindingHandlers();
    expect(ipcMain.handle).not.toHaveBeenCalled();
  });

  it('subscribes to binding onChange for broadcast', () => {
    expect(bindingManager.onChange).toHaveBeenCalled();
  });

  it('broadcasts bindings when onChange fires', () => {
    const bindings = [{ agentId: 'a1', targets: [] }];
    vi.mocked(bindingManager.getAllBindings).mockReturnValue(bindings as any);
    const onChangeCallback = vi.mocked(bindingManager.onChange).mock.calls[0][0] as () => void;
    onChangeCallback();
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.MCP_BINDING.BINDINGS_CHANGED, bindings);
  });
});

// ── GET_BINDINGS ────────────────────────────────────────────────────────

describe('GET_BINDINGS', () => {
  it('returns all bindings', () => {
    const bindings = [{ agentId: 'a1', targets: [{ targetId: 't1' }] }];
    vi.mocked(bindingManager.getAllBindings).mockReturnValue(bindings as any);
    const handler = getHandler(IPC.MCP_BINDING.GET_BINDINGS);
    expect(handler(fakeEvent)).toEqual(bindings);
  });
});

// ── SEC-05: Authorization ───────────────────────────────────────────────

describe('SEC-06: MCP binding IPC authorization', () => {
  describe('BIND', () => {
    it('allows bind for sleeping (unregistered) agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'sleeping-agent', target)).not.toThrow();
      expect(bindingManager.bind).toHaveBeenCalledWith('sleeping-agent', target);
    });

    it('allows bind for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'agent-1', target)).not.toThrow();
      expect(bindingManager.bind).toHaveBeenCalledWith('agent-1', target);
    });

    it('rejects missing agentId', () => {
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      expect(() => handler(fakeEvent)).toThrow();
    });

    it('rejects missing target object', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp' } as any);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      expect(() => handler(fakeEvent, 'agent-1')).toThrow();
    });

    it('rejects the removed agent-queue and assistant targetKinds', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      for (const targetKind of ['agent-queue', 'assistant']) {
        const target = { targetId: 'x_123', targetKind, label: 'Removed' };
        expect(() => handler(fakeEvent, 'agent-1', target)).toThrow(/Invalid targetKind/);
      }
      expect(bindingManager.bind).not.toHaveBeenCalled();
    });

    it('allows bind with group-project targetKind', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'gp_456', targetKind: 'group-project', label: 'My GP' };
      expect(() => handler(fakeEvent, 'agent-1', target)).not.toThrow();
      expect(bindingManager.bind).toHaveBeenCalledWith('agent-1', target);
    });

    it('rejects bind with invalid targetKind', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'w1', targetKind: 'malicious-kind', label: 'Widget' };
      expect(() => handler(fakeEvent, 'agent-1', target)).toThrow(/Invalid targetKind/);
      expect(bindingManager.bind).not.toHaveBeenCalled();
    });

    it('rejects bind with empty targetKind', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'w1', targetKind: '', label: 'Widget' };
      expect(() => handler(fakeEvent, 'agent-1', target)).toThrow(/Invalid targetKind/);
      expect(bindingManager.bind).not.toHaveBeenCalled();
    });

    it('rejects bind from non-app-window sender (webview)', () => {
      mockFromWebContents.mockReturnValue(null);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'agent-1', target)).toThrow('unauthorized caller');
      expect(bindingManager.bind).not.toHaveBeenCalled();
    });
  });

  describe('GET_TOOL_CONNECTIONS (#2232)', () => {
    it('lists the wires the connection tools alone own', () => {
      const handler = getHandler(IPC.MCP_BINDING.GET_TOOL_CONNECTIONS);
      expect(handler(fakeEvent)).toEqual([{ agentId: 'h1', targetId: 'h2' }]);
      expect(listSoleOwnedPairs).toHaveBeenCalledWith('orchestrator-connections');
    });

    it('rejects a sender that isn\'t an app window', () => {
      mockFromWebContents.mockReturnValue(null);
      expect(() => getHandler(IPC.MCP_BINDING.GET_TOOL_CONNECTIONS)(fakeEvent)).toThrow();
    });
  });

  describe('UNBIND', () => {
    it('allows unbind for sleeping (unregistered) agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.UNBIND);
      expect(() => handler(fakeEvent, 'sleeping-agent', 'target-1')).not.toThrow();
      expect(bindingManager.unbind).toHaveBeenCalledWith('sleeping-agent', 'target-1');
    });

    it('allows unbind for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.UNBIND);
      expect(() => handler(fakeEvent, 'agent-2', 'target-1')).not.toThrow();
      expect(bindingManager.unbind).toHaveBeenCalledWith('agent-2', 'target-1');
    });

    it('rejects missing targetId', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp' } as any);
      const handler = getHandler(IPC.MCP_BINDING.UNBIND);
      expect(() => handler(fakeEvent, 'agent-1')).toThrow();
    });

    it('rejects unbind from non-app-window sender', () => {
      mockFromWebContents.mockReturnValue(null);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.UNBIND);
      expect(() => handler(fakeEvent, 'agent-2', 'target-1')).toThrow('unauthorized caller');
      expect(bindingManager.unbind).not.toHaveBeenCalled();
    });
  });

  describe('SET_INSTRUCTIONS', () => {
    it('allows setInstructions for sleeping (unregistered) agent — recovery safety', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.SET_INSTRUCTIONS);
      expect(() => handler(fakeEvent, 'sleeping-agent', 'target-1', { key: 'val' })).not.toThrow();
      expect(bindingManager.setInstructions).toHaveBeenCalledWith('sleeping-agent', 'target-1', { key: 'val' });
    });

    it('allows setInstructions for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.SET_INSTRUCTIONS);
      expect(() => handler(fakeEvent, 'agent-3', 'target-1', { key: 'val' })).not.toThrow();
      expect(bindingManager.setInstructions).toHaveBeenCalledWith('agent-3', 'target-1', { key: 'val' });
    });

    it('rejects setInstructions from non-app-window sender', () => {
      mockFromWebContents.mockReturnValue(null);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:set-instructions');
      expect(() => handler(fakeEvent, 'agent-3', 'target-1', { key: 'val' })).toThrow('unauthorized caller');
      expect(bindingManager.setInstructions).not.toHaveBeenCalled();
    });
  });

  describe('SET_DISABLED_TOOLS', () => {
    it('allows setDisabledTools for sleeping (unregistered) agent — recovery safety', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler('mcp-binding:set-disabled-tools');
      expect(() => handler(fakeEvent, 'sleeping-agent', 'target-1', ['tool-a'])).not.toThrow();
      expect(bindingManager.setDisabledTools).toHaveBeenCalledWith('sleeping-agent', 'target-1', ['tool-a']);
    });

    it('allows setDisabledTools for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:set-disabled-tools');
      expect(() => handler(fakeEvent, 'agent-4', 'target-1', ['tool-a'])).not.toThrow();
      expect(bindingManager.setDisabledTools).toHaveBeenCalledWith('agent-4', 'target-1', ['tool-a']);
    });

    it('rejects setDisabledTools from non-app-window sender', () => {
      mockFromWebContents.mockReturnValue(null);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:set-disabled-tools');
      expect(() => handler(fakeEvent, 'agent-4', 'target-1', ['tool-a'])).toThrow('unauthorized caller');
      expect(bindingManager.setDisabledTools).not.toHaveBeenCalled();
    });
  });
});

// ── #2082: plugin bindings ──────────────────────────────────────────────

describe('plugin bindings are not renderer-controlled (#2082)', () => {
  const pluginBinding = { agentId: 'agent-1', targetId: 'some-plugin', targetKind: 'plugin', label: 'Plugin' };

  it('rejects bind with the plugin targetKind', () => {
    mockGet.mockReturnValue(undefined);
    const handler = getHandler(IPC.MCP_BINDING.BIND);
    const target = { targetId: 'some-plugin', targetKind: 'plugin', label: 'Plugin' };
    expect(() => handler(fakeEvent, 'agent-1', target)).toThrow(/Invalid targetKind/);
    expect(bindingManager.bind).not.toHaveBeenCalled();
    expect(clearBindingRemovedByUser).not.toHaveBeenCalled();
  });

  it('still binds every non-plugin targetKind', () => {
    mockGet.mockReturnValue(undefined);
    const handler = getHandler(IPC.MCP_BINDING.BIND);
    for (const targetKind of ['browser', 'agent', 'terminal', 'group-project']) {
      const target = { targetId: `t-${targetKind}`, targetKind, label: targetKind };
      expect(() => handler(fakeEvent, 'agent-1', target)).not.toThrow();
      expect(bindingManager.bind).toHaveBeenCalledWith('agent-1', target);
    }
  });

  it('rejects unbind of an existing plugin binding', () => {
    vi.mocked(bindingManager.getBindingsForAgent).mockReturnValue([pluginBinding] as any);
    const handler = getHandler(IPC.MCP_BINDING.UNBIND);
    expect(() => handler(fakeEvent, 'agent-1', 'some-plugin')).toThrow(/plugin bindings/);
    expect(() => handler(fakeEvent, 'agent-1', 'some-plugin', MCP_UNBIND_CANVAS_CLEANUP)).toThrow(/plugin bindings/);
    expect(bindingManager.unbind).not.toHaveBeenCalled();
    expect(markBindingRemovedByUser).not.toHaveBeenCalled();
  });

  it('rejects setInstructions on an existing plugin binding', () => {
    vi.mocked(bindingManager.getBindingsForAgent).mockReturnValue([pluginBinding] as any);
    const handler = getHandler(IPC.MCP_BINDING.SET_INSTRUCTIONS);
    expect(() => handler(fakeEvent, 'agent-1', 'some-plugin', { '*': 'do this' })).toThrow(/plugin bindings/);
    expect(bindingManager.setInstructions).not.toHaveBeenCalled();
  });

  it('rejects setDisabledTools on an existing plugin binding', () => {
    vi.mocked(bindingManager.getBindingsForAgent).mockReturnValue([pluginBinding] as any);
    const handler = getHandler(IPC.MCP_BINDING.SET_DISABLED_TOOLS);
    expect(() => handler(fakeEvent, 'agent-1', 'some-plugin', ['tool-a'])).toThrow(/plugin bindings/);
    expect(bindingManager.setDisabledTools).not.toHaveBeenCalled();
  });

  it('still changes the agent\'s other bindings', () => {
    const browserBinding = { agentId: 'agent-1', targetId: 'w1', targetKind: 'browser', label: 'Widget' };
    vi.mocked(bindingManager.getBindingsForAgent).mockReturnValue([pluginBinding, browserBinding] as any);
    getHandler(IPC.MCP_BINDING.SET_INSTRUCTIONS)(fakeEvent, 'agent-1', 'w1', { '*': 'x' });
    getHandler(IPC.MCP_BINDING.SET_DISABLED_TOOLS)(fakeEvent, 'agent-1', 'w1', ['tool-a']);
    getHandler(IPC.MCP_BINDING.UNBIND)(fakeEvent, 'agent-1', 'w1');
    expect(bindingManager.setInstructions).toHaveBeenCalledWith('agent-1', 'w1', { '*': 'x' });
    expect(bindingManager.setDisabledTools).toHaveBeenCalledWith('agent-1', 'w1', ['tool-a']);
    expect(bindingManager.unbind).toHaveBeenCalledWith('agent-1', 'w1');
  });
});

// ── SET_DISABLED_TOOLS ──────────────────────────────────────────────────

describe('SET_DISABLED_TOOLS', () => {
  it('sets disabled tools on binding', () => {
    mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
    const handler = getHandler(IPC.MCP_BINDING.SET_DISABLED_TOOLS);
    handler(fakeEvent, 'agent-1', 'target-1', ['tool-a', 'tool-b']);
    expect(bindingManager.setDisabledTools).toHaveBeenCalledWith('agent-1', 'target-1', ['tool-a', 'tool-b']);
  });

  it('rejects non-array disabledTools', () => {
    mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
    const handler = getHandler(IPC.MCP_BINDING.SET_DISABLED_TOOLS);
    expect(() => handler(fakeEvent, 'agent-1', 'target-1', 'not-an-array')).toThrow();
  });

  it('rejects non-string items in array', () => {
    mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
    const handler = getHandler(IPC.MCP_BINDING.SET_DISABLED_TOOLS);
    expect(() => handler(fakeEvent, 'agent-1', 'target-1', [123])).toThrow();
  });
});

// ── GET_AGENT_CONNECTION ───────────────────────────────────────────────

describe('GET_AGENT_CONNECTION', () => {
  it('returns the bridge server\'s record for the agent', () => {
    vi.mocked(bridgeServer.getAgentConnection).mockReturnValue({ connectedAt: 5, toolCount: 9 });
    const handler = getHandler(IPC.MCP_BINDING.GET_AGENT_CONNECTION);
    expect(handler(fakeEvent, 'agent-1')).toEqual({ connectedAt: 5, toolCount: 9 });
    expect(bridgeServer.getAgentConnection).toHaveBeenCalledWith('agent-1');
  });

  it('rejects callers that are not app windows', () => {
    mockFromWebContents.mockReturnValue(null);
    const handler = getHandler(IPC.MCP_BINDING.GET_AGENT_CONNECTION);
    expect(() => handler(fakeEvent, 'agent-1')).toThrow();
  });
});

// ── Webview Registration ────────────────────────────────────────────────

describe('REGISTER_WEBVIEW', () => {
  it('registers webview with parsed webContentsId', () => {
    const handler = getHandler(IPC.MCP_BINDING.REGISTER_WEBVIEW);
    handler(fakeEvent, 'widget-1', '42');
    expect(registerWebview).toHaveBeenCalledWith('widget-1', 42);
  });

  it('rejects missing webContentsId', () => {
    const handler = getHandler(IPC.MCP_BINDING.REGISTER_WEBVIEW);
    expect(() => handler(fakeEvent, 'widget-1')).toThrow();
  });
});

describe('UNREGISTER_WEBVIEW', () => {
  it('unregisters webview', () => {
    const handler = getHandler(IPC.MCP_BINDING.UNREGISTER_WEBVIEW);
    handler(fakeEvent, 'widget-1');
    expect(unregisterWebview).toHaveBeenCalledWith('widget-1');
  });

  it('rejects missing widgetId', () => {
    const handler = getHandler(IPC.MCP_BINDING.UNREGISTER_WEBVIEW);
    expect(() => handler(fakeEvent)).toThrow();
  });
});

// ── Bridge Startup ──────────────────────────────────────────────────────

describe('maybeStartMcpBridge', () => {
  it('starts the bridge server when MCP is enabled', () => {
    maybeStartMcpBridge();
    expect(bridgeServer.start).toHaveBeenCalled();
  });

  it('is idempotent — second call does not restart', () => {
    maybeStartMcpBridge();
    maybeStartMcpBridge();
    expect(bridgeServer.start).toHaveBeenCalledTimes(1);
  });

  it('does not start when MCP is disabled', () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(false);
    maybeStartMcpBridge();
    expect(bridgeServer.start).not.toHaveBeenCalled();
  });

  it('resets bridgeStarted on failure to allow retry', async () => {
    const error = new Error('port in use');
    vi.mocked(bridgeServer.start).mockRejectedValueOnce(error);

    maybeStartMcpBridge();
    // Wait for the async catch to fire
    await vi.waitFor(() => {
      expect(bridgeServer.start).toHaveBeenCalledTimes(1);
    });
    // Allow the promise rejection to settle
    await new Promise((r) => setTimeout(r, 0));

    // Now a retry should work because bridgeStarted was reset
    vi.mocked(bridgeServer.start).mockResolvedValueOnce(0 as any);
    maybeStartMcpBridge();
    expect(bridgeServer.start).toHaveBeenCalledTimes(2);
  });
});

// ── Settings Change ─────────────────────────────────────────────────────

describe('onMcpSettingsChanged', () => {
  it('does nothing when MCP is disabled', () => {
    vi.mocked(isMcpEnabledForAny).mockReturnValue(false);
    vi.mocked(ipcMain.handle).mockClear();
    onMcpSettingsChanged();
    // No new handler registrations since MCP is disabled
    expect(bridgeServer.start).not.toHaveBeenCalled();
  });

  it('tells whatever follows MCP even when MCP just went off everywhere (#2589)', () => {
    vi.mocked(notifyMcpEnablementChanged).mockClear();
    vi.mocked(isMcpEnabledForAny).mockReturnValue(false);
    onMcpSettingsChanged();
    expect(notifyMcpEnablementChanged).toHaveBeenCalledTimes(1);
  });

  it('registers handlers and starts bridge when MCP becomes enabled', () => {
    // Handlers already registered from beforeEach, so this primarily tests bridge start
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    onMcpSettingsChanged();
    expect(bridgeServer.start).toHaveBeenCalled();
  });
});

describe('restorePersistedBindings (#1544)', () => {
  it('does nothing until MCP handlers are registered', () => {
    _resetHandlersForTesting();
    restorePersistedBindings();
    expect(rebuildPersistedBindings).not.toHaveBeenCalled();
  });

  it('registers the canvas, helper wire, orchestrator connection and Dispatcher wire sources once and rebuilds on every call', () => {
    restorePersistedBindings();
    restorePersistedBindings();
    expect(vi.mocked(registerPersistedBindingSource).mock.calls.map(([source]) => source)).toEqual([
      canvasWireBindingSource,
      helperWireBindingSource,
      orchestratorConnectionSource,
      dispatcherWireBindingSource,
    ]);
    expect(rebuildPersistedBindings).toHaveBeenCalledTimes(2);
  });

  it('registers the connection tools with the other tool templates (#2230)', () => {
    expect(registerConnectionTools).toHaveBeenCalled();
  });

  it('rebuilds again when orchestrator connections drop a disposed helper (#2230)', () => {
    restorePersistedBindings();
    expect(watchOrchestratorConnections).toHaveBeenCalledTimes(1);
    const onChanged = vi.mocked(watchOrchestratorConnections).mock.calls.at(-1)![0];
    onChanged();
    expect(rebuildPersistedBindings).toHaveBeenCalledTimes(2);
  });

  it('rebuilds again when a project\'s helper wires change (#2225)', () => {
    restorePersistedBindings();
    expect(watchHelperWires).toHaveBeenCalledTimes(1);
    const onWiresChanged = vi.mocked(watchHelperWires).mock.calls.at(-1)![0];
    onWiresChanged();
    expect(rebuildPersistedBindings).toHaveBeenCalledTimes(2);
  });

  it('rebuilds again when the Dispatcher wires change (#2537)', () => {
    restorePersistedBindings();
    expect(watchDispatcherWires).toHaveBeenCalledTimes(1);
    const onWiresChanged = vi.mocked(watchDispatcherWires).mock.calls.at(-1)![0];
    onWiresChanged();
    expect(rebuildPersistedBindings).toHaveBeenCalledTimes(2);
  });

  it('stops watching the Dispatcher wires on reset (#2537)', () => {
    const stop = vi.fn();
    vi.mocked(watchDispatcherWires).mockReturnValueOnce(stop);
    restorePersistedBindings();
    _resetHandlersForTesting();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('runs when MCP is turned on later', () => {
    onMcpSettingsChanged();
    expect(rebuildPersistedBindings).toHaveBeenCalledTimes(1);
  });
});

describe('user removals and later restores', () => {
  it('UNBIND marks the pair so a restore re-run skips it; BIND clears the mark', async () => {
    await handlers.get(IPC.MCP_BINDING.UNBIND)!(fakeEvent, 'agent-1', 'agent-2');
    expect(markBindingRemovedByUser).toHaveBeenCalledWith('agent-1', 'agent-2');
    await handlers.get(IPC.MCP_BINDING.BIND)!(fakeEvent, 'agent-1', { targetId: 'agent-2', targetKind: 'agent', label: 'x' });
    expect(clearBindingRemovedByUser).toHaveBeenCalledWith('agent-1', 'agent-2');
  });

  it('UNBIND on canvas cleanup keeps a pair a persisted source holds (#2225)', async () => {
    vi.mocked(keepHeldBinding).mockReturnValueOnce(true);
    const result = await handlers.get(IPC.MCP_BINDING.UNBIND)!(fakeEvent, 'lead', 'helper', 'canvas-cleanup');
    expect(result).toEqual({ kept: true });
    expect(keepHeldBinding).toHaveBeenCalledWith('lead', 'helper');
    expect(bindingManager.unbind).not.toHaveBeenCalled();
    expect(markBindingRemovedByUser).not.toHaveBeenCalled();
  });

  it('UNBIND on canvas cleanup unbinds a pair no source holds', async () => {
    const result = await handlers.get(IPC.MCP_BINDING.UNBIND)!(fakeEvent, 'a', 'b', 'canvas-cleanup');
    expect(result).toEqual({ kept: false });
    expect(bindingManager.unbind).toHaveBeenCalledWith('a', 'b');
  });

  it('UNBIND without a cause (the user deleted the wire) never asks to keep it', async () => {
    await handlers.get(IPC.MCP_BINDING.UNBIND)!(fakeEvent, 'lead', 'helper');
    expect(keepHeldBinding).not.toHaveBeenCalled();
    expect(bindingManager.unbind).toHaveBeenCalledWith('lead', 'helper');
    expect(markBindingRemovedByUser).toHaveBeenCalledWith('lead', 'helper');
  });
});
