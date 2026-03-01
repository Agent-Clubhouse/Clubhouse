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
