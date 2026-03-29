import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';

// ── Hoisted mocks (accessible in vi.mock factories) ────────────────────────

const {
  mockResolveOrchestrator,
  mockResolveProfileEnv,
  mockBind,
  mockUnbind,
  mockUnbindAgent,
  mockPtySpawn,
  mockHeadlessSpawn,
  mockStartStructured,
  mockSnapshotFile,
  mockRestoreForAgent,
  mockInjectMcp,
  mockBuildMcpDef,
} = vi.hoisted(() => ({
  mockResolveOrchestrator: vi.fn(),
  mockResolveProfileEnv: vi.fn().mockResolvedValue({}),
  mockBind: vi.fn(),
  mockUnbind: vi.fn(),
  mockUnbindAgent: vi.fn(),
  mockPtySpawn: vi.fn().mockResolvedValue(undefined),
  mockHeadlessSpawn: vi.fn().mockResolvedValue(undefined),
  mockStartStructured: vi.fn().mockResolvedValue(undefined),
  mockSnapshotFile: vi.fn(),
  mockRestoreForAgent: vi.fn(),
  mockInjectMcp: vi.fn().mockResolvedValue(undefined),
  mockBuildMcpDef: vi.fn(() => ({ type: 'stdio', command: 'node', args: ['bridge.js'], env: {} })),
}));

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234-5678-abcd-ef0123456789'),
}));

vi.mock('../services/agent-registry', () => ({
  agentRegistry: {
    register: vi.fn(),
    get: vi.fn(() => ({ nonce: 'test-nonce' })),
    setNonce: vi.fn(),
    setRuntime: vi.fn(),
  },
  resolveOrchestrator: mockResolveOrchestrator,
  untrackAgent: vi.fn(),
  getAgentNonce: vi.fn(() => 'test-nonce'),
}));

vi.mock('../services/agent-system', () => ({
  resolveProfileEnv: mockResolveProfileEnv,
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./validation', () => ({
  withValidatedArgs: (_validators: any[], handler: any) => handler,
  stringArg: () => ({}),
  objectArg: () => ({}),
}));

vi.mock('../services/clubhouse-mcp', () => ({
  bindingManager: {
    bind: mockBind,
    unbind: mockUnbind,
    unbindAgent: mockUnbindAgent,
  },
}));

vi.mock('../services/pty-manager', () => ({
  spawn: mockPtySpawn,
}));

vi.mock('../services/headless-manager', () => ({
  spawnHeadless: mockHeadlessSpawn,
}));

vi.mock('../services/structured-manager', () => ({
  startStructuredSession: mockStartStructured,
}));

vi.mock('../services/config-pipeline', () => ({
  snapshotFile: mockSnapshotFile,
  restoreForAgent: mockRestoreForAgent,
}));

vi.mock('../services/free-agent-settings', () => ({
  getPermissionMode: vi.fn(() => 'auto'),
}));

const { mockWaitHookReady, mockWaitMcpBridgeReady } = vi.hoisted(() => ({
  mockWaitHookReady: vi.fn().mockResolvedValue(9999),
  mockWaitMcpBridgeReady: vi.fn().mockResolvedValue(8888),
}));

vi.mock('../services/hook-server', () => ({
  waitReady: mockWaitHookReady,
}));

vi.mock('../services/clubhouse-mcp/bridge-server', () => ({
  waitReady: mockWaitMcpBridgeReady,
}));

vi.mock('../services/clubhouse-mcp/injection', () => ({
  injectClubhouseMcp: mockInjectMcp,
  buildClubhouseMcpDef: mockBuildMcpDef,
}));

vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}));

vi.mock('../orchestrators', () => ({
  isHookCapable: vi.fn(() => false),
  isHeadlessCapable: vi.fn(() => true),
  isStructuredCapable: vi.fn(() => true),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    promises: {
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('[]'),
    },
  };
});

import { registerAssistantHandlers } from './assistant-handlers';
import { agentRegistry, untrackAgent } from '../services/agent-registry';

// ── Test Setup ─────────────────────────────────────────────────────────────

let handlers: Map<string, (...args: any[]) => any>;

function createMockProvider(overrides: Record<string, any> = {}) {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    checkAvailability: vi.fn().mockResolvedValue({ available: true }),
    buildSpawnCommand: vi.fn().mockResolvedValue({
      binary: 'claude', args: ['-p', 'test'], env: {},
    }),
    buildHeadlessCommand: vi.fn().mockResolvedValue({
      binary: 'claude', args: ['-p', 'test'], env: {}, outputKind: 'stream-json',
    }),
    createStructuredAdapter: vi.fn(() => ({
      start: vi.fn(),
      sendMessage: vi.fn(),
      respondToPermission: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    })),
    buildMcpArgs: vi.fn(() => ['--mcp-config', '/tmp/mcp.json']),
    conventions: { mcpConfigFile: '.mcp.json' },
    writeHooksConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('assistant-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    // Restore mock implementations cleared by clearAllMocks
    mockResolveOrchestrator.mockResolvedValue(createMockProvider());
    mockResolveProfileEnv.mockResolvedValue({});
    mockHeadlessSpawn.mockResolvedValue(undefined);
    mockPtySpawn.mockResolvedValue(undefined);
    mockStartStructured.mockResolvedValue(undefined);
    mockInjectMcp.mockResolvedValue(undefined);
    mockBuildMcpDef.mockReturnValue({ type: 'stdio', command: 'node', args: ['bridge.js'], env: {} });
    mockWaitHookReady.mockResolvedValue(9999);
    mockWaitMcpBridgeReady.mockResolvedValue(8888);
    registerAssistantHandlers();
  });

  // ── Registration ─────────────────────────────────────────────────────────

  it('registers all expected IPC channels', () => {
    expect(handlers.has(IPC.ASSISTANT.SPAWN)).toBe(true);
    expect(handlers.has(IPC.ASSISTANT.SEND_FOLLOWUP)).toBe(true);
    expect(handlers.has(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP)).toBe(true);
    expect(handlers.has(IPC.ASSISTANT.BIND)).toBe(true);
    expect(handlers.has(IPC.ASSISTANT.UNBIND)).toBe(true);
    expect(handlers.has(IPC.ASSISTANT.RESET)).toBe(true);
    expect(handlers.has(IPC.ASSISTANT.SAVE_HISTORY)).toBe(true);
    expect(handlers.has(IPC.ASSISTANT.LOAD_HISTORY)).toBe(true);
  });

  // ── SPAWN ────────────────────────────────────────────────────────────────

  describe('SPAWN handler', () => {
    const baseParams = {
      agentId: 'assistant_test_1',
      mission: 'Hello',
      systemPrompt: 'You are an assistant',
      executionMode: 'headless' as const,
    };

    it('registers agent and creates MCP binding', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await handler({}, baseParams);

      expect(agentRegistry.register).toHaveBeenCalledWith('assistant_test_1', expect.objectContaining({
        orchestrator: 'claude-code',
        runtime: 'headless',
      }));
      expect(mockBind).toHaveBeenCalledWith('assistant_test_1', expect.objectContaining({
        targetId: 'clubhouse_assistant',
        targetKind: 'assistant',
      }));
    });

    it('returns success on successful spawn', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      const result = await handler({}, baseParams);
      expect(result).toEqual({ success: true });
    });

    it('spawns headless for headless execution mode', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await handler({}, { ...baseParams, executionMode: 'headless' });
      expect(mockHeadlessSpawn).toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
      expect(mockStartStructured).not.toHaveBeenCalled();
    });

    it('spawns interactive (PTY) for interactive execution mode', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await handler({}, { ...baseParams, executionMode: 'interactive' });
      expect(mockPtySpawn).toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
      expect(mockStartStructured).not.toHaveBeenCalled();
    });

    it('spawns structured for structured execution mode', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await handler({}, { ...baseParams, executionMode: 'structured' });
      expect(mockStartStructured).toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
      expect(mockPtySpawn).not.toHaveBeenCalled();
    });

    it('maps execution mode to correct runtime', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;

      await handler({}, { ...baseParams, executionMode: 'structured' });
      expect(agentRegistry.register).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ runtime: 'structured' }));

      vi.clearAllMocks();
      await handler({}, { ...baseParams, executionMode: 'headless' });
      expect(agentRegistry.register).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ runtime: 'headless' }));

      vi.clearAllMocks();
      await handler({}, { ...baseParams, executionMode: 'interactive' });
      expect(agentRegistry.register).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ runtime: 'pty' }));
    });

    it('throws and cleans up on orchestrator unavailable', async () => {
      mockResolveOrchestrator.mockResolvedValue(createMockProvider({
        checkAvailability: vi.fn().mockResolvedValue({ available: false, error: 'Not installed' }),
      }));

      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await expect(handler({}, baseParams)).rejects.toThrow('Not installed');
    });

    it('cleans up MCP binding and agent on spawn failure', async () => {
      mockHeadlessSpawn.mockRejectedValueOnce(new Error('spawn failed'));

      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await expect(handler({}, baseParams)).rejects.toThrow('spawn failed');

      expect(mockUnbind).toHaveBeenCalledWith('assistant_test_1', 'clubhouse_assistant');
      expect(untrackAgent).toHaveBeenCalledWith('assistant_test_1');
    });

    it('passes orchestrator from params', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await handler({}, { ...baseParams, orchestrator: 'copilot-cli' });
      expect(mockResolveOrchestrator).toHaveBeenCalledWith(expect.any(String), 'copilot-cli');
    });

    it('structured mode passes extraArgs with MCP config', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SPAWN)!;
      await handler({}, { ...baseParams, executionMode: 'structured' });

      expect(mockStartStructured).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          extraArgs: ['--mcp-config', '/tmp/mcp.json'],
        }),
        expect.any(Function),
      );
    });
  });

  // ── SEND_FOLLOWUP ────────────────────────────────────────────────────────

  describe('SEND_FOLLOWUP handler', () => {
    it('creates a new follow-up agent and spawns headless', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_FOLLOWUP)!;
      const result = await handler({}, { message: 'follow up question' });

      expect(result).toHaveProperty('agentId');
      expect(result.agentId).toContain('assistant_followup_');
      expect(mockHeadlessSpawn).toHaveBeenCalled();
    });

    it('registers follow-up agent with headless runtime', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      expect(agentRegistry.register).toHaveBeenCalledWith(
        expect.stringContaining('assistant_followup_'),
        expect.objectContaining({ runtime: 'headless' }),
      );
    });

    it('creates MCP binding for follow-up agent', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      expect(mockBind).toHaveBeenCalledWith(
        expect.stringContaining('assistant_followup_'),
        expect.objectContaining({ targetId: 'clubhouse_assistant' }),
      );
    });

    it('adds --continue flag for session resumption', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      const spawnCall = mockHeadlessSpawn.mock.calls[0];
      const args = spawnCall[3]; // 4th arg is the args array
      expect(args).toContain('--continue');
    });

    it('sets resume: true in buildHeadlessCommand', async () => {
      const provider = createMockProvider();
      mockResolveOrchestrator.mockResolvedValue(provider);

      const handler = handlers.get(IPC.ASSISTANT.SEND_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      expect(provider.buildHeadlessCommand).toHaveBeenCalledWith(
        expect.objectContaining({ resume: true }),
      );
    });

    it('throws if provider does not support headless', async () => {
      const { isHeadlessCapable } = await import('../orchestrators');
      vi.mocked(isHeadlessCapable).mockReturnValueOnce(false);

      const handler = handlers.get(IPC.ASSISTANT.SEND_FOLLOWUP)!;
      await expect(handler({}, { message: 'test' })).rejects.toThrow('does not support headless');
    });
  });

  // ── SEND_STRUCTURED_FOLLOWUP ──────────────────────────────────────────────

  describe('SEND_STRUCTURED_FOLLOWUP handler', () => {
    it('creates a new follow-up agent and starts structured session', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP)!;
      const result = await handler({}, { message: 'follow up question' });

      expect(result).toHaveProperty('agentId');
      expect(result.agentId).toContain('assistant_followup_');
      expect(mockStartStructured).toHaveBeenCalled();
      expect(mockHeadlessSpawn).not.toHaveBeenCalled();
    });

    it('registers follow-up agent with structured runtime', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      expect(agentRegistry.register).toHaveBeenCalledWith(
        expect.stringContaining('assistant_followup_'),
        expect.objectContaining({ runtime: 'structured' }),
      );
    });

    it('creates MCP binding for structured follow-up', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      expect(mockBind).toHaveBeenCalledWith(
        expect.stringContaining('assistant_followup_'),
        expect.objectContaining({ targetId: 'clubhouse_assistant' }),
      );
    });

    it('creates adapter with resume: true for --continue flag', async () => {
      const provider = createMockProvider();
      mockResolveOrchestrator.mockResolvedValue(provider);

      const handler = handlers.get(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      expect(provider.createStructuredAdapter).toHaveBeenCalledWith({ resume: true });
    });

    it('throws if provider does not support structured mode', async () => {
      const { isStructuredCapable } = await import('../orchestrators');
      vi.mocked(isStructuredCapable).mockReturnValueOnce(false);

      const handler = handlers.get(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP)!;
      await expect(handler({}, { message: 'test' })).rejects.toThrow('does not support structured');
    });

    it('injects MCP config for structured follow-up', async () => {
      const handler = handlers.get(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP)!;
      await handler({}, { message: 'test' });

      expect(mockInjectMcp).toHaveBeenCalled();
      expect(mockSnapshotFile).toHaveBeenCalled();
    });
  });

  // ── BIND ─────────────────────────────────────────────────────────────────

  describe('BIND handler', () => {
    it('creates MCP binding for registered agent', async () => {
      const handler = handlers.get(IPC.ASSISTANT.BIND)!;
      await handler({}, 'agent-123');

      expect(mockBind).toHaveBeenCalledWith('agent-123', expect.objectContaining({
        targetId: 'clubhouse_assistant',
      }));
    });

    it('throws if agent is not registered', async () => {
      vi.mocked(agentRegistry.get).mockReturnValueOnce(undefined);

      const handler = handlers.get(IPC.ASSISTANT.BIND)!;
      expect(() => handler({}, 'unknown-agent')).toThrow('Agent not registered');
    });
  });

  // ── UNBIND ───────────────────────────────────────────────────────────────

  describe('UNBIND handler', () => {
    it('removes MCP binding', async () => {
      const handler = handlers.get(IPC.ASSISTANT.UNBIND)!;
      await handler({}, 'agent-123');

      expect(mockUnbind).toHaveBeenCalledWith('agent-123', 'clubhouse_assistant');
    });
  });

  // ── RESET ────────────────────────────────────────────────────────────────

  describe('RESET handler', () => {
    it('restores config, unbinds, and untracks agent', async () => {
      const handler = handlers.get(IPC.ASSISTANT.RESET)!;
      await handler({}, 'agent-123');

      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-123');
      expect(mockUnbindAgent).toHaveBeenCalledWith('agent-123');
      expect(untrackAgent).toHaveBeenCalledWith('agent-123');
    });
  });

  // ── SAVE_HISTORY ─────────────────────────────────────────────────────────

  describe('SAVE_HISTORY handler', () => {
    it('writes items to chat-history.json', async () => {
      const fs = await import('fs');
      const handler = handlers.get(IPC.ASSISTANT.SAVE_HISTORY)!;
      const items = [{ type: 'message', message: { role: 'user', content: 'Hi' } }];
      await handler({}, { items });

      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('chat-history.json'),
        JSON.stringify(items),
        'utf-8',
      );
    });
  });

  // ── LOAD_HISTORY ─────────────────────────────────────────────────────────

  describe('LOAD_HISTORY handler', () => {
    it('reads and parses chat-history.json', async () => {
      const fs = await import('fs');
      const savedItems = [{ type: 'message' }];
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(JSON.stringify(savedItems));

      const handler = handlers.get(IPC.ASSISTANT.LOAD_HISTORY)!;
      const result = await handler({});

      expect(result).toEqual(savedItems);
    });

    it('returns null if file does not exist', async () => {
      const fs = await import('fs');
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(new Error('ENOENT'));

      const handler = handlers.get(IPC.ASSISTANT.LOAD_HISTORY)!;
      const result = await handler({});

      expect(result).toBeNull();
    });
  });
});
