import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { StructuredEvent } from '../../../shared/structured-events';
import type { StructuredSessionOpts } from '../types';

// Mock child_process
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock shell environment
vi.mock('../../util/shell', () => ({
  getShellEnvironment: vi.fn().mockReturnValue({ PATH: '/usr/bin', HOME: '/home/test' }),
}));

import { StreamJsonAdapter } from './stream-json-adapter';

interface MockProcess extends EventEmitter {
  stdout: EventEmitter & { setEncoding?: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding?: ReturnType<typeof vi.fn> };
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function createMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter() as MockProcess['stdout'];
  proc.stdout.setEncoding = vi.fn();
  proc.stderr = new EventEmitter() as MockProcess['stderr'];
  proc.stderr.setEncoding = vi.fn();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

/** Feed a stream-json line to the mock process stdout */
function feedLine(proc: MockProcess, data: Record<string, unknown>): void {
  proc.stdout.emit('data', Buffer.from(JSON.stringify(data) + '\n'));
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

describe('StreamJsonAdapter', () => {
  let mockProc: MockProcess;
  const defaultSessionOpts: StructuredSessionOpts = {
    mission: 'Fix the bug',
    cwd: '/tmp/project',
  };

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  // ── Spawn & args ─────────────────────────────────────────────────────────

  it('spawns with correct binary and stream-json flags', () => {
    const adapter = new StreamJsonAdapter({
      binary: '/usr/bin/claude',
      toolVerbs: { Bash: 'Running command' },
    });

    adapter.start(defaultSessionOpts);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [binary, args, opts] = mockSpawn.mock.calls[0];
    expect(binary).toBe('/usr/bin/claude');
    expect(args).toContain('-p');
    expect(args).toContain('Fix the bug');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(opts.cwd).toBe('/tmp/project');
  });

  it('includes model flag when specified', () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start({ ...defaultSessionOpts, model: 'sonnet' });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
  });

  it('skips model flag for "default"', () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start({ ...defaultSessionOpts, model: 'default' });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--model');
  });

  it('includes allowedTools flags', () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start({ ...defaultSessionOpts, allowedTools: ['Read', 'Edit'] });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--allowedTools');
    // Each tool gets its own --allowedTools flag
    const atIndices = args.reduce((acc: number[], a: string, i: number) =>
      a === '--allowedTools' ? [...acc, i] : acc, []);
    expect(atIndices).toHaveLength(2);
    expect(args[atIndices[0] + 1]).toBe('Read');
    expect(args[atIndices[1] + 1]).toBe('Edit');
  });

  it('includes disallowedTools flags', () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start({ ...defaultSessionOpts, disallowedTools: ['Bash'] });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Bash');
  });

  it('wraps spawn via shell when commandPrefix is set', () => {
    const adapter = new StreamJsonAdapter({ binary: '/usr/bin/claude' });
    adapter.start({ ...defaultSessionOpts, commandPrefix: '. ./init.sh' });

    const [binary, args] = mockSpawn.mock.calls[0];
    expect(binary).toBe('sh');
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe('. ./init.sh && exec "$@"');
    expect(args[2]).toBe('_');
    expect(args[3]).toBe('/usr/bin/claude');
    expect(args).toContain('-p');
    expect(args).toContain('Fix the bug');
  });

  it('spawns directly when commandPrefix is undefined', () => {
    const adapter = new StreamJsonAdapter({ binary: '/usr/bin/claude' });
    adapter.start({ ...defaultSessionOpts, commandPrefix: undefined });

    const [binary] = mockSpawn.mock.calls[0];
    expect(binary).toBe('/usr/bin/claude');
  });

  it('includes system prompt flag', () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start({ ...defaultSessionOpts, systemPrompt: 'Be helpful' });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('Be helpful');
  });

  it('includes baseArgs before generated args', () => {
    const adapter = new StreamJsonAdapter({
      binary: 'claude',
      baseArgs: ['--no-session-persistence'],
    });
    adapter.start(defaultSessionOpts);

    const args = mockSpawn.mock.calls[0][1] as string[];
    const baseIdx = args.indexOf('--no-session-persistence');
    const printIdx = args.indexOf('-p');
    expect(baseIdx).toBeLessThan(printIdx);
  });

  it('closes stdin immediately after spawn', () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start(defaultSessionOpts);
    expect(mockProc.stdin.end).toHaveBeenCalled();
  });

  it('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT from env', () => {
    const adapter = new StreamJsonAdapter({
      binary: 'claude',
      env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'test', CUSTOM: 'val' },
    });
    adapter.start(defaultSessionOpts);

    const spawnOpts = mockSpawn.mock.calls[0][2];
    expect(spawnOpts.env).not.toHaveProperty('CLAUDECODE');
    expect(spawnOpts.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(spawnOpts.env).toHaveProperty('CUSTOM', 'val');
  });

  // ── content_block_start (tool_use) → tool_start ───────────────────────────

  it('maps content_block_start tool_use → tool_start', async () => {
    const adapter = new StreamJsonAdapter({
      binary: 'claude',
      toolVerbs: { Bash: 'Running command' },
    });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'Bash', id: 'tu_1' },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_start');
    expect(events[0].data).toEqual({
      id: 'tu_1',
      name: 'Bash',
      displayVerb: 'Running command',
      input: {},
    });
  });

  // ── content_block_delta (text) → text_delta ───────────────────────────────

  it('maps content_block_delta text_delta → text_delta', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    });
    feedLine(mockProc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    });
    feedLine(mockProc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 4);
    // First two actual events are the text deltas
    expect(events[0].type).toBe('text_delta');
    expect(events[0].data).toEqual({ text: 'Hello' });
    expect(events[1].type).toBe('text_delta');
    expect(events[1].data).toEqual({ text: ' world' });
  });

  // ── content_block_stop (text) → text_done ─────────────────────────────────

  it('emits text_done with accumulated text on content_block_stop', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text' },
    });
    feedLine(mockProc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello world' },
    });
    feedLine(mockProc, {
      type: 'content_block_stop',
      index: 0,
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 3);
    expect(events[0].type).toBe('text_delta');
    expect(events[1].type).toBe('text_done');
    expect(events[1].data).toEqual({ text: 'Hello world' });
  });

  // ── content_block_delta (thinking) → thinking ─────────────────────────────

  it('maps thinking_delta → thinking', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking' },
    });
    feedLine(mockProc, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me consider...' },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('thinking');
    expect(events[0].data).toEqual({ text: 'Let me consider...', isPartial: true });
  });

  // ── assistant message → usage ─────────────────────────────────────────────

  it('extracts usage from assistant message', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('usage');
    expect(events[0].data).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('extracts cache tokens from assistant usage', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          cache_read_input_tokens: 150,
          cache_creation_input_tokens: 20,
        },
      },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect(events[0].data).toMatchObject({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 150,
      cacheWriteTokens: 20,
    });
  });

  // ── user message → tool_end ───────────────────────────────────────────────

  it('maps user tool_result → tool_end', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: 'file.txt\nindex.js',
        }],
      },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect(events[0].data).toEqual({
      id: 'tu_1',
      name: '',
      result: 'file.txt\nindex.js',
      durationMs: 0,
      status: 'success',
    });
  });

  it('maps tool_result with is_error → tool_end error status', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: 'Permission denied',
          is_error: true,
        }],
      },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('tool_end');
    expect((events[0].data as { status: string }).status).toBe('error');
  });

  it('handles tool_result with array content', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_3',
          content: [{ text: 'line 1' }, { text: 'line 2' }],
        }],
      },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { result: string }).result).toBe('line 1\nline 2');
  });

  // ── result event → usage + end ────────────────────────────────────────────

  it('maps result event with cost to usage', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'result',
      result: 'Task completed.',
      cost_usd: 0.015,
      duration_ms: 5000,
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('usage');
    expect(events[0].data).toMatchObject({
      costUsd: 0.015,
    });
    expect(events[1].type).toBe('end');
  });

  // ── Process exit ──────────────────────────────────────────────────────────

  it('emits end event with reason complete on code 0', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect(events[0].data).toEqual({ reason: 'complete', summary: undefined });
  });

  it('emits end event with reason error on non-zero exit', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    mockProc.emit('close', 1);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect((events[0].data as { reason: string }).reason).toBe('error');
    expect((events[0].data as { summary: string }).summary).toContain('code 1');
  });

  it('emits error event for stderr output', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    mockProc.stderr.emit('data', Buffer.from('Something went wrong\n'));
    mockProc.emit('close', 1);

    const events = await collectEvents(stream, 2);
    expect(events[0].type).toBe('error');
    expect(events[0].data).toEqual({
      code: 'stderr',
      message: 'Something went wrong',
    });
  });

  it('handles process error event', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    mockProc.emit('error', new Error('spawn ENOENT'));

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
    expect((events[0].data as { reason: string }).reason).toBe('error');
  });

  // ── sendMessage / respondToPermission ─────────────────────────────────────

  it('sendMessage throws (not supported)', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start(defaultSessionOpts);
    await expect(adapter.sendMessage('hello')).rejects.toThrow('not supported');
  });

  it('respondToPermission throws (not supported)', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start(defaultSessionOpts);
    await expect(adapter.respondToPermission('id', true)).rejects.toThrow('not supported');
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  it('cancel kills the process with SIGTERM', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    adapter.start(defaultSessionOpts);

    await adapter.cancel();

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cancel is safe when adapter not started', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    await expect(adapter.cancel()).resolves.toBeUndefined();
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  it('dispose kills process and finishes queue', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    adapter.dispose();

    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

    // Stream should terminate
    const events: StructuredEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });

  // ── Tool verb resolution ──────────────────────────────────────────────────

  it('resolves tool verbs from config', async () => {
    const adapter = new StreamJsonAdapter({
      binary: 'claude',
      toolVerbs: { Edit: 'Editing file', Bash: 'Running command' },
    });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'Edit', id: 'tu_1' },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Editing file');
  });

  it('falls back to "Using tool" for unknown tools', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'CustomTool', id: 'tu_1' },
    });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 2);
    expect((events[0].data as { displayVerb: string }).displayVerb).toBe('Using tool');
  });

  // ── Full flow integration ─────────────────────────────────────────────────

  it('handles a complete agent turn: thinking → text → tool → result', async () => {
    const adapter = new StreamJsonAdapter({
      binary: 'claude',
      toolVerbs: { Bash: 'Running command' },
    });
    const stream = adapter.start(defaultSessionOpts);

    // Thinking block
    feedLine(mockProc, {
      type: 'content_block_start', index: 0,
      content_block: { type: 'thinking' },
    });
    feedLine(mockProc, {
      type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'Planning...' },
    });
    feedLine(mockProc, { type: 'content_block_stop', index: 0 });

    // Text block
    feedLine(mockProc, {
      type: 'content_block_start', index: 1,
      content_block: { type: 'text' },
    });
    feedLine(mockProc, {
      type: 'content_block_delta', index: 1,
      delta: { type: 'text_delta', text: 'I will run a command.' },
    });
    feedLine(mockProc, { type: 'content_block_stop', index: 1 });

    // Tool use block
    feedLine(mockProc, {
      type: 'content_block_start', index: 2,
      content_block: { type: 'tool_use', name: 'Bash', id: 'tu_1' },
    });
    feedLine(mockProc, { type: 'content_block_stop', index: 2 });

    // Assistant message (verbose)
    feedLine(mockProc, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    });

    // Tool result
    feedLine(mockProc, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: 'success',
        }],
      },
    });

    // Result
    feedLine(mockProc, {
      type: 'result',
      result: 'Done.',
      cost_usd: 0.01,
      duration_ms: 3000,
    });

    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 20);

    const types = events.map((e) => e.type);
    expect(types).toContain('thinking');
    expect(types).toContain('text_delta');
    expect(types).toContain('text_done');
    expect(types).toContain('tool_start');
    expect(types).toContain('usage');
    expect(types).toContain('tool_end');
    expect(types).toContain('end');
  });

  // ── Unknown events ────────────────────────────────────────────────────────

  it('ignores unknown event types', async () => {
    const adapter = new StreamJsonAdapter({ binary: 'claude' });
    const stream = adapter.start(defaultSessionOpts);

    feedLine(mockProc, { type: 'message_start', message: {} });
    feedLine(mockProc, { type: 'message_delta', usage: {} });
    mockProc.emit('close', 0);

    const events = await collectEvents(stream, 1);
    expect(events[0].type).toBe('end');
  });
});
