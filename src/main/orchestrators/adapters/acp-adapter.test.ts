import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredEvent } from '../../../shared/structured-events';
import type { StructuredSessionOpts } from '../types';

// Mock AcpClient
vi.mock('./acp-client', () => ({
  AcpClient: vi.fn(),
  RpcError: class RpcError extends Error {
    code: number;
    data?: unknown;
    constructor(code: number, message: string, data?: unknown) {
      super(`RPC error ${code}: ${message}`);
      this.name = 'RpcError';
      this.code = code;
      this.data = data;
    }
  },
}));

// Mock shell environment
vi.mock('../../util/shell', () => ({
  getShellEnvironment: vi.fn().mockReturnValue({ PATH: '/usr/bin', HOME: '/home/test' }),
  cleanSpawnEnv: vi.fn((env: Record<string, string>) => { delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; return env; }),
}));

// Mock log service
vi.mock('../../services/log-service', () => ({
  appLog: vi.fn(),
}));

import { AcpClient } from './acp-client';
import { AcpAdapter } from './acp-adapter';
import { appLog } from '../../services/log-service';

const MockAcpClient = vi.mocked(AcpClient);

interface MockClientInstance {
  start: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  respondWithError: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  getStderr: ReturnType<typeof vi.fn>;
  alive: boolean;
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (id: number | string, method: string, params: unknown) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onLog: (level: string, message: string, meta?: Record<string, unknown>) => void;
}

async function collectEvents(
  iterable: AsyncIterable<StructuredEvent>,
  count: number,
): Promise<StructuredEvent[]> {
  const events: StructuredEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    if (events.length >= count) break;
  }
  return events;
}

async function collectAll(iterable: AsyncIterable<StructuredEvent>): Promise<StructuredEvent[]> {
  const events: StructuredEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** Let the async startup chain (start → session/new → session/prompt) run. */
const settle = () => new Promise(r => setTimeout(r, 10));

// ── Authentic ACP v1 fixtures (schema/v1/schema.json) ─────────────────────

const SESSION_ID = 'test-session-id';

function sessionUpdate(update: Record<string, unknown>) {
  return { sessionId: SESSION_ID, update };
}

const PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

function permissionRequest(options = PERMISSION_OPTIONS) {
  return {
    sessionId: SESSION_ID,
    toolCall: {
      toolCallId: 'call_001',
      title: 'Edit src/index.ts',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: 'src/index.ts' },
    },
    options,
  };
}

describe('AcpAdapter', () => {
  let mockClient: MockClientInstance;
  /** Settle the in-flight session/prompt — ACP replies only when the turn ends. */
  let resolvePrompt: (result: unknown) => void;
  let rejectPrompt: (err: Error) => void;
  const defaultSessionOpts: StructuredSessionOpts = {
    mission: 'Fix the bug',
    cwd: '/tmp/project',
  };

  beforeEach(() => {
    vi.mocked(appLog).mockClear();
    resolvePrompt = () => {};
    rejectPrompt = () => {};
    mockClient = {
      start: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockImplementation((method: string) => {
        if (method === 'session/new') {
          return Promise.resolve({ sessionId: SESSION_ID });
        }
        if (method === 'session/prompt') {
          return new Promise((resolve, reject) => {
            resolvePrompt = resolve;
            rejectPrompt = reject;
          });
        }
        return Promise.resolve(undefined);
      }),
      respond: vi.fn(),
      respondWithError: vi.fn(),
      notify: vi.fn(),
      kill: vi.fn(),
      getStderr: vi.fn().mockReturnValue(''),
      alive: true,
      onNotification: () => {},
      onServerRequest: () => {},
      onExit: () => {},
      onLog: () => {},
    };

    // Use regular function (not arrow) so it can be called with `new`
    MockAcpClient.mockImplementation(function (this: unknown, opts: ConstructorParameters<typeof AcpClient>[0]) {
      // Capture callbacks
      mockClient.onNotification = opts.onNotification!;
      mockClient.onServerRequest = opts.onServerRequest!;
      mockClient.onExit = opts.onExit!;
      if (opts.onLog) mockClient.onLog = opts.onLog;
      Object.assign(this as object, mockClient);
      return this as unknown as AcpClient;
    } as unknown as ConstructorParameters<typeof MockAcpClient['mockImplementation']>[0]);
  });

  it('starts AcpClient with correct options', async () => {
    const adapter = new AcpAdapter({
      binary: '/usr/bin/copilot',
      args: ['--acp', '--stdio'],
      toolVerbs: { shell: 'Running command' },
    });

    const stream = adapter.start(defaultSessionOpts);
    await settle();
    mockClient.onExit(0, null);
    await collectEvents(stream, 1);

    expect(MockAcpClient).toHaveBeenCalledTimes(1);
    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.binary).toBe('/usr/bin/copilot');
    expect(opts.args).toEqual(['--acp', '--stdio']);
    expect(opts.cwd).toBe('/tmp/project');
    expect(mockClient.start).toHaveBeenCalled();
  });

  it('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT from env', async () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: [],
      env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'test', CUSTOM: 'val' },
    });

    adapter.start(defaultSessionOpts);
    await settle();

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.env).not.toHaveProperty('CLAUDECODE');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(opts.env).toHaveProperty('CUSTOM', 'val');
  });

  it('calls session/new then session/prompt on start, with no prompt timeout', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start({
      ...defaultSessionOpts,
      systemPrompt: 'Be helpful',
    });
    await settle();

    expect(mockClient.start).toHaveBeenCalled();
    expect(mockClient.request).toHaveBeenCalledWith('session/new', {
      cwd: '/tmp/project',
      mcpServers: [],
    });
    // A prompt replies only when the whole turn ends — it must not inherit
    // the 30s handshake timeout.
    expect(mockClient.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: SESSION_ID,
      prompt: [
        { type: 'text', text: 'Be helpful' },
        { type: 'text', text: 'Fix the bug' },
      ],
    }, { timeoutMs: null });
  });

  it('sends only mission in prompt when no systemPrompt', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    expect(mockClient.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'Fix the bug' }],
    }, { timeoutMs: null });
  });

  it('keeps the startup handshake on the default timeout', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    const newCall = mockClient.request.mock.calls.find(([m]) => m === 'session/new')!;
    expect(newCall).toHaveLength(2);
  });

  it('passes --model arg when model is specified', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: ['--acp'] });
    adapter.start({ ...defaultSessionOpts, model: 'gpt-5' });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp', '--model', 'gpt-5']);
  });

  it('passes --allow-tool args for allowedTools', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: ['--acp'] });
    adapter.start({
      ...defaultSessionOpts,
      allowedTools: ['shell', 'read'],
    });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp', '--allow-tool', 'shell', '--allow-tool', 'read']);
  });

  it('passes --deny-tool args for disallowedTools', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: ['--acp'] });
    adapter.start({
      ...defaultSessionOpts,
      disallowedTools: ['edit'],
    });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp', '--deny-tool', 'edit']);
  });

  it('passes --allow-all-tools for permissionMode skip-all', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: ['--acp'] });
    adapter.start({
      ...defaultSessionOpts,
      permissionMode: 'skip-all',
    });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toContain('--allow-all-tools');
  });

  it('appends extraArgs to spawn args (MCP injection)', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: ['--acp', '--stdio'] });
    adapter.start({
      ...defaultSessionOpts,
      extraArgs: ['--additional-mcp-config', '{"mcpServers":{"clubhouse":{}}}'],
    });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toContain('--additional-mcp-config');
    expect(opts.args).toContain('{"mcpServers":{"clubhouse":{}}}');
    const acpIdx = opts.args.indexOf('--acp');
    const mcpIdx = opts.args.indexOf('--additional-mcp-config');
    expect(mcpIdx).toBeGreaterThan(acpIdx);
  });

  // ── session/update mapping (update.sessionUpdate discriminator) ───────────

  it('maps agent_message_chunk → text_delta', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello' },
    }));

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('text_delta');
    expect(events[0].data).toEqual({ text: 'Hello' });
  });

  it('maps agent_thought_chunk → thinking', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking...' },
    }));

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('thinking');
    expect(events[0].data).toEqual({ text: 'Thinking...', isPartial: true });
  });

  it('ignores non-text message chunks', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    }));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
  });

  it('maps tool_call → tool_start and tool_call_update completed → tool_end', async () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: [],
      toolVerbs: { shell: 'Running command' },
    });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_001',
      title: 'Run npm test',
      name: 'shell',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'npm test' },
    }));
    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_001',
      status: 'in_progress',
    }));
    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_001',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'All tests passed' } }],
    }));

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].data).toEqual({
      id: 'call_001',
      name: 'shell',
      displayVerb: 'Running command',
      input: { command: 'npm test' },
    });
    expect(events[1].type).toBe('tool_end');
    expect(events[1].data).toEqual({
      id: 'call_001',
      name: 'shell',
      result: 'All tests passed',
      durationMs: 0,
      status: 'success',
    });
  });

  it('maps tool_call_update failed → tool_end status error, falling back to rawOutput', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_002',
      title: 'Read config',
      kind: 'read',
    }));
    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_002',
      status: 'failed',
      rawOutput: { error: 'ENOENT' },
    }));

    const events = await collectEvents(stream, 2);
    // No programmatic name → the ACP tool kind stands in
    expect((events[0].data as { name: string }).name).toBe('read');
    expect(events[1].data).toEqual({
      id: 'call_002',
      name: 'read',
      result: '{"error":"ENOENT"}',
      durationMs: 0,
      status: 'error',
    });
  });

  it('maps plan → plan_update', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the code', priority: 'high', status: 'completed' },
        { content: 'Fix the bug', priority: 'high', status: 'in_progress' },
        { content: 'Write tests', priority: 'medium', status: 'pending' },
      ],
    }));

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('plan_update');
    expect(events[0].data).toEqual({
      steps: [
        { description: 'Read the code', status: 'completed' },
        { description: 'Fix the bug', status: 'in_progress' },
        { description: 'Write tests', status: 'pending' },
      ],
    });
  });

  it('ignores session updates Clubhouse does not render', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    }));
    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200000,
    }));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
  });

  it('logs unmapped notification methods at debug level', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('unknown_future_method', { foo: 'bar' });
    mockClient.onExit(0, null);
    await collectEvents(stream, 1);

    expect(appLog).toHaveBeenCalledWith(
      'core:structured:acp',
      'debug',
      'Unmapped ACP notification: unknown_future_method',
      expect.objectContaining({
        meta: expect.objectContaining({ method: 'unknown_future_method' }),
      }),
    );
  });

  // ── Turn completion via the session/prompt reply ──────────────────────────

  it('completes the turn when session/prompt returns stopReason end_turn', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done.' },
    }));
    resolvePrompt({ stopReason: 'end_turn' });

    // The stream finishes on its own — no process exit needed
    const events = await collectAll(stream);
    expect(events.map(e => e.type)).toEqual(['text_delta', 'end']);
    expect(events[1].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('ends the turn as cancelled for stopReason cancelled', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    resolvePrompt({ stopReason: 'cancelled' });

    const events = await collectAll(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ reason: 'cancelled', summary: 'Turn cancelled' });
  });

  it.each([
    ['max_tokens'],
    ['max_turn_requests'],
    ['refusal'],
  ])('fails the turn for stopReason %s', async (stopReason) => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    resolvePrompt({ stopReason });

    const events = await collectAll(stream);
    expect(events.map(e => e.type)).toEqual(['error', 'end']);
    expect((events[0].data as { code: string }).code).toBe(stopReason);
    expect((events[1].data as { reason: string }).reason).toBe('error');
  });

  it('fails the turn when session/prompt is rejected', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    rejectPrompt(new Error('RPC error -32603: Internal error'));

    const events = await collectAll(stream);
    expect(events.map(e => e.type)).toEqual(['error', 'end']);
    expect(events[0].data).toEqual({
      code: 'prompt_failed',
      message: 'RPC error -32603: Internal error',
    });
    expect((events[1].data as { reason: string }).reason).toBe('error');
  });

  it('emits a single end when the process exits mid-turn', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onExit(1, null);
    rejectPrompt(new Error('Process exited with code 1, signal null'));

    const events = await collectAll(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('end');
    expect((events[0].data as { reason: string }).reason).toBe('error');
  });

  // ── session/request_permission ───────────────────────────────────────────

  it('maps session/request_permission → permission_request', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(7, 'session/request_permission', permissionRequest());

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('permission_request');
    expect(events[0].data).toEqual({
      id: 'call_001',
      toolName: 'edit',
      toolInput: { path: 'src/index.ts' },
      description: 'Edit src/index.ts',
    });
  });

  it('approving selects the allow_once option', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(7, 'session/request_permission', permissionRequest());
    await adapter.respondToPermission('call_001', true);

    expect(mockClient.respond).toHaveBeenCalledWith(7, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('denying selects the reject_once option', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(7, 'session/request_permission', permissionRequest());
    await adapter.respondToPermission('call_001', false);

    expect(mockClient.respond).toHaveBeenCalledWith(7, {
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    });
  });

  it('falls back to the *_always option when no one-shot option is offered', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(8, 'session/request_permission', permissionRequest([
      { optionId: 'yes-forever', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no-forever', name: 'Never', kind: 'reject_always' },
    ]));
    await adapter.respondToPermission('call_001', false);

    expect(mockClient.respond).toHaveBeenCalledWith(8, {
      outcome: { outcome: 'selected', optionId: 'no-forever' },
    });
  });

  it('answers cancelled when no option matches the decision', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(9, 'session/request_permission', permissionRequest([
      { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
    ]));
    await adapter.respondToPermission('call_001', false);

    expect(mockClient.respond).toHaveBeenCalledWith(9, { outcome: { outcome: 'cancelled' } });
  });

  it('keeps concurrent permission requests for one tool call apart', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(10, 'session/request_permission', permissionRequest());
    mockClient.onServerRequest(11, 'session/request_permission', permissionRequest());

    const events = await collectEvents(stream, 2);
    const ids = events.map(e => (e.data as { id: string }).id);
    expect(ids).toEqual(['call_001', 'perm-11']);

    await adapter.respondToPermission('perm-11', true);
    expect(mockClient.respond).toHaveBeenCalledWith(11, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('respondToPermission throws for unknown request ID', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    await expect(
      adapter.respondToPermission('nonexistent', false),
    ).rejects.toThrow('No pending approval');
  });

  it('answers unhandled agent requests with a JSON-RPC error', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(12, 'fs/read_text_file', { sessionId: SESSION_ID, path: '/etc/hosts' });

    expect(mockClient.respondWithError).toHaveBeenCalledWith(12, -32601, expect.stringContaining('fs/read_text_file'));
    const events = await collectEvents(stream, 1);
    expect((events[0].data as { code: string }).code).toBe('unhandled_server_request');
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  it('sendMessage sends session/prompt without waiting for the turn to end', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    // Resolves although the prompt reply (the end of the turn) is still pending
    await adapter.sendMessage('continue with step 2');

    expect(mockClient.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: SESSION_ID,
      prompt: [{ type: 'text', text: 'continue with step 2' }],
    }, { timeoutMs: null });
  });

  it('sendMessage throws if adapter not started', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });

    await expect(adapter.sendMessage('hello')).rejects.toThrow('not started');
  });

  it('sendMessage throws if no session', async () => {
    mockClient.request.mockImplementation((method: string) => {
      if (method === 'session/new') {
        return Promise.resolve({ sessionId: undefined });
      }
      return Promise.resolve(undefined);
    });

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await settle();

    await expect(adapter.sendMessage('hello')).rejects.toThrow('No active session');
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  it('cancel sends session/cancel and answers pending permissions cancelled', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onServerRequest(7, 'session/request_permission', permissionRequest());
    await adapter.cancel();

    expect(mockClient.respond).toHaveBeenCalledWith(7, { outcome: { outcome: 'cancelled' } });
    expect(mockClient.notify).toHaveBeenCalledWith('session/cancel', { sessionId: SESSION_ID });
    expect(mockClient.kill).not.toHaveBeenCalled();

    // The agent confirms with stopReason cancelled, which ends the turn
    resolvePrompt({ stopReason: 'cancelled' });
    const events = await collectAll(stream);
    expect(events.at(-1)!.data).toEqual({ reason: 'cancelled', summary: 'Turn cancelled' });
  });

  it('cancel kills the process when there is no session to cancel', async () => {
    mockClient.start.mockReturnValue(new Promise(() => {}));
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    await adapter.cancel();

    expect(mockClient.notify).not.toHaveBeenCalled();
    expect(mockClient.kill).toHaveBeenCalled();
  });

  it('cancel does not throw if client is null', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });

    await expect(adapter.cancel()).resolves.toBeUndefined();
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  it('dispose kills client and finishes queue', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    adapter.dispose();

    expect(mockClient.kill).toHaveBeenCalled();
    expect(await collectAll(stream)).toEqual([]);
  });

  // ── Process exit ──────────────────────────────────────────────────────────

  it('emits end event with reason complete on code 0', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await settle();
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect(events[0].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('emits end event with reason error on non-zero exit', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await settle();
    mockClient.onExit(1, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect((events[0].data as { reason: string }).reason).toBe('error');
  });

  // ── Startup failure ───────────────────────────────────────────────────────

  it('emits error + end events and finishes queue when startup fails', async () => {
    mockClient.start.mockRejectedValue(new Error('Connection refused'));

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const events = await collectAll(adapter.start(defaultSessionOpts));

    const errorEvent = events.find(e => e.type === 'error')!;
    expect((errorEvent.data as { code: string }).code).toBe('session_start_failed');
    const endEvent = events.find(e => e.type === 'end')!;
    expect((endEvent.data as { reason: string }).reason).toBe('error');
  });

  it('emits error + end events when session/new fails', async () => {
    const { RpcError } = await import('./acp-client');
    const rpcErr = new RpcError(-32601, 'Method not found');

    mockClient.request.mockImplementation((method: string) => {
      if (method === 'session/new') return Promise.reject(rpcErr);
      return Promise.resolve(undefined);
    });

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const events = await collectAll(adapter.start(defaultSessionOpts));

    const errorEvent = events.find(e => e.type === 'error')!;
    expect((errorEvent.data as { code: string }).code).toBe('session_start_failed');
    expect(events.some(e => e.type === 'end')).toBe(true);
  });

  // ── Tool verb resolution ──────────────────────────────────────────────────

  it('resolves tool verbs from config', async () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: [],
      toolVerbs: { shell: 'Running command', edit: 'Editing file' },
    });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit a file',
      name: 'edit',
    }));

    const events = await collectEvents(stream, 1);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Editing file');
  });

  it('falls back to "Using tool" for unknown tools', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);
    await settle();

    mockClient.onNotification('session/update', sessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Custom',
      name: 'custom_tool',
    }));

    const events = await collectEvents(stream, 1);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Using tool');
  });

  // ── Diagnostic logging tests ──────────────────────────────────────────────

  it('logs session start parameters', () => {
    const adapter = new AcpAdapter({
      binary: '/usr/bin/copilot',
      args: ['--acp'],
    });
    adapter.start({
      ...defaultSessionOpts,
      model: 'gpt-5',
      systemPrompt: 'Be helpful',
    });

    expect(appLog).toHaveBeenCalledWith(
      'core:structured',
      'info',
      'AcpAdapter spawning',
      {
        meta: {
          binary: '/usr/bin/copilot',
          cwd: '/tmp/project',
          model: 'gpt-5',
        },
      },
    );
  });

  it('logs startup failure with error details', async () => {
    const { RpcError } = await import('./acp-client');
    mockClient.start.mockRejectedValue(new RpcError(-32601, 'Method not found'));

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    await collectAll(adapter.start(defaultSessionOpts));

    expect(appLog).toHaveBeenCalledWith(
      'core:structured',
      'error',
      'AcpAdapter startup failed',
      expect.objectContaining({
        meta: expect.objectContaining({ rpcCode: -32601 }),
      }),
    );
  });

  it('passes onLog callback to AcpClient', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.onLog).toBeDefined();
  });
});
