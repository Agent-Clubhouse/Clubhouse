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
  notify: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  getStderr: ReturnType<typeof vi.fn>;
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

describe('AcpAdapter', () => {
  let mockClient: MockClientInstance;
  const defaultSessionOpts: StructuredSessionOpts = {
    mission: 'Fix the bug',
    cwd: '/tmp/project',
  };

  beforeEach(() => {
    mockClient = {
      start: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockImplementation((method: string) => {
        if (method === 'session/new') {
          return Promise.resolve({ sessionId: 'test-session-id' });
        }
        return Promise.resolve(undefined);
      }),
      respond: vi.fn(),
      notify: vi.fn(),
      kill: vi.fn(),
      getStderr: vi.fn().mockReturnValue(''),
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
    // Let the async startup chain complete
    await new Promise(r => setTimeout(r, 10));
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
    await new Promise(r => setTimeout(r, 10));

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.env).not.toHaveProperty('CLAUDECODE');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(opts.env).toHaveProperty('CUSTOM', 'val');
  });

  // ── ACP protocol flow tests ──────────────────────────────────────────────

  it('calls session/new then session/prompt on start', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start({
      ...defaultSessionOpts,
      systemPrompt: 'Be helpful',
    });

    // Let the async startup chain complete
    await new Promise(r => setTimeout(r, 10));
    mockClient.onExit(0, null);
    await collectEvents(stream, 1);

    // start() should have been called (init handshake)
    expect(mockClient.start).toHaveBeenCalled();

    // session/new should be called with cwd and mcpServers
    expect(mockClient.request).toHaveBeenCalledWith('session/new', {
      cwd: '/tmp/project',
      mcpServers: [],
    });

    // session/prompt should be called with sessionId and prompt parts
    expect(mockClient.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'test-session-id',
      prompt: [
        { type: 'text', text: 'Be helpful' },
        { type: 'text', text: 'Fix the bug' },
      ],
    });
  });

  it('sends only mission in prompt when no systemPrompt', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onExit(0, null);
    await collectEvents(stream, 1);

    expect(mockClient.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'Fix the bug' }],
    });
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
    expect(opts.args).toContain('--allow-tool');
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

  // ── Notification mapping tests ────────────────────────────────────────────

  it('maps agent_message_chunk → text_delta', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('agent_message_chunk', { text: 'Hello' });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('text_delta');
    expect(events[0].data).toEqual({ text: 'Hello' });
  });

  it('maps agent_thought_chunk → thinking', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('agent_thought_chunk', { text: 'Thinking...' });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('thinking');
    expect(events[0].data).toEqual({ text: 'Thinking...', isPartial: true });
  });

  it('maps tool_call → tool_start', async () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: [],
      toolVerbs: { shell: 'Running command' },
    });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('tool_call', {
      id: 't1',
      name: 'shell',
      input: { command: 'ls' },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].data).toEqual({
      id: 't1',
      name: 'shell',
      displayVerb: 'Running command',
      input: { command: 'ls' },
    });
  });

  it('maps tool_call with requires_approval → permission_request', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('tool_call', {
      id: 't2',
      name: 'edit',
      input: { path: '/etc/hosts' },
      requires_approval: true,
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('permission_request');
    expect((events[0].data as { id: string }).id).toBe('t2');
    expect((events[0].data as { toolName: string }).toolName).toBe('edit');
  });

  it('maps tool_result → tool_end', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('tool_result', {
      id: 't1',
      name: 'shell',
      result: 'file.txt',
      duration_ms: 150,
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect(events[0].data).toEqual({
      id: 't1',
      name: 'shell',
      result: 'file.txt',
      durationMs: 150,
      status: 'success',
    });
  });

  it('maps tool_result with error → tool_end status error', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('tool_result', {
      id: 't1',
      name: 'shell',
      result: 'Permission denied',
      error: true,
      duration_ms: 50,
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect((events[0].data as { status: string }).status).toBe('error');
  });

  it('maps file_change → file_diff', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('file_change', {
      path: 'src/index.ts',
      change_type: 'modify',
      diff: '+ new line',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('file_diff');
    expect(events[0].data).toEqual({
      path: 'src/index.ts',
      changeType: 'modify',
      diff: '+ new line',
    });
  });

  it('maps command_execution → command_output', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('command_execution', {
      id: 'c1',
      command: 'npm test',
      status: 'completed',
      output: 'All tests passed',
      exit_code: 0,
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('command_output');
    expect(events[0].data).toEqual({
      id: 'c1',
      command: 'npm test',
      status: 'completed',
      output: 'All tests passed',
      exitCode: 0,
    });
  });

  it('maps plan → plan_update', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('plan', {
      steps: [
        { description: 'Read files', status: 'completed' },
        { description: 'Edit code', status: 'in_progress' },
      ],
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('plan_update');
    expect(events[0].data).toEqual({
      steps: [
        { description: 'Read files', status: 'completed' },
        { description: 'Edit code', status: 'in_progress' },
      ],
    });
  });

  it('maps usage → usage', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('usage', {
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.002,
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('usage');
    expect(events[0].data).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      costUsd: 0.002,
    });
  });

  it('maps error → error', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('error', {
      code: 'rate_limit',
      message: 'Too many requests',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('error');
    expect(events[0].data).toEqual({
      code: 'rate_limit',
      message: 'Too many requests',
      toolId: undefined,
    });
  });

  it('silently ignores unknown notification methods', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('unknown_method', { data: 'whatever' });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    // Only the end event from onExit
    expect(events[0].type).toBe('end');
  });

  // ── Server request (permission) mapping ───────────────────────────────────

  it('maps session/request_permission → permission_request', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onServerRequest('rpc-5', 'session/request_permission', {
      id: 'perm-1',
      tool: 'shell',
      args: { command: 'rm -rf /' },
      description: 'Run dangerous command',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('permission_request');
    expect(events[0].data).toEqual({
      id: 'perm-1',
      toolName: 'shell',
      toolInput: { command: 'rm -rf /' },
      description: 'Run dangerous command',
    });
  });

  // ── Permission response flow ──────────────────────────────────────────────

  it('respondToPermission sends approval back via JSON-RPC', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await new Promise(r => setTimeout(r, 10));

    // Trigger a permission request
    mockClient.onServerRequest('rpc-42', 'session/request_permission', {
      id: 'perm-abc',
      tool: 'edit',
      args: {},
      description: 'Edit file',
    });

    await adapter.respondToPermission('perm-abc', true);

    expect(mockClient.respond).toHaveBeenCalledWith('rpc-42', { approved: true });
  });

  it('respondToPermission throws for unknown request ID', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await new Promise(r => setTimeout(r, 10));

    await expect(
      adapter.respondToPermission('nonexistent', false),
    ).rejects.toThrow('No pending approval');
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  it('sendMessage sends session/prompt request with sessionId', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    // Wait for the async startup chain to complete (start → session/new → session/prompt)
    await new Promise(r => setTimeout(r, 10));

    await adapter.sendMessage('continue with step 2');

    expect(mockClient.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'continue with step 2' }],
    });
  });

  it('sendMessage throws if adapter not started', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });

    await expect(adapter.sendMessage('hello')).rejects.toThrow('not started');
  });

  it('sendMessage throws if no session', async () => {
    // Override request to return no sessionId
    mockClient.request.mockImplementation((method: string) => {
      if (method === 'session/new') {
        return Promise.resolve({ sessionId: undefined });
      }
      return Promise.resolve(undefined);
    });

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    // Wait for startup to fail
    await new Promise(r => setTimeout(r, 10));

    await expect(adapter.sendMessage('hello')).rejects.toThrow('No active session');
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  it('cancel kills process directly', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);
    await new Promise(r => setTimeout(r, 10));

    await adapter.cancel();

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

    // Stream should terminate
    const events: StructuredEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });

  // ── Process exit ──────────────────────────────────────────────────────────

  it('emits end event with reason complete on code 0', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect(events[0].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('emits end event with reason error on non-zero exit', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onExit(1, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect((events[0].data as { reason: string }).reason).toBe('error');
  });

  // ── Startup failure ───────────────────────────────────────────────────────

  it('emits error event when startup fails', async () => {
    mockClient.start.mockRejectedValue(new Error('Connection refused'));

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    // Let the async error handler run before triggering exit
    await new Promise(r => setTimeout(r, 10));
    mockClient.onExit(1, null);

    const events: StructuredEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'error')).toBe(true);
    const errorEvent = events.find(e => e.type === 'error')!;
    expect((errorEvent.data as { code: string }).code).toBe('session_start_failed');
  });

  it('emits error event when session/new fails', async () => {
    const { RpcError } = await import('./acp-client');
    const rpcErr = new RpcError(-32601, 'Method not found');

    mockClient.request.mockImplementation((method: string) => {
      if (method === 'session/new') return Promise.reject(rpcErr);
      return Promise.resolve(undefined);
    });

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onExit(1, null);

    const events: StructuredEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'error')).toBe(true);
    const errorEvent = events.find(e => e.type === 'error')!;
    expect((errorEvent.data as { code: string }).code).toBe('session_start_failed');
  });

  // ── Tool verb resolution ──────────────────────────────────────────────────

  it('resolves tool verbs from config', async () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: [],
      toolVerbs: { shell: 'Running command', edit: 'Editing file' },
    });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('tool_call', {
      id: 't1',
      name: 'edit',
      input: {},
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Editing file');
  });

  it('falls back to "Using tool" for unknown tools', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('tool_call', {
      id: 't1',
      name: 'custom_tool',
      input: {},
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Using tool');
  });

  // ── Diagnostic logging tests ──────────────────────────────────────────────

  it('logs session start parameters', () => {
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    const adapter = new AcpAdapter({
      binary: '/usr/bin/copilot',
      args: ['--acp'],
    });
    adapter.start({
      ...defaultSessionOpts,
      model: 'gpt-5',
      systemPrompt: 'Be helpful',
    });

    expect(mockAppLog).toHaveBeenCalledWith(
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
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    const { RpcError } = await import('./acp-client');
    const rpcErr = new RpcError(-32601, 'Method not found');

    mockClient.start.mockRejectedValue(rpcErr);

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onExit(1, null);

    const events: StructuredEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'error')).toBe(true);
    const errorEvent = events.find(e => e.type === 'error')!;
    expect((errorEvent.data as { code: string }).code).toBe('session_start_failed');

    expect(mockAppLog).toHaveBeenCalledWith(
      'core:structured',
      'error',
      'AcpAdapter startup failed',
      expect.objectContaining({
        meta: expect.objectContaining({
          rpcCode: -32601,
        }),
      }),
    );
  });

  it('logs unmapped notification methods at debug level', async () => {
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    await new Promise(r => setTimeout(r, 10));
    mockClient.onNotification('unknown_future_method', { foo: 'bar' });
    mockClient.onExit(0, null);

    await collectEvents(stream, 1);

    expect(mockAppLog).toHaveBeenCalledWith(
      'core:structured:acp',
      'debug',
      'Unmapped ACP notification: unknown_future_method',
    );
  });

  it('passes onLog callback to AcpClient', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.onLog).toBeDefined();
  });
});
