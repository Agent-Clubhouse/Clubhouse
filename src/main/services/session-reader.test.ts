import { describe, it, expect } from 'vitest';
import { normalizeSessionEvents, buildSessionSummary, paginateEvents } from './session-reader';
import type { StreamJsonEvent } from './jsonl-parser';

// ── normalizeSessionEvents ─────────────────────────────────────────────

describe('normalizeSessionEvents', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeSessionEvents([])).toEqual([]);
  });

  it('converts user-type events to user_message', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'user',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user_message');
    expect(events[0].text).toBe('Hello');
  });

  it('converts user-type events with string message', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'user',
      message: 'Hi there',
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user_message');
    expect(events[0].text).toBe('Hi there');
  });

  it('converts assistant-type events with text blocks to assistant_message', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Sure thing!' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_message');
    expect(events[0].text).toBe('Sure thing!');
    expect(events[0].usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('converts assistant-type events with tool_use blocks', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/foo/bar.ts', content: 'test' },
        }],
      },
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect(events[0].toolName).toBe('Write');
    expect(events[0].filePath).toBe('/foo/bar.ts');
  });

  it('tracks filePath for Edit tool', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' },
        }],
      },
    }];
    const events = normalizeSessionEvents(raw);
    expect(events[0].filePath).toBe('/src/main.ts');
  });

  it('does not set filePath for non-file tools', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'ls' },
        }],
      },
    }];
    const events = normalizeSessionEvents(raw);
    expect(events[0].filePath).toBeUndefined();
  });

  it('converts result-type events', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'result',
      result: 'All done!',
      total_cost_usd: 0.15,
      duration_ms: 5000,
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
    expect(events[0].text).toBe('All done!');
    expect(events[0].costUsd).toBe(0.15);
    expect(events[0].durationMs).toBe(5000);
  });

  it('converts system-type events', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'system',
      message: 'Session started',
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
    expect(events[0].text).toBe('Session started');
  });

  it('handles multiple content blocks in a single assistant event', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me write a file.' },
          { type: 'tool_use', name: 'Write', input: { file_path: '/a.ts', content: '' } },
        ],
      },
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant_message');
    expect(events[1].type).toBe('tool_use');
  });

  it('generates unique IDs for each event', () => {
    const raw: StreamJsonEvent[] = [
      { type: 'user', message: 'msg1' },
      { type: 'user', message: 'msg2' },
    ];
    const events = normalizeSessionEvents(raw);
    expect(events[0].id).not.toBe(events[1].id);
  });

  it('uses explicit timestamp when present', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'user',
      message: 'test',
      timestamp: 1700000000000,
    }];
    const events = normalizeSessionEvents(raw);
    expect(events[0].timestamp).toBe(1700000000000);
  });

  it('handles legacy content_block_start events', () => {
    const raw: StreamJsonEvent[] = [{
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'Bash' },
    }];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect(events[0].toolName).toBe('Bash');
  });

  // ── Role-based conversation format (Bug 1 fix) ────────────────────

  it('converts role:user events to user_message', () => {
    const raw: StreamJsonEvent[] = [{
      type: '', // no type field — role-based format
      role: 'user',
      content: [{ type: 'text', text: 'Hello from role format' }],
    } as any];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user_message');
    expect(events[0].text).toBe('Hello from role format');
  });

  it('converts role:human events to user_message', () => {
    const raw: StreamJsonEvent[] = [{
      type: '', // fallthrough to role check
      role: 'human',
      content: 'Simple text message',
    } as any];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user_message');
    expect(events[0].text).toBe('Simple text message');
  });

  it('converts role:assistant events with text blocks', () => {
    const raw: StreamJsonEvent[] = [{
      type: '',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me help you.' },
      ],
      usage: { input_tokens: 200, output_tokens: 80 },
      model: 'claude-sonnet-4-5-20250514',
    } as any];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_message');
    expect(events[0].text).toBe('Let me help you.');
    expect(events[0].usage).toEqual({ inputTokens: 200, outputTokens: 80 });
    expect(events[0].model).toBe('claude-sonnet-4-5-20250514');
  });

  it('converts role:assistant events with tool_use blocks', () => {
    const raw: StreamJsonEvent[] = [{
      type: '',
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
      ],
    } as any];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect(events[0].toolName).toBe('Edit');
    expect(events[0].filePath).toBe('/src/app.ts');
  });

  it('converts role:assistant string content', () => {
    const raw: StreamJsonEvent[] = [{
      type: '',
      role: 'assistant',
      content: 'Simple assistant response',
    } as any];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant_message');
    expect(events[0].text).toBe('Simple assistant response');
  });

  it('handles mixed verbose and role-based formats in same stream', () => {
    const raw: StreamJsonEvent[] = [
      { type: 'user', message: 'Verbose user message' },
      { type: '', role: 'assistant', content: [{ type: 'text', text: 'Role-based response' }] } as any,
      { type: 'result', result: 'Done', total_cost_usd: 0.01, duration_ms: 1000 },
    ];
    const events = normalizeSessionEvents(raw);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('user_message');
    expect(events[1].type).toBe('assistant_message');
    expect(events[2].type).toBe('result');
  });
});

// ── buildSessionSummary ────────────────────────────────────────────────

describe('buildSessionSummary', () => {
  it('returns all-zero summary for empty events', () => {
    const summary = buildSessionSummary([]);
    expect(summary.totalToolCalls).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.totalDurationMs).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.filesModified).toEqual([]);
    expect(summary.toolsUsed).toEqual([]);
    expect(summary.summary).toBeNull();
    expect(summary.model).toBeNull();
    expect(summary.eventCount).toBe(0);
    expect(summary.startedAt).toBeNull();
    expect(summary.lastActiveAt).toBeNull();
  });

  it('aggregates tool calls', () => {
    const events = normalizeSessionEvents([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/a.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    ]);
    const summary = buildSessionSummary(events);
    expect(summary.totalToolCalls).toBe(3);
    expect(summary.toolsUsed).toContain('Bash');
    expect(summary.toolsUsed).toContain('Write');
    expect(summary.filesModified).toEqual(['/a.ts']);
  });

  it('extracts summary from result event', () => {
    const events = normalizeSessionEvents([
      { type: 'result', result: 'Completed successfully', total_cost_usd: 0.05, duration_ms: 3000 },
    ]);
    const summary = buildSessionSummary(events);
    expect(summary.summary).toBe('Completed successfully');
    expect(summary.totalCostUsd).toBe(0.05);
    expect(summary.totalDurationMs).toBe(3000);
  });

  it('falls back to last assistant text when no result summary', () => {
    const events = normalizeSessionEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Here is my answer' }] } },
    ]);
    const summary = buildSessionSummary(events);
    expect(summary.summary).toBe('Here is my answer');
  });

  it('truncates long fallback summary to 500 chars', () => {
    const longText = 'a'.repeat(600);
    const events = normalizeSessionEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
    ]);
    const summary = buildSessionSummary(events);
    expect(summary.summary!.length).toBe(500);
    expect(summary.summary!.endsWith('...')).toBe(true);
  });

  it('aggregates token usage', () => {
    const events = normalizeSessionEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 100, output_tokens: 50 } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 200, output_tokens: 100 } } },
    ]);
    const summary = buildSessionSummary(events);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
  });

  it('sets orchestrator when provided', () => {
    const summary = buildSessionSummary([], 'claude-code');
    expect(summary.orchestrator).toBe('claude-code');
  });

  it('derives timestamps from event array', () => {
    const events = normalizeSessionEvents([
      { type: 'user', message: 'start', timestamp: 1700000000000 },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'end' }] }, timestamp: 1700000005000 },
    ]);
    const summary = buildSessionSummary(events);
    expect(summary.startedAt).not.toBeNull();
    expect(summary.lastActiveAt).not.toBeNull();
  });

  it('derives duration from event timestamps when not in result', () => {
    const events = normalizeSessionEvents([
      { type: 'user', message: 'start', timestamp: 1700000000000 },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'end' }] }, timestamp: 1700000005000 },
    ]);
    const summary = buildSessionSummary(events);
    expect(summary.totalDurationMs).toBe(5000);
  });
});

// ── paginateEvents ─────────────────────────────────────────────────────

describe('paginateEvents', () => {
  const events = normalizeSessionEvents([
    { type: 'user', message: 'one', timestamp: 1 },
    { type: 'user', message: 'two', timestamp: 2 },
    { type: 'user', message: 'three', timestamp: 3 },
    { type: 'user', message: 'four', timestamp: 4 },
    { type: 'user', message: 'five', timestamp: 5 },
  ]);

  it('returns correct page for offset=0, limit=2', () => {
    const page = paginateEvents(events, 0, 2);
    expect(page.events).toHaveLength(2);
    expect(page.totalEvents).toBe(5);
  });

  it('returns correct page for offset=2, limit=2', () => {
    const page = paginateEvents(events, 2, 2);
    expect(page.events).toHaveLength(2);
    expect(page.totalEvents).toBe(5);
  });

  it('returns remaining events when limit exceeds available', () => {
    const page = paginateEvents(events, 3, 10);
    expect(page.events).toHaveLength(2);
    expect(page.totalEvents).toBe(5);
  });

  it('returns empty page when offset exceeds total', () => {
    const page = paginateEvents(events, 100, 10);
    expect(page.events).toHaveLength(0);
    expect(page.totalEvents).toBe(5);
  });

  it('returns all events when limit matches total', () => {
    const page = paginateEvents(events, 0, 5);
    expect(page.events).toHaveLength(5);
  });
});

// ── Token usage: each message once ─────────────────────────────────────

describe('session usage', () => {
  const assistant = (id: string | undefined, content: unknown[], usage?: Record<string, unknown>, model?: string): StreamJsonEvent => ({
    type: 'assistant',
    message: { ...(id && { id }), content, ...(usage && { usage }), ...(model && { model }) },
  } as unknown as StreamJsonEvent);
  const text = (t: string) => ({ type: 'text', text: t });
  const tool = (name = 'Read') => ({ type: 'tool_use', name, id: `tu-${name}`, input: {} });

  it('counts a message with several text blocks once, not once per block', () => {
    const events = normalizeSessionEvents([assistant('m1', [text('one'), text('two'), text('three')], { input_tokens: 100, output_tokens: 50 })]);
    expect(events.filter((e) => e.type === 'assistant_message')).toHaveLength(3);
    expect(events.filter((e) => e.usage)).toHaveLength(1);
    const summary = buildSessionSummary(events);
    expect(summary.totalInputTokens).toBe(100);
    expect(summary.totalOutputTokens).toBe(50);
    expect(summary.tokenUsage).toBe('complete');
  });

  it('keeps the usage of a tool-only message', () => {
    const events = normalizeSessionEvents([assistant('m1', [tool('Write')], { input_tokens: 40, output_tokens: 8 })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_use', usage: { inputTokens: 40, outputTokens: 8 }, messageId: 'm1' });
    expect(buildSessionSummary(events)).toMatchObject({ totalInputTokens: 40, totalOutputTokens: 8, tokenUsage: 'complete' });
  });

  it('keeps the usage of a thinking-only message as a usage event, without inventing reply text', () => {
    const events = normalizeSessionEvents([assistant('m1', [{ type: 'thinking', thinking: 'hmm' }], { input_tokens: 10, output_tokens: 20 })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } });
    expect(events[0].text).toBeUndefined();
    expect(buildSessionSummary(events)).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 20, summary: null });
  });

  it('records one message repeated across records once, where records of one message share an id', () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 };
    const events = normalizeSessionEvents([
      assistant('m1', [text('first block')], usage),
      assistant('m1', [tool('Edit')], usage),
      assistant('m1', [text('last block')], usage),
    ]);
    expect(events.filter((e) => e.usage)).toHaveLength(1);
    const summary = buildSessionSummary(events);
    expect(summary).toMatchObject({ totalInputTokens: 100, totalOutputTokens: 50, totalCacheReadTokens: 900, tokenUsage: 'complete' });
  });

  it('a repeated record that gains usage fills in the message without adding to it', () => {
    const events = normalizeSessionEvents([
      assistant('m1', [text('a')], { input_tokens: 100, output_tokens: 1 }),
      assistant('m1', [text('b')], { input_tokens: 100, output_tokens: 60 }),
    ]);
    expect(events.filter((e) => e.usage)).toHaveLength(1);
    expect(events.find((e) => e.usage)!.usage).toEqual({ inputTokens: 100, outputTokens: 60 });
    expect(buildSessionSummary(events)).toMatchObject({ totalOutputTokens: 60, tokenUsage: 'complete' });
  });

  it('a later record missing fields does not erase what an earlier one reported', () => {
    const events = normalizeSessionEvents([
      assistant('m1', [text('a')], { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 7 }),
      assistant('m1', [text('b')], { output_tokens: 20 }),
    ]);
    expect(events.find((e) => e.usage)!.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 7 });
  });

  it('a record that gets a message its first record had no usage for takes it, and is no longer missing', () => {
    const events = normalizeSessionEvents([
      assistant('m1', [text('a')]),
      assistant('m1', [tool()], { input_tokens: 5, output_tokens: 6 }),
    ]);
    expect(events[0]).toMatchObject({ usage: { inputTokens: 5, outputTokens: 6 } });
    expect(events[0].usageMissing).toBeUndefined();
    expect(buildSessionSummary(events).tokenUsage).toBe('complete');
  });

  it('never sums changed values of one message: it keeps the highest per field and flags the conflict', () => {
    const events = normalizeSessionEvents([
      assistant('m1', [text('a')], { input_tokens: 100, output_tokens: 50 }),
      assistant('m1', [text('b')], { input_tokens: 90, output_tokens: 70 }),
    ]);
    const carrier = events.find((e) => e.usage)!;
    expect(carrier.usage).toEqual({ inputTokens: 100, outputTokens: 70, conflict: true });
    const summary = buildSessionSummary(events);
    // Not 190 / 120, and not claimed as a complete measurement.
    expect(summary).toMatchObject({ totalInputTokens: 100, totalOutputTokens: 70, tokenUsage: 'partial', tokenUsageConflicts: 1 });
  });

  it('the same message id in two sessions is never deduplicated together', () => {
    const one = normalizeSessionEvents([assistant('m1', [text('a')], { input_tokens: 10, output_tokens: 1 })]);
    const two = normalizeSessionEvents([assistant('m1', [text('a')], { input_tokens: 10, output_tokens: 1 })]);
    expect(buildSessionSummary(one).totalInputTokens + buildSessionSummary(two).totalInputTokens).toBe(20);
    // Within a session, ids are what repeat; a message with no id counts per record.
    const noId = normalizeSessionEvents([assistant(undefined, [text('a')], { input_tokens: 10, output_tokens: 1 }), assistant(undefined, [text('b')], { input_tokens: 10, output_tokens: 1 })]);
    expect(buildSessionSummary(noId).totalInputTokens).toBe(20);
  });

  it('a field the transcript left out is not zero: totals skip it and the summary is partial', () => {
    const events = normalizeSessionEvents([assistant('m1', [text('a')], { output_tokens: 9 })]);
    expect(events[0].usage).toEqual({ outputTokens: 9 });
    expect(events[0].usage).not.toHaveProperty('inputTokens');
    expect(buildSessionSummary(events)).toMatchObject({ totalOutputTokens: 9, tokenUsage: 'partial' });
    expect(buildSessionSummary(events)).not.toHaveProperty('totalCacheReadTokens');
  });

  it('a session with one fully reported message and one with none is partial, not complete', () => {
    const events = normalizeSessionEvents([
      assistant('m1', [text('a')], { input_tokens: 10, output_tokens: 2 }),
      assistant('m2', [text('b'), text('c')]),
    ]);
    expect(events.filter((e) => e.usageMissing)).toHaveLength(1);
    expect(buildSessionSummary(events)).toMatchObject({ totalInputTokens: 10, tokenUsage: 'partial' });
  });

  it('counts a message with several text blocks and no usage as one gap, not one per block', () => {
    const events = normalizeSessionEvents([
      assistant('m1', [text('a')], { input_tokens: 1, output_tokens: 1 }),
      assistant('m2', [text('b'), text('c'), text('d')]),
    ]);
    expect(events.filter((e) => e.usageMissing)).toHaveLength(1);
  });

  it('a tool-only and a thinking-only message with no usage are gaps too', () => {
    const events = normalizeSessionEvents([
      assistant('m1', [text('a')], { input_tokens: 1, output_tokens: 1 }),
      assistant('m2', [tool()]),
      assistant('m3', [{ type: 'thinking', thinking: 'x' }]),
    ]);
    expect(events.filter((e) => e.usageMissing).map((e) => e.type)).toEqual(['tool_use', 'usage']);
    expect(buildSessionSummary(events).tokenUsage).toBe('partial');
  });

  it('a session with no usage at all says none', () => {
    const events = normalizeSessionEvents([assistant('m1', [text('a')]), assistant('m2', [tool()])]);
    const summary = buildSessionSummary(events);
    expect(summary).toMatchObject({ tokenUsage: 'none', totalInputTokens: 0, totalOutputTokens: 0 });
  });

  it('reads the role-based format the same way', () => {
    const events = normalizeSessionEvents([
      { role: 'assistant', id: 'r1', content: [text('a'), text('b')], usage: { input_tokens: 30, output_tokens: 4 }, model: 'claude-sonnet-5-5' },
    ] as unknown as StreamJsonEvent[]);
    expect(events.filter((e) => e.usage)).toHaveLength(1);
    expect(buildSessionSummary(events)).toMatchObject({ totalInputTokens: 30, totalOutputTokens: 4, model: 'claude-sonnet-5-5', tokenUsage: 'complete' });
  });

  it('keeps the model from a message whose only event is a tool call', () => {
    const events = normalizeSessionEvents([assistant('m1', [tool()], { input_tokens: 1, output_tokens: 1 }, 'claude-opus-5-5')]);
    expect(buildSessionSummary(events).model).toBe('claude-opus-5-5');
  });
});
