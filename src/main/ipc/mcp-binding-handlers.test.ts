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
}));

vi.mock('../services/clubhouse-mcp', () => ({
  bindingManager: {
    bind: vi.fn(),
    unbind: vi.fn(),
    setInstructions: vi.fn(),
    setDisabledTools: vi.fn(),
    getAllBindings: vi.fn(() => []),
    onChange: vi.fn(),
  },
  bridgeServer: { start: vi.fn(async () => 0) },
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

vi.mock('../services/clubhouse-mcp/tools/agent-queue-tools', () => ({
  registerAgentQueueTools: vi.fn(),
}));

vi.mock('../services/clubhouse-mcp/tools/assistant-tools', () => ({
  registerAssistantTools: vi.fn(),
}));

vi.mock('../services/clubhouse-mcp/canvas-command', () => ({
  registerCanvasCommandHandler: vi.fn(),
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

import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { bindingManager, bridgeServer } from '../services/clubhouse-mcp';
import { agentRegistry } from '../services/agent-registry';
import { registerWebview, unregisterWebview } from '../services/clubhouse-mcp/tools/browser-tools';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import {
  registerMcpBindingHandlers,
  maybeStartMcpBridge,
  onMcpSettingsChanged,
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
    it('rejects bind for unregistered agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'unknown-agent', target)).toThrow('Agent not registered');
      expect(bindingManager.bind).not.toHaveBeenCalled();
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

    it('rejects bind from non-app-window sender (webview)', () => {
      mockFromWebContents.mockReturnValue(null as any);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.BIND);
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'agent-1', target)).toThrow('unauthorized caller');
      expect(bindingManager.bind).not.toHaveBeenCalled();
    });
  });

  describe('UNBIND', () => {
    it('rejects unbind for unregistered agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.UNBIND);
      expect(() => handler(fakeEvent, 'unknown-agent', 'target-1')).toThrow('Agent not registered');
      expect(bindingManager.unbind).not.toHaveBeenCalled();
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
      mockFromWebContents.mockReturnValue(null as any);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.UNBIND);
      expect(() => handler(fakeEvent, 'agent-2', 'target-1')).toThrow('unauthorized caller');
      expect(bindingManager.unbind).not.toHaveBeenCalled();
    });
  });

  describe('SET_INSTRUCTIONS', () => {
    it('rejects setInstructions for unregistered agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler(IPC.MCP_BINDING.SET_INSTRUCTIONS);
      expect(() => handler(fakeEvent, 'unknown-agent', 'target-1', { key: 'val' })).toThrow('Agent not registered');
      expect(bindingManager.setInstructions).not.toHaveBeenCalled();
    });

    it('allows setInstructions for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler(IPC.MCP_BINDING.SET_INSTRUCTIONS);
      expect(() => handler(fakeEvent, 'agent-3', 'target-1', { key: 'val' })).not.toThrow();
      expect(bindingManager.setInstructions).toHaveBeenCalledWith('agent-3', 'target-1', { key: 'val' });
    });

    it('rejects setInstructions from non-app-window sender', () => {
      mockFromWebContents.mockReturnValue(null as any);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:set-instructions');
      expect(() => handler(fakeEvent, 'agent-3', 'target-1', { key: 'val' })).toThrow('unauthorized caller');
      expect(bindingManager.setInstructions).not.toHaveBeenCalled();
    });
  });

  describe('SET_DISABLED_TOOLS', () => {
    it('rejects setDisabledTools for unregistered agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler('mcp-binding:set-disabled-tools');
      expect(() => handler(fakeEvent, 'unknown-agent', 'target-1', ['tool-a'])).toThrow('Agent not registered');
      expect(bindingManager.setDisabledTools).not.toHaveBeenCalled();
    });

    it('allows setDisabledTools for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:set-disabled-tools');
      expect(() => handler(fakeEvent, 'agent-4', 'target-1', ['tool-a'])).not.toThrow();
      expect(bindingManager.setDisabledTools).toHaveBeenCalledWith('agent-4', 'target-1', ['tool-a']);
    });

    it('rejects setDisabledTools from non-app-window sender', () => {
      mockFromWebContents.mockReturnValue(null as any);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:set-disabled-tools');
      expect(() => handler(fakeEvent, 'agent-4', 'target-1', ['tool-a'])).toThrow('unauthorized caller');
      expect(bindingManager.setDisabledTools).not.toHaveBeenCalled();
    });
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

  it('registers handlers and starts bridge when MCP becomes enabled', () => {
    // Handlers already registered from beforeEach, so this primarily tests bridge start
    vi.mocked(isMcpEnabledForAny).mockReturnValue(true);
    onMcpSettingsChanged();
    expect(bridgeServer.start).toHaveBeenCalled();
  });
});
