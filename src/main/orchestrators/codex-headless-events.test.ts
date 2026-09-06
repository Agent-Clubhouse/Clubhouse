import { describe, it, expect } from 'vitest';
import { createCodexHeadlessNormalizer } from './codex-headless-events';
import type { StreamJsonEvent } from '../services/jsonl-parser';

/**
 * The fixtures below are captured verbatim from `codex exec --json` on
 * codex-cli 0.153.4, so they drift with the CLI rather than with our guesses.
 */
describe('createCodexHeadlessNormalizer', () => {
  const run = (raws: StreamJsonEvent[]): StreamJsonEvent[] => {
    const normalize = createCodexHeadlessNormalizer();
    return raws.flatMap((r) => normalize(r));
  };

  it('translates a complete real session into stream-json', () => {
    const events = run([
      { type: 'thread.started', thread_id: '01a07466-007a-7bb1-9623-49f0bedcedc2' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'pong' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 15599, cached_input_tokens: 11136, output_tokens: 5 },
      },
    ] as unknown as StreamJsonEvent[]);

    expect(events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
  });

  it('surfaces the thread id so the session can be resumed', () => {
    const [init] = run([
      { type: 'thread.started', thread_id: '01a07466-007a-7bb1-9623-49f0bedcedc2' },
    ] as unknown as StreamJsonEvent[]);
    expect(init.session_id).toBe('01a07466-007a-7bb1-9623-49f0bedcedc2');
  });

  it('maps an agent message to an assistant text block', () => {
    const [event] = run([
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'All done' } },
    ] as unknown as StreamJsonEvent[]);
    expect(event.type).toBe('assistant');
    expect(event.message?.content).toEqual([{ type: 'text', text: 'All done' }]);
  });

  it('carries the final assistant text onto the terminal result event', () => {
    const events = run([
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'the answer' } },
      { type: 'turn.completed', usage: {} },
    ] as unknown as StreamJsonEvent[]);

    // Codex reports the text long before the turn ends, but the shared
    // pipeline expects `result` to carry it.
    const result = events.at(-1)!;
    expect(result.type).toBe('result');
    expect(result.result).toBe('the answer');
    expect(result.is_error).toBe(false);
  });

  it('reports token usage from turn.completed', () => {
    const [result] = run([
      { type: 'turn.completed', usage: { input_tokens: 15599, output_tokens: 5 } },
    ] as unknown as StreamJsonEvent[]);
    expect(result.message?.usage).toEqual({ input_tokens: 15599, output_tokens: 5 });
  });

  it('pairs a shell command with its output', () => {
    const events = run([
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls -la' } },
      {
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', aggregated_output: 'file.txt', exit_code: 0 },
      },
    ] as unknown as StreamJsonEvent[]);

    const [use, result] = events;
    expect(use.message?.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'ls -la' } },
    ]);
    expect(result.message?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'file.txt', is_error: false },
    ]);
  });

  it('marks a non-zero exit as a failed tool result', () => {
    const events = run([
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'false' } },
      {
        type: 'item.completed',
        item: { id: 'c1', type: 'command_execution', aggregated_output: 'boom', exit_code: 1 },
      },
    ] as unknown as StreamJsonEvent[]);

    const content = events.at(-1)!.message?.content as Array<{ is_error: boolean }>;
    expect(content[0].is_error).toBe(true);
  });

  it('synthesises the tool_use for items Codex only reports on completion', () => {
    // A bare tool_result would show a result for a call that never appeared.
    const events = run([
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', path: 'src/a.ts' } },
    ] as unknown as StreamJsonEvent[]);

    expect(events).toHaveLength(2);
    expect(events[0].message?.content).toEqual([
      { type: 'tool_use', id: 'f1', name: 'apply_patch', input: { path: 'src/a.ts' } },
    ]);
    expect(events[1].type).toBe('user');
  });

  it('maps an MCP tool call to its own tool name', () => {
    const events = run([
      {
        type: 'item.completed',
        item: { id: 'm1', type: 'mcp_tool_call', details: { tool: 'read_bulletin', result: 'ok' } },
      },
    ] as unknown as StreamJsonEvent[]);

    const content = events[0].message?.content as Array<{ name: string }>;
    expect(content[0].name).toBe('read_bulletin');
  });

  it('reports a failed turn as an error result', () => {
    const [result] = run([
      { type: 'turn.failed', error: { message: 'model overloaded' } },
    ] as unknown as StreamJsonEvent[]);
    expect(result.type).toBe('result');
    expect(result.is_error).toBe(true);
    expect(result.result).toBe('model overloaded');
  });

  it('drops events the pipeline has no use for rather than padding the transcript', () => {
    expect(run([
      { type: 'turn.started' },
      { type: 'item.updated', item: { id: 'x', type: 'reasoning' } },
      { type: 'some.future.event' },
    ] as unknown as StreamJsonEvent[])).toEqual([]);
  });

  it('keeps per-session state separate between normalizers', () => {
    const a = createCodexHeadlessNormalizer();
    const b = createCodexHeadlessNormalizer();
    a({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'session A' } } as unknown as StreamJsonEvent);
    const [resultB] = b({ type: 'turn.completed', usage: {} } as unknown as StreamJsonEvent);
    expect(resultB.result).toBe('');
  });
});
