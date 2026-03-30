import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StructuredEvent } from '../../../shared/structured-events';
import type { StructuredSessionOpts } from '../types';

// Mock CodexAppServerClient
vi.mock('./codex-app-server-client', () => ({
  CodexAppServerClient: vi.fn(),
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

import { CodexAppServerClient } from './codex-app-server-client';
import { CodexAppServerAdapter } from './codex-app-server-adapter';
import { appLog } from '../../services/log-service';

const MockClient = vi.mocked(CodexAppServerClient);

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

/** Flush pending microtasks (for async start → startThread chain) */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('CodexAppServerAdapter', () => {
  let mockClient: MockClientInstance;
  const defaultSessionOpts: StructuredSessionOpts = {
    mission: 'Fix the bug',
    cwd: '/tmp/project',
  };

  beforeEach(() => {
    mockClient = {
      start: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockImplementation((method: string) => {
        if (method === 'thread/start') {
          return Promise.resolve({ thread: { id: 'test-thread-1' } });
        }
        return Promise.resolve({});
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

    MockClient.mockImplementation(function (this: unknown, opts: ConstructorParameters<typeof CodexAppServerClient>[0]) {
      mockClient.onNotification = opts.onNotification!;
      mockClient.onServerRequest = opts.onServerRequest!;
      mockClient.onExit = opts.onExit!;
      if (opts.onLog) mockClient.onLog = opts.onLog;
      Object.assign(this as object, mockClient);
      return this as unknown as CodexAppServerClient;
    } as unknown as ConstructorParameters<typeof MockClient['mockImplementation']>[0]);
  });

  it('creates client with correct options', () => {
    const adapter = new CodexAppServerAdapter({
      binary: '/usr/bin/codex',
      toolVerbs: { shell: 'Running command' },
    });

    adapter.start(defaultSessionOpts);

    expect(MockClient).toHaveBeenCalledTimes(1);
    const opts = MockClient.mock.calls[0][0];
    expect(opts.binary).toBe('/usr/bin/codex');
    expect(opts.args).toEqual(['app-server', '--listen', 'stdio://']);
    expect(opts.cwd).toBe('/tmp/project');
  });

  it('appends extraArgs to spawn args (MCP injection)', () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({
      ...defaultSessionOpts,
      extraArgs: ['-c', 'mcp_servers.clubhouse.command="node"'],
    });

    const opts = MockClient.mock.calls[0][0];
    expect(opts.args).toEqual([
      'app-server', '--listen', 'stdio://',
      '-c', 'mcp_servers.clubhouse.command="node"',
    ]);
  });

  it('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT from env', () => {
    const adapter = new CodexAppServerAdapter({
      binary: 'codex',
      env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'test', CUSTOM: 'val' },
    });

    adapter.start(defaultSessionOpts);

    const opts = MockClient.mock.calls[0][0];
    expect(opts.env).not.toHaveProperty('CLAUDECODE');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(opts.env).toHaveProperty('CUSTOM', 'val');
  });

  it('starts client and creates thread + turn on start', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    await flushMicrotasks();

    expect(mockClient.start).toHaveBeenCalled();
    expect(mockClient.request).toHaveBeenCalledWith('thread/start', {
      model: undefined,
      cwd: '/tmp/project',
    });
    expect(mockClient.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'test-thread-1',
      input: [{ type: 'text', text: 'Fix the bug' }],
    });
  });

  it('passes model in thread/start', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({ ...defaultSessionOpts, model: 'gpt-5.3-codex' });

    await flushMicrotasks();

    expect(mockClient.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      model: 'gpt-5.3-codex',
    }));
  });

  it('passes sandbox for freeAgentMode', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({ ...defaultSessionOpts, freeAgentMode: true });

    await flushMicrotasks();

    expect(mockClient.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({
      sandbox: 'workspace-write',
    }));
  });

  it('combines system prompt and mission in turn/start', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({ ...defaultSessionOpts, systemPrompt: 'Be concise', mission: 'Fix bug' });

    await flushMicrotasks();

    expect(mockClient.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      input: [{ type: 'text', text: 'Be concise\n\nFix bug' }],
    }));
  });

  it('wraps binary with shell when commandPrefix is set', () => {
    const adapter = new CodexAppServerAdapter({ binary: '/usr/bin/codex' });
    adapter.start({ ...defaultSessionOpts, commandPrefix: 'source ~/.env' });

    const opts = MockClient.mock.calls[0][0];
    expect(opts.binary).toBe('sh');
    expect(opts.args[0]).toBe('-c');
    expect(opts.args[1]).toContain('source ~/.env');
    // Binary is passed as a separate arg after '_' placeholder for exec "$@"
    expect(opts.args).toContain('/usr/bin/codex');
  });

  it('emits error + end on startup failure', async () => {
    mockClient.start.mockRejectedValue(new Error('Connection refused'));

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('error');
    expect((events[0].data as { code: string }).code).toBe('startup_failed');
    expect(events[1].type).toBe('end');
    expect((events[1].data as { reason: string }).reason).toBe('error');
  });

  // ── Notification mapping tests ────────────────────────────────────────────

  it('maps item/agentMessage/delta → text_delta', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/agentMessage/delta', {
      delta: { text: 'Hello world' },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('text_delta');
    expect(events[0].data).toEqual({ text: 'Hello world' });
  });

  it('maps item/reasoning/summaryTextDelta → thinking', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/reasoning/summaryTextDelta', {
      delta: { text: 'Let me think...' },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('thinking');
    expect(events[0].data).toEqual({ text: 'Let me think...', isPartial: true });
  });

  it('maps item/started (CommandExecution) → tool_start', async () => {
    const adapter = new CodexAppServerAdapter({
      binary: 'codex',
      toolVerbs: { shell: 'Running command' },
    });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      item: {
        id: 'item-1',
        type: 'command_execution',
        details: { command: 'npm test' },
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].data).toEqual({
      id: 'item-1',
      name: 'shell',
      displayVerb: 'Running command',
      input: { command: 'npm test' },
    });
  });

  it('maps item/started (FileChange) → tool_start', async () => {
    const adapter = new CodexAppServerAdapter({
      binary: 'codex',
      toolVerbs: { apply_patch: 'Editing file' },
    });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      item: {
        id: 'item-2',
        type: 'file_change',
        details: { path: 'src/index.ts' },
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].data).toEqual({
      id: 'item-2',
      name: 'apply_patch',
      displayVerb: 'Editing file',
      input: { path: 'src/index.ts' },
    });
  });

  it('maps item/started (McpToolCall) → tool_start', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      item: {
        id: 'item-3',
        type: 'mcp_tool_call',
        details: { tool: 'database_query', arguments: { sql: 'SELECT 1' } },
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect((events[0].data as { name: string }).name).toBe('database_query');
    expect((events[0].data as { input: Record<string, unknown> }).input).toEqual({ sql: 'SELECT 1' });
  });

  it('maps item/completed (AgentMessage) → text_done', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', {
      item: { id: 'item-1', type: 'agent_message', text: 'Done! Here is the result.' },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('text_done');
    expect(events[0].data).toEqual({ text: 'Done! Here is the result.' });
  });

  it('maps item/completed (CommandExecution, success) → tool_end', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', {
      item: {
        id: 'item-1',
        type: 'command_execution',
        details: { aggregated_output: 'All tests passed', exit_code: 0, status: 'Completed' },
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect(events[0].data).toEqual({
      id: 'item-1',
      name: 'shell',
      result: 'All tests passed',
      durationMs: 0,
      status: 'success',
    });
  });

  it('maps item/completed (CommandExecution, failed) → tool_end with error', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', {
      item: {
        id: 'item-1',
        type: 'command_execution',
        details: { aggregated_output: 'Permission denied', exit_code: 1, status: 'Failed' },
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect((events[0].data as { status: string }).status).toBe('error');
  });

  it('maps item/completed (FileChange) → tool_end', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', {
      item: {
        id: 'item-2',
        type: 'file_change',
        details: { path: 'src/index.ts' },
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect(events[0].data).toEqual({
      id: 'item-2',
      name: 'apply_patch',
      result: 'src/index.ts',
      durationMs: 0,
      status: 'success',
    });
  });

  it('maps item/completed (TodoList) → plan_update', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', {
      item: {
        id: 'item-5',
        type: 'todo_list',
        items: [
          { text: 'Read files', completed: true },
          { text: 'Edit code', completed: false },
        ],
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('plan_update');
    expect(events[0].data).toEqual({
      steps: [
        { description: 'Read files', status: 'completed' },
        { description: 'Edit code', status: 'pending' },
      ],
    });
  });

  it('maps item/commandExecution/outputDelta → command_output', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/commandExecution/outputDelta', {
      itemId: 'item-1',
      delta: { output: 'Running tests...\n' },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('command_output');
    expect(events[0].data).toEqual({
      id: 'item-1',
      command: '',
      status: 'running',
      output: 'Running tests...\n',
      exitCode: undefined,
    });
  });

  it('maps turn/diff/updated → file_diff', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/diff/updated', {
      files: [
        { path: 'src/index.ts', kind: 'Update', diff: '+new line\n-old line' },
      ],
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('file_diff');
    expect(events[0].data).toEqual({
      path: 'src/index.ts',
      changeType: 'modify',
      diff: '+new line\n-old line',
    });
  });

  it('maps turn/diff/updated with Add kind → create', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/diff/updated', {
      files: [{ path: 'new-file.ts', kind: 'Add', diff: '+content' }],
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { changeType: string }).changeType).toBe('create');
  });

  it('maps thread/tokenUsage/updated → usage', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('thread/tokenUsage/updated', {
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80 },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('usage');
    expect(events[0].data).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheWriteTokens: undefined,
      costUsd: undefined,
    });
  });

  it('maps turn/completed → usage + end, finishes queue', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/completed', {
      status: 'completed',
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('usage');
    expect(events[0].data).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      costUsd: undefined,
    });
    expect(events[1].type).toBe('end');
    expect(events[1].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('maps turn/completed with failed status → usage + error + end', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/completed', {
      status: 'failed',
      usage: { input_tokens: 50, output_tokens: 10 },
      error: { type: 'ContextWindowExceeded', message: 'Context window exceeded' },
    });

    const events = await collectEvents(stream, 3);
    expect(events[0].type).toBe('usage');
    expect(events[1].type).toBe('error');
    expect(events[1].data).toEqual({
      code: 'ContextWindowExceeded',
      message: 'Context window exceeded',
    });
    expect(events[2].type).toBe('end');
    expect((events[2].data as { reason: string }).reason).toBe('error');
  });

  it('silently ignores unknown notification methods', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('unknown/method', { data: 'whatever' });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    // Only the end event from onExit
    expect(events[0].type).toBe('end');
  });

  it('ignores item/started for unknown item types', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      item: { id: 'item-x', type: 'unknown_type' },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
  });

  // ── Server request (permission) mapping ───────────────────────────────────

  it('maps item/commandExecution/requestApproval → permission_request', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(5, 'item/commandExecution/requestApproval', {
      itemId: 'item-1',
      command: 'rm -rf /tmp',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('permission_request');
    expect(events[0].data).toEqual({
      id: 'item-1',
      toolName: 'shell',
      toolInput: { command: 'rm -rf /tmp' },
      description: 'Run command: rm -rf /tmp',
    });
  });

  it('maps item/fileChange/requestApproval → permission_request', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(6, 'item/fileChange/requestApproval', {
      itemId: 'item-2',
      path: '/etc/hosts',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('permission_request');
    expect(events[0].data).toEqual({
      id: 'item-2',
      toolName: 'apply_patch',
      toolInput: { path: '/etc/hosts' },
      description: 'Modify file: /etc/hosts',
    });
  });

  it('ignores unknown server request methods', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(99, 'unknown/request', { data: 'test' });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
  });

  // ── Permission response flow ──────────────────────────────────────────────

  it('respondToPermission sends accept decision via JSON-RPC', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    // Trigger a permission request
    mockClient.onServerRequest(42, 'item/commandExecution/requestApproval', {
      itemId: 'perm-abc',
      command: 'npm install',
    });

    await adapter.respondToPermission('perm-abc', true);

    expect(mockClient.respond).toHaveBeenCalledWith(42, { decision: 'accept' });
  });

  it('respondToPermission sends decline decision', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(43, 'item/fileChange/requestApproval', {
      itemId: 'perm-def',
      path: '/etc/passwd',
    });

    await adapter.respondToPermission('perm-def', false);

    expect(mockClient.respond).toHaveBeenCalledWith(43, { decision: 'decline' });
  });

  it('respondToPermission throws for unknown request ID', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    await expect(
      adapter.respondToPermission('nonexistent', false),
    ).rejects.toThrow('No pending approval');
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  it('sendMessage sends turn/start on existing thread', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    // Wait for thread creation
    await flushMicrotasks();

    await adapter.sendMessage('continue with step 2');

    expect(mockClient.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'test-thread-1',
      input: [{ type: 'text', text: 'continue with step 2' }],
    });
  });

  it('sendMessage throws if adapter not started', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });

    await expect(adapter.sendMessage('hello')).rejects.toThrow('not started');
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  it('cancel kills the client process', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    await adapter.cancel();

    expect(mockClient.kill).toHaveBeenCalled();
  });

  it('cancel does nothing when not started', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });

    await expect(adapter.cancel()).resolves.toBeUndefined();
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  it('dispose kills client and finishes queue', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
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
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect(events[0].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('emits end event with reason error on non-zero exit', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onExit(1, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect((events[0].data as { reason: string }).reason).toBe('error');
    expect((events[0].data as { summary: string }).summary).toContain('code 1');
  });

  it('does not emit duplicate end on exit after turn/completed', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    // turn/completed sets turnEnded = true
    mockClient.onNotification('turn/completed', {
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    // Process exit should NOT add another end event
    mockClient.onExit(0, null);

    // Collect all events (queue is finished after turn/completed)
    const events: StructuredEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should have usage + end from turn/completed, nothing extra from onExit
    const endEvents = events.filter(e => e.type === 'end');
    expect(endEvents).toHaveLength(1);
  });

  // ── Tool verb resolution ──────────────────────────────────────────────────

  it('resolves tool verbs from config', async () => {
    const adapter = new CodexAppServerAdapter({
      binary: 'codex',
      toolVerbs: { shell: 'Running command', apply_patch: 'Editing file' },
    });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      item: { id: 'i1', type: 'file_change', details: { path: 'f.ts' } },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Editing file');
  });

  it('falls back to "Using tool" for unknown tools', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      item: { id: 'i1', type: 'mcp_tool_call', details: { tool: 'custom_tool', arguments: {} } },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Using tool');
  });

  // ── PascalCase type variants (Codex may use either) ───────────────────────

  it('handles PascalCase CommandExecution in item/started', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      item: { id: 'i1', type: 'CommandExecution', details: { command: 'ls' } },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect((events[0].data as { name: string }).name).toBe('shell');
  });

  it('handles PascalCase AgentMessage in item/completed', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', {
      item: { id: 'i1', type: 'AgentMessage', text: 'Hello!' },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('text_done');
    expect(events[0].data).toEqual({ text: 'Hello!' });
  });

  // ── Diagnostic logging tests ──────────────────────────────────────────────

  it('logs session start parameters', () => {
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    const adapter = new CodexAppServerAdapter({ binary: '/usr/bin/codex' });
    adapter.start({
      ...defaultSessionOpts,
      model: 'gpt-5.3-codex',
      systemPrompt: 'Be helpful',
    });

    expect(mockAppLog).toHaveBeenCalledWith(
      'core:structured',
      'info',
      'CodexAppServerAdapter starting session',
      expect.objectContaining({
        meta: expect.objectContaining({
          binary: '/usr/bin/codex',
          cwd: '/tmp/project',
          model: 'gpt-5.3-codex',
          hasMission: true,
          hasSystemPrompt: true,
        }),
      }),
    );
  });

  it('logs startup failure', async () => {
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    mockClient.start.mockRejectedValue(new Error('Connection refused'));

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('error');

    expect(mockAppLog).toHaveBeenCalledWith(
      'core:structured',
      'error',
      'CodexAppServerAdapter startup failed',
      expect.objectContaining({
        meta: expect.objectContaining({
          error: 'Connection refused',
        }),
      }),
    );
  });

  it('logs unmapped notification methods', async () => {
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('future/notification', { key: 'value' });
    mockClient.onExit(0, null);

    await collectEvents(stream, 1);

    expect(mockAppLog).toHaveBeenCalledWith(
      'core:structured:codex',
      'info',
      'Unmapped Codex notification: future/notification',
      expect.objectContaining({
        meta: expect.objectContaining({
          method: 'future/notification',
          paramsKeys: ['key'],
        }),
      }),
    );
  });

  it('passes onLog callback to CodexAppServerClient', () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    const opts = MockClient.mock.calls[0][0];
    expect(opts.onLog).toBeDefined();
  });

  // ── configWarning handling ──────────────────────────────────────────────

  it('handles configWarning notification gracefully without emitting events', async () => {
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('configWarning', {
      message: 'Unknown config key: foo',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    // Only the end event — configWarning produces no UI event
    expect(events[0].type).toBe('end');

    // But it should be logged at info level
    expect(mockAppLog).toHaveBeenCalledWith(
      'core:structured:codex',
      'info',
      'Codex config warning',
      expect.objectContaining({
        meta: expect.objectContaining({ message: 'Unknown config key: foo' }),
      }),
    );
  });
});
