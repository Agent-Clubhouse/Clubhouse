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
import { bindingManager } from '../services/clubhouse-mcp';
import { agentRegistry } from '../services/agent-registry';
import { registerMcpBindingHandlers, _resetHandlersForTesting } from './mcp-binding-handlers';

type HandlerFn = (...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();

const mockGet = vi.mocked(agentRegistry.get);
const mockFromWebContents = vi.mocked(BrowserWindow.fromWebContents);

beforeEach(() => {
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
  if (!h) {
    throw new Error(`No handler for ${channel}. Registered: ${Array.from(handlers.keys()).join(', ')}`);
  }
  return h;
}

const fakeEvent = { sender: { id: 1 } } as any;

describe('SEC-06: MCP binding IPC authorization', () => {
  describe('BIND', () => {
    it('rejects bind for unregistered agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler('mcp-binding:bind');
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'unknown-agent', target)).toThrow('Agent not registered');
      expect(bindingManager.bind).not.toHaveBeenCalled();
    });

    it('allows bind for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:bind');
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'agent-1', target)).not.toThrow();
      expect(bindingManager.bind).toHaveBeenCalledWith('agent-1', target);
    });

    it('rejects bind from non-app-window sender (webview)', () => {
      mockFromWebContents.mockReturnValue(null as any);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:bind');
      const target = { targetId: 'w1', targetKind: 'browser', label: 'Widget' };
      expect(() => handler(fakeEvent, 'agent-1', target)).toThrow('unauthorized caller');
      expect(bindingManager.bind).not.toHaveBeenCalled();
    });
  });

  describe('UNBIND', () => {
    it('rejects unbind for unregistered agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler('mcp-binding:unbind');
      expect(() => handler(fakeEvent, 'unknown-agent', 'target-1')).toThrow('Agent not registered');
      expect(bindingManager.unbind).not.toHaveBeenCalled();
    });

    it('allows unbind for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:unbind');
      expect(() => handler(fakeEvent, 'agent-2', 'target-1')).not.toThrow();
      expect(bindingManager.unbind).toHaveBeenCalledWith('agent-2', 'target-1');
    });

    it('rejects unbind from non-app-window sender', () => {
      mockFromWebContents.mockReturnValue(null as any);
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:unbind');
      expect(() => handler(fakeEvent, 'agent-2', 'target-1')).toThrow('unauthorized caller');
      expect(bindingManager.unbind).not.toHaveBeenCalled();
    });
  });

  describe('SET_INSTRUCTIONS', () => {
    it('rejects setInstructions for unregistered agent', () => {
      mockGet.mockReturnValue(undefined);
      const handler = getHandler('mcp-binding:set-instructions');
      expect(() => handler(fakeEvent, 'unknown-agent', 'target-1', { key: 'val' })).toThrow('Agent not registered');
      expect(bindingManager.setInstructions).not.toHaveBeenCalled();
    });

    it('allows setInstructions for registered agent', () => {
      mockGet.mockReturnValue({ projectPath: '/tmp', orchestrator: 'claude-code', runtime: 'pty' } as any);
      const handler = getHandler('mcp-binding:set-instructions');
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
