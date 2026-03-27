import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredEvent } from '../../../shared/structured-events';
import type { StructuredSessionOpts } from '../types';

// Mock AcpClient
vi.mock('./acp-client', () => ({
  AcpClient: vi.fn(),
}));

// Mock shell environment
vi.mock('../../util/shell', () => ({
  getShellEnvironment: vi.fn().mockReturnValue({ PATH: '/usr/bin', HOME: '/home/test' }),
  cleanSpawnEnv: vi.fn((env: Record<string, string>) => { delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; return env; }),
}));

import { AcpClient } from './acp-client';
import { AcpAdapter } from './acp-adapter';

const MockAcpClient = vi.mocked(AcpClient);

interface MockClientInstance {
  start: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (id: number | string, method: string, params: unknown) => void;
  onExit: (code: number | null, signal: string | null) => void;
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
      start: vi.fn(),
      request: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      kill: vi.fn(),
      onNotification: () => {},
      onServerRequest: () => {},
      onExit: () => {},
    };

    // Use regular function (not arrow) so it can be called with `new`
    MockAcpClient.mockImplementation(function (this: unknown, opts: ConstructorParameters<typeof AcpClient>[0]) {
      // Capture callbacks
      mockClient.onNotification = opts.onNotification!;
      mockClient.onServerRequest = opts.onServerRequest!;
      mockClient.onExit = opts.onExit!;
      Object.assign(this as object, mockClient);
      return this as unknown as AcpClient;
    } as unknown as ConstructorParameters<typeof MockAcpClient['mockImplementation']>[0]);
  });

  it('starts AcpClient with correct options', () => {
    const adapter = new AcpAdapter({
      binary: '/usr/bin/copilot',
      args: ['--acp', '--stdio'],
      toolVerbs: { shell: 'Running command' },
    });

    adapter.start(defaultSessionOpts);

    expect(MockAcpClient).toHaveBeenCalledTimes(1);
    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.binary).toBe('/usr/bin/copilot');
    expect(opts.args).toEqual(['--acp', '--stdio']);
    expect(opts.cwd).toBe('/tmp/project');
    expect(mockClient.start).toHaveBeenCalled();
  });

  it('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT from env', () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: [],
      env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'test', CUSTOM: 'val' },
    });

    adapter.start(defaultSessionOpts);

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.env).not.toHaveProperty('CLAUDECODE');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(opts.env).toHaveProperty('CUSTOM', 'val');
  });

  it('sends session/start request on start', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start({
      ...defaultSessionOpts,
      systemPrompt: 'Be helpful',
      allowedTools: ['shell'],
    });

    expect(mockClient.request).toHaveBeenCalledWith('session/start', {
      mission: 'Fix the bug',
      systemPrompt: 'Be helpful',
      allowedTools: ['shell'],
      disallowedTools: undefined,
      autoApprove: undefined,
    });
  });

  it('passes --model arg when model is specified', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: ['--acp'] });
    adapter.start({ ...defaultSessionOpts, model: 'gpt-5' });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp', '--model', 'gpt-5']);
  });

  // ── Free agent mode ─────────────────────────────────────────────────────────

  it('appends freeAgentArgs to CLI args when freeAgentMode is true', () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: ['--acp', '--stdio'],
      freeAgentArgs: ['--yolo', '--autopilot'],
    });
    adapter.start({ ...defaultSessionOpts, freeAgentMode: true });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp', '--stdio', '--yolo', '--autopilot']);
  });

  it('does not append freeAgentArgs when freeAgentMode is false', () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: ['--acp', '--stdio'],
      freeAgentArgs: ['--yolo', '--autopilot'],
    });
    adapter.start({ ...defaultSessionOpts, freeAgentMode: false });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp', '--stdio']);
  });

  it('does not append freeAgentArgs when freeAgentMode is undefined', () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: ['--acp', '--stdio'],
      freeAgentArgs: ['--yolo', '--autopilot'],
    });
    adapter.start(defaultSessionOpts);

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp', '--stdio']);
  });

  it('does not fail when freeAgentMode is true but no freeAgentArgs configured', () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: ['--acp'],
    });
    adapter.start({ ...defaultSessionOpts, freeAgentMode: true });

    const opts = MockAcpClient.mock.calls[0][0];
    expect(opts.args).toEqual(['--acp']);
  });

  it('sends autoApprove in session/start when freeAgentMode is true', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start({ ...defaultSessionOpts, freeAgentMode: true });

    expect(mockClient.request).toHaveBeenCalledWith('session/start', {
      mission: 'Fix the bug',
      systemPrompt: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
      autoApprove: true,
    });
  });

  it('does not send autoApprove in session/start when freeAgentMode is false', () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start({ ...defaultSessionOpts, freeAgentMode: false });

    expect(mockClient.request).toHaveBeenCalledWith('session/start', {
      mission: 'Fix the bug',
      systemPrompt: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
      autoApprove: undefined,
    });
  });

  // ── Notification mapping tests ────────────────────────────────────────────

  it('maps agent_message_chunk → text_delta', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('agent_message_chunk', { text: 'Hello' });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('text_delta');
    expect(events[0].data).toEqual({ text: 'Hello' });
  });

  it('maps agent_thought_chunk → thinking', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

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

    await expect(
      adapter.respondToPermission('nonexistent', false),
    ).rejects.toThrow('No pending approval');
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  it('sendMessage sends session/send request', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    await adapter.sendMessage('continue with step 2');

    expect(mockClient.request).toHaveBeenCalledWith('session/send', {
      message: 'continue with step 2',
    });
  });

  it('sendMessage throws if adapter not started', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });

    await expect(adapter.sendMessage('hello')).rejects.toThrow('not started');
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  it('cancel sends session/cancel then kills process', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    await adapter.cancel();

    expect(mockClient.request).toHaveBeenCalledWith('session/cancel', {});
    expect(mockClient.kill).toHaveBeenCalled();
  });

  it('cancel does not throw if client already dead', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    adapter.start(defaultSessionOpts);

    mockClient.request.mockRejectedValueOnce(new Error('Process exited'));

    await expect(adapter.cancel()).resolves.toBeUndefined();
    expect(mockClient.kill).toHaveBeenCalled();
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

    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect(events[0].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('emits end event with reason error on non-zero exit', async () => {
    const adapter = new AcpAdapter({ binary: 'copilot', args: [] });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onExit(1, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect((events[0].data as { reason: string }).reason).toBe('error');
  });

  // ── Tool verb resolution ──────────────────────────────────────────────────

  it('resolves tool verbs from config', async () => {
    const adapter = new AcpAdapter({
      binary: 'copilot',
      args: [],
      toolVerbs: { shell: 'Running command', edit: 'Editing file' },
    });
    const stream = adapter.start(defaultSessionOpts);

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

    mockClient.onNotification('tool_call', {
      id: 't1',
      name: 'custom_tool',
      input: {},
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Using tool');
  });
});
