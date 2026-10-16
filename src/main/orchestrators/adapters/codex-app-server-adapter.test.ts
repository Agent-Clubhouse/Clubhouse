import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
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
  winQuoteArg: (arg: string) => '"' + arg.replace(/%/g, '%%').replace(/"/g, '""') + '"',
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
  respondWithError: ReturnType<typeof vi.fn>;
  alive: boolean;
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

async function collectAll(iterable: AsyncIterable<StructuredEvent>): Promise<StructuredEvent[]> {
  const events: StructuredEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

// ── Authentic app-server v2 fixtures (Codex 0.153.4 generate-ts) ──────────

const THREAD = 'test-thread-1';
const TURN = 'test-turn-1';

function itemNotification(item: Record<string, unknown>) {
  return { item, threadId: THREAD, turnId: TURN, startedAtMs: 1760000000000 };
}

function commandItem(overrides: Record<string, unknown> = {}) {
  return {
    type: 'commandExecution',
    id: 'call_cmd_1',
    pluginId: null,
    scriptPath: null,
    command: 'npm test',
    cwd: '/tmp/project',
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...overrides,
  };
}

function fileChangeItem(overrides: Record<string, unknown> = {}) {
  return {
    type: 'fileChange',
    id: 'call_patch_1',
    changes: [
      { path: 'src/index.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old line\n+new line\n' },
      { path: 'src/new.ts', kind: { type: 'add' }, diff: '+content\n' },
    ],
    status: 'inProgress',
    ...overrides,
  };
}

function mcpItem(overrides: Record<string, unknown> = {}) {
  return {
    type: 'mcpToolCall',
    id: 'call_mcp_1',
    server: 'db',
    tool: 'database_query',
    status: 'inProgress',
    arguments: { sql: 'SELECT 1' },
    appContext: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: null,
    durationMs: null,
    ...overrides,
  };
}

function breakdown(overrides: Record<string, number>) {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides,
  };
}

function turnCompleted(status: string, error: Record<string, unknown> | null = null) {
  return {
    threadId: THREAD,
    turn: {
      id: TURN,
      items: [],
      itemsView: 'notLoaded',
      status,
      error,
      startedAt: 1760000000,
      completedAt: 1760000060,
      durationMs: 60000,
    },
  };
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
        if (method === 'turn/start') {
          return Promise.resolve({ turn: { id: 'test-turn-1', items: [], status: 'in_progress' } });
        }
        return Promise.resolve({});
      }),
      respond: vi.fn(),
      respondWithError: vi.fn(),
      alive: true,
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

  it('wraps binary with shell when commandPrefix is set (POSIX)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const adapter = new CodexAppServerAdapter({ binary: '/usr/bin/codex' });
    try {
      adapter.start({ ...defaultSessionOpts, commandPrefix: 'source ~/.env' });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }

    const opts = MockClient.mock.calls[0][0];
    expect(opts.binary).toBe('sh');
    expect(opts.args[0]).toBe('-c');
    expect(opts.args[1]).toContain('source ~/.env');
    // Binary is passed as a separate arg after '_' placeholder for exec "$@"
    expect(opts.args).toContain('/usr/bin/codex');
  });

  it('launches a Windows .cmd shim through cmd.exe with verbatim args', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const binary = path.join(os.tmpdir(), 'npm', 'codex.cmd');
    const adapter = new CodexAppServerAdapter({ binary });
    try {
      adapter.start(defaultSessionOpts);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }

    const opts = MockClient.mock.calls[0][0];
    expect(opts.binary).toBe('cmd.exe');
    expect(opts.args).toEqual(['/d', '/s', '/c', `""${binary}" "app-server" "--listen" "stdio://""`]);
    expect(opts.windowsVerbatimArguments).toBe(true);
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

  // ── Thread resume tests ──────────────────────────────────────────────────

  it('uses thread/resume instead of thread/start when sessionId is provided', async () => {
    mockClient.request.mockImplementation((method: string) => {
      if (method === 'thread/resume') {
        return Promise.resolve({ thread: { id: 'resumed-thread-1' } });
      }
      return Promise.resolve({});
    });

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({ ...defaultSessionOpts, sessionId: 'existing-thread-42' });

    await flushMicrotasks();

    expect(mockClient.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'existing-thread-42',
      cwd: '/tmp/project',
    });
    expect(mockClient.request).not.toHaveBeenCalledWith('thread/start', expect.anything());
  });

  it('uses sessionId as fallback threadId when resume returns no id', async () => {
    mockClient.request.mockImplementation((method: string) => {
      if (method === 'thread/resume') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({ ...defaultSessionOpts, sessionId: 'fallback-thread-id' });

    await flushMicrotasks();

    // Should use the provided sessionId for turn/start
    expect(mockClient.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'fallback-thread-id',
      input: [{ type: 'text', text: 'Fix the bug' }],
    });
  });

  it('starts turn after thread/resume when mission is provided', async () => {
    mockClient.request.mockImplementation((method: string) => {
      if (method === 'thread/resume') {
        return Promise.resolve({ thread: { id: 'resumed-thread-1' } });
      }
      return Promise.resolve({});
    });

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({
      ...defaultSessionOpts,
      sessionId: 'existing-thread',
      mission: 'Continue fixing',
      systemPrompt: 'Be concise',
    });

    await flushMicrotasks();

    expect(mockClient.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'resumed-thread-1',
      input: [{ type: 'text', text: 'Be concise\n\nContinue fixing' }],
    });
  });

  it('skips turn/start after resume when no mission or systemPrompt', async () => {
    mockClient.request.mockImplementation((method: string) => {
      if (method === 'thread/resume') {
        return Promise.resolve({ thread: { id: 'resumed-thread-1' } });
      }
      return Promise.resolve({});
    });

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({
      cwd: '/tmp/project',
      mission: '',
      sessionId: 'existing-thread',
    });

    await flushMicrotasks();

    expect(mockClient.request).toHaveBeenCalledWith('thread/resume', expect.anything());
    expect(mockClient.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
  });

  it('logs resume attempt with thread ID', async () => {
    const mockAppLog = vi.mocked(appLog);
    mockAppLog.mockClear();

    mockClient.request.mockImplementation((method: string) => {
      if (method === 'thread/resume') {
        return Promise.resolve({ thread: { id: 'resumed-thread-1' } });
      }
      return Promise.resolve({});
    });

    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start({ ...defaultSessionOpts, sessionId: 'thread-to-resume' });

    await flushMicrotasks();

    expect(mockAppLog).toHaveBeenCalledWith(
      'core:structured:codex',
      'info',
      'Resuming thread',
      expect.objectContaining({
        meta: expect.objectContaining({ threadId: 'thread-to-resume' }),
      }),
    );
  });

  // ── Notification mapping tests ────────────────────────────────────────────
  // Fixtures mirror the app-server v2 schema of the CI-pinned Codex CLI
  // (0.153.4, `codex app-server generate-ts`).

  it('maps item/agentMessage/delta (string delta) → text_delta', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/agentMessage/delta', {
      threadId: THREAD, turnId: TURN, itemId: 'msg_1', delta: 'Hello world',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('text_delta');
    expect(events[0].data).toEqual({ text: 'Hello world' });
  });

  it('maps item/reasoning/summaryTextDelta (string delta) → thinking', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/reasoning/summaryTextDelta', {
      threadId: THREAD, turnId: TURN, itemId: 'rs_1', delta: 'Let me think...', summaryIndex: 0,
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('thinking');
    expect(events[0].data).toEqual({ text: 'Let me think...', isPartial: true });
  });

  it('maps item/started (commandExecution) → tool_start', async () => {
    const adapter = new CodexAppServerAdapter({
      binary: 'codex',
      toolVerbs: { shell: 'Running command' },
    });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', itemNotification(commandItem({ status: 'inProgress' })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].data).toEqual({
      id: 'call_cmd_1',
      name: 'shell',
      displayVerb: 'Running command',
      input: { command: 'npm test' },
    });
  });

  it('maps item/started (fileChange) → tool_start', async () => {
    const adapter = new CodexAppServerAdapter({
      binary: 'codex',
      toolVerbs: { apply_patch: 'Editing file' },
    });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', itemNotification(fileChangeItem({ status: 'inProgress' })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].data).toEqual({
      id: 'call_patch_1',
      name: 'apply_patch',
      displayVerb: 'Editing file',
      input: { path: 'src/index.ts, src/new.ts' },
    });
  });

  it('maps item/started (mcpToolCall) → tool_start', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', itemNotification(mcpItem({ status: 'inProgress' })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect((events[0].data as { name: string }).name).toBe('database_query');
    expect((events[0].data as { input: Record<string, unknown> }).input).toEqual({ sql: 'SELECT 1' });
  });

  it('maps item/completed (agentMessage) → text_done', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', itemNotification({
      type: 'agentMessage', id: 'msg_1', text: 'Done! Here is the result.',
      phase: null, memoryCitation: null, delivery: null, questions: null,
    }));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('text_done');
    expect(events[0].data).toEqual({ text: 'Done! Here is the result.' });
  });

  it('maps item/completed (commandExecution, completed) → tool_end success', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', itemNotification(commandItem({
      status: 'completed', aggregatedOutput: 'All tests passed', exitCode: 0, durationMs: 1234,
    })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect(events[0].data).toEqual({
      id: 'call_cmd_1',
      name: 'shell',
      result: 'All tests passed',
      durationMs: 1234,
      status: 'success',
    });
  });

  it.each([
    ['failed', 1],
    ['declined', null],
  ])('maps item/completed (commandExecution, %s) → tool_end error', async (status, exitCode) => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', itemNotification(commandItem({
      status, aggregatedOutput: 'Permission denied', exitCode,
    })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect((events[0].data as { status: string }).status).toBe('error');
  });

  it('maps item/completed (fileChange) → file_diff per change + tool_end', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', itemNotification(fileChangeItem({ status: 'completed' })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 3);
    expect(events[0]).toMatchObject({
      type: 'file_diff',
      data: { path: 'src/index.ts', changeType: 'modify', diff: '@@ -1 +1 @@\n-old line\n+new line\n' },
    });
    expect(events[1]).toMatchObject({
      type: 'file_diff',
      data: { path: 'src/new.ts', changeType: 'create', diff: '+content\n' },
    });
    expect(events[2].type).toBe('tool_end');
    expect(events[2].data).toEqual({
      id: 'call_patch_1',
      name: 'apply_patch',
      result: 'src/index.ts, src/new.ts',
      durationMs: 0,
      status: 'success',
    });
  });

  it('maps a declined fileChange → tool_end error with no diffs', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', itemNotification(fileChangeItem({ status: 'declined' })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect((events[0].data as { status: string }).status).toBe('error');
  });

  it('maps item/completed (mcpToolCall) → tool_end with text result', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', itemNotification(mcpItem({
      status: 'completed',
      result: { content: [{ type: 'text', text: '1 row' }], structuredContent: null, _meta: null },
      durationMs: 40,
    })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].data).toEqual({
      id: 'call_mcp_1',
      name: 'database_query',
      result: '1 row',
      durationMs: 40,
      status: 'success',
    });
  });

  it('maps item/completed (mcpToolCall, failed) → tool_end error', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/completed', itemNotification(mcpItem({
      status: 'failed', error: { message: 'connection refused' },
    })));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].data).toMatchObject({ result: 'connection refused', status: 'error' });
  });

  it('maps turn/plan/updated → plan_update', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/plan/updated', {
      threadId: THREAD,
      turnId: TURN,
      explanation: null,
      plan: [
        { step: 'Read files', status: 'completed' },
        { step: 'Edit code', status: 'inProgress' },
        { step: 'Run tests', status: 'pending' },
      ],
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('plan_update');
    expect(events[0].data).toEqual({
      steps: [
        { description: 'Read files', status: 'completed' },
        { description: 'Edit code', status: 'in_progress' },
        { description: 'Run tests', status: 'pending' },
      ],
    });
  });

  it('maps item/commandExecution/outputDelta (string delta) → command_output', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/commandExecution/outputDelta', {
      threadId: THREAD, turnId: TURN, itemId: 'call_cmd_1', delta: 'Running tests...\n',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('command_output');
    expect(events[0].data).toEqual({
      id: 'call_cmd_1',
      command: '',
      status: 'running',
      output: 'Running tests...\n',
      exitCode: undefined,
    });
  });

  it('maps thread/tokenUsage/updated → usage from the latest increment', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('thread/tokenUsage/updated', {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: breakdown({ inputTokens: 900, outputTokens: 400, cachedInputTokens: 600 }),
        last: breakdown({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 80, cacheWriteInputTokens: 5 }),
        modelContextWindow: 272000,
      },
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('usage');
    // The renderer sums usage events, so the increment — not the running total
    expect(events[0].data).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheWriteTokens: 5,
      costUsd: undefined,
    });
  });

  it('maps turn/completed (completed) → end, finishes queue', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/completed', turnCompleted('completed'));

    const events = await collectAll(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('end');
    expect(events[0].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('maps turn/completed (failed) → error from turn.error + end', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/completed', turnCompleted('failed', {
      message: 'Context window exceeded',
      codexErrorInfo: 'contextWindowExceeded',
      additionalDetails: null,
      misalignment: null,
    }));

    const events = await collectAll(stream);
    expect(events.map(e => e.type)).toEqual(['error', 'end']);
    expect(events[0].data).toEqual({
      code: 'contextWindowExceeded',
      message: 'Context window exceeded',
    });
    expect(events[1].data).toEqual({ reason: 'error', summary: 'Context window exceeded' });
  });

  it('uses the variant key of an object-shaped codexErrorInfo', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/completed', turnCompleted('failed', {
      message: 'stream disconnected',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      additionalDetails: null,
      misalignment: null,
    }));

    const events = await collectAll(stream);
    expect((events[0].data as { code: string }).code).toBe('responseStreamDisconnected');
  });

  it('maps turn/completed (interrupted) → end cancelled', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/completed', turnCompleted('interrupted'));

    const events = await collectAll(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ reason: 'cancelled', summary: 'Turn interrupted' });
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

  it('ignores item/started for item types it does not render', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', itemNotification({
      type: 'reasoning', id: 'rs_1', summary: [], content: [],
    }));
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
  });

  // ── Server request (permission) mapping ───────────────────────────────────

  it('maps item/commandExecution/requestApproval → permission_request', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(5, 'item/commandExecution/requestApproval', {
      kind: 'command',
      threadId: THREAD,
      turnId: TURN,
      itemId: 'call_cmd_1',
      startedAtMs: 1760000000000,
      environmentId: null,
      command: 'rm -rf /tmp/build',
      cwd: '/tmp/project',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('permission_request');
    expect(events[0].data).toEqual({
      id: 'call_cmd_1',
      toolName: 'shell',
      toolInput: { command: 'rm -rf /tmp/build' },
      description: 'Run command: rm -rf /tmp/build',
    });
  });

  it('keys command approvals by approvalId when several share an itemId', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    const base = { kind: 'command', threadId: THREAD, turnId: TURN, itemId: 'call_cmd_1', startedAtMs: 0, environmentId: null };
    mockClient.onServerRequest(5, 'item/commandExecution/requestApproval', { ...base, approvalId: 'appr-a', command: 'ls' });
    mockClient.onServerRequest(6, 'item/commandExecution/requestApproval', { ...base, approvalId: 'appr-b', command: 'pwd' });

    await adapter.respondToPermission('appr-a', true);
    await adapter.respondToPermission('appr-b', false);

    expect(mockClient.respond).toHaveBeenCalledWith(5, { decision: 'accept' });
    expect(mockClient.respond).toHaveBeenCalledWith(6, { decision: 'decline' });
  });

  it('maps item/fileChange/requestApproval → permission_request with the item paths', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    // The approval carries no paths — they come from the item announced first
    mockClient.onNotification('item/started', itemNotification(fileChangeItem({ status: 'inProgress' })));
    mockClient.onServerRequest(6, 'item/fileChange/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'call_patch_1',
      startedAtMs: 1760000000000,
      reason: null,
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[1].type).toBe('permission_request');
    expect(events[1].data).toEqual({
      id: 'call_patch_1',
      toolName: 'apply_patch',
      toolInput: { path: 'src/index.ts, src/new.ts' },
      description: 'Modify file: src/index.ts, src/new.ts',
    });
  });

  it('describes a fileChange approval by its reason when the item is unknown', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(6, 'item/fileChange/requestApproval', {
      threadId: THREAD, turnId: TURN, itemId: 'call_x', startedAtMs: 0,
      reason: 'Needs write access outside the workspace',
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { description: string }).description)
      .toBe('Needs write access outside the workspace');
  });

  it('answers an unhandled server request instead of leaving the turn hanging', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    // Codex blocks the turn until a server request is resolved, so silence
    // stalls the session with nothing surfaced to the user.
    mockClient.onServerRequest(99, 'item/tool/requestUserInput', { itemId: 'i1' });

    expect(mockClient.respondWithError).toHaveBeenCalledWith(
      99,
      -32601,
      expect.stringContaining('item/tool/requestUserInput'),
    );
  });

  it('surfaces an unhandled server request as an error event', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(99, 'mcpServer/elicitation/request', {});
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('error');
    expect((events[0].data as { code: string }).code).toBe('unhandled_server_request');
  });

  it('does not error-respond to requests it can decide', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);

    mockClient.onServerRequest(7, 'item/commandExecution/requestApproval', {
      itemId: 'cmd-1', command: 'ls',
    });

    expect(mockClient.respondWithError).not.toHaveBeenCalled();
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
      threadId: THREAD,
      turnId: TURN,
      itemId: 'perm-def',
      startedAtMs: 0,
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

  it('cancel interrupts the turn and keeps the thread alive', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);
    await flushMicrotasks();

    await adapter.cancel();

    // Killing the process would forfeit the thread; turn/interrupt leaves it
    // resumable, which is what pressing stop means.
    // Both ids are required — the server rejects an interrupt without turnId
    expect(mockClient.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'test-thread-1',
      turnId: 'test-turn-1',
    });
    expect(mockClient.kill).not.toHaveBeenCalled();
  });

  it('takes the turn id from the turn/started notification', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);
    await flushMicrotasks();

    mockClient.onNotification('turn/started', {
      threadId: 'test-thread-1',
      turn: { id: 'turn-from-notification', items: [], status: 'in_progress' },
    });
    await adapter.cancel();

    expect(mockClient.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'test-thread-1',
      turnId: 'turn-from-notification',
    });
  });

  it('kills rather than interrupting once the turn has completed', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);
    await flushMicrotasks();

    mockClient.onNotification('turn/completed', turnCompleted('completed'));
    await adapter.cancel();

    // No turn in flight, so there is nothing to interrupt
    expect(mockClient.request).not.toHaveBeenCalledWith('turn/interrupt', expect.anything());
    expect(mockClient.kill).toHaveBeenCalled();
  });

  it('cancel falls back to killing the process when the interrupt fails', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);
    await flushMicrotasks();

    mockClient.request.mockRejectedValueOnce(new Error('socket closed'));
    await adapter.cancel();

    expect(mockClient.kill).toHaveBeenCalled();
  });

  it('cancel kills the client process when no turn was established', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    adapter.start(defaultSessionOpts);
    // no flushMicrotasks — thread/start and turn/start have not resolved yet

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
    mockClient.onNotification('turn/completed', turnCompleted('completed'));

    // Process exit should NOT add another end event
    mockClient.onExit(0, null);

    // Collect all events (queue is finished after turn/completed)
    const events: StructuredEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // A single end from turn/completed, nothing extra from onExit
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
      ...itemNotification(fileChangeItem()),
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Editing file');
  });

  it('falls back to "Using tool" for unknown tools', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('item/started', {
      ...itemNotification(mcpItem({ tool: 'custom_tool', arguments: {} })),
    });
    mockClient.onExit(0, null);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Using tool');
  });

  // ── End-to-end turn with authentic messages ───────────────────────────────

  it('maps a full authentic turn in order', async () => {
    const adapter = new CodexAppServerAdapter({ binary: 'codex' });
    const stream = adapter.start(defaultSessionOpts);

    mockClient.onNotification('turn/started', { threadId: THREAD, turn: { ...turnCompleted('inProgress').turn, error: null } });
    mockClient.onNotification('item/started', itemNotification(commandItem()));
    mockClient.onNotification('item/commandExecution/outputDelta', { threadId: THREAD, turnId: TURN, itemId: 'call_cmd_1', delta: 'ok\n' });
    mockClient.onNotification('item/completed', itemNotification(commandItem({ status: 'completed', aggregatedOutput: 'ok\n', exitCode: 0 })));
    mockClient.onNotification('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'msg_1', delta: 'Tests ' });
    mockClient.onNotification('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'msg_1', delta: 'pass.' });
    mockClient.onNotification('item/completed', itemNotification({
      type: 'agentMessage', id: 'msg_1', text: 'Tests pass.', phase: null, memoryCitation: null, delivery: null, questions: null,
    }));
    mockClient.onNotification('thread/tokenUsage/updated', {
      threadId: THREAD, turnId: TURN,
      tokenUsage: { total: breakdown({ inputTokens: 10 }), last: breakdown({ inputTokens: 10, outputTokens: 3 }), modelContextWindow: null },
    });
    mockClient.onNotification('turn/completed', turnCompleted('completed'));

    const events = await collectAll(stream);
    expect(events.map(e => e.type)).toEqual([
      'tool_start', 'command_output', 'tool_end', 'text_delta', 'text_delta', 'text_done', 'usage', 'end',
    ]);
    expect(events.map(e => e.type === 'text_delta' ? (e.data as { text: string }).text : null).filter(Boolean))
      .toEqual(['Tests ', 'pass.']);
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
      summary: 'Unknown config key: foo',
      details: null,
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
