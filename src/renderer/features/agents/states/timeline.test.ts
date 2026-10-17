import { describe, it, expect } from 'vitest';
import {
  TimelineBuilder, changedPaths, clock, describeFold, describeTool, foldSteps, toolCallBuckets,
  type ToolStep, type TranscriptEventLike,
} from './timeline';

const T0 = 1_700_000_000_000;

function assistant(ts: number, ...content: unknown[]): TranscriptEventLike {
  return { type: 'assistant', _ts: ts, message: { content } };
}
function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool_use', id, name, input };
}
function result(ts: number, id: string, isError = false): TranscriptEventLike {
  return { type: 'user', _ts: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } };
}

describe('TimelineBuilder', () => {
  it('keeps text, tool input and per-event times, and pairs results by tool_use_id', () => {
    const b = new TimelineBuilder();
    b.push([
      assistant(T0 + 3000, { type: 'text', text: "I'll look first." }),
      assistant(T0 + 5000, toolUse('t1', 'Read', { file_path: '/wt/src/a.ts' })),
      result(T0 + 6000, 't1'),
      assistant(T0 + 9000, toolUse('t2', 'Bash', { command: 'npm run typecheck' })),
    ]);
    expect(b.steps).toHaveLength(3);
    expect(b.steps[0]).toMatchObject({ kind: 'text', ts: T0 + 3000, text: "I'll look first." });
    expect(b.steps[1]).toMatchObject({ kind: 'tool', name: 'Read', input: { file_path: '/wt/src/a.ts' }, ts: T0 + 5000, endTs: T0 + 6000, toolUseId: 't1' });
    expect(b.steps[2]).toMatchObject({ kind: 'tool', name: 'Bash' });
    expect((b.steps[2] as ToolStep).endTs).toBeUndefined();
    expect(b.totals.toolCalls).toBe(2);

    // A later page completes the running step
    b.push([result(T0 + 12_000, 't2', true)]);
    expect(b.steps[2]).toMatchObject({ endTs: T0 + 12_000, isError: true });
  });

  it('ignores a repeated tool_use for the same id (Codex emits one on completion)', () => {
    const b = new TimelineBuilder();
    b.push([
      assistant(T0, toolUse('c1', 'apply_patch', { path: 'a.ts' })),
      assistant(T0 + 1000, toolUse('c1', 'apply_patch', { path: 'a.ts' })),
      result(T0 + 1000, 'c1'),
    ]);
    expect(b.steps).toHaveLength(1);
    expect(b.totals.toolCalls).toBe(1);
  });

  it('sums usage and reads the result event', () => {
    const b = new TimelineBuilder();
    b.push([
      { type: 'assistant', _ts: T0, message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 } } },
      { type: 'result', _ts: T0 + 1000, result: 'All done.', total_cost_usd: 0.42, duration_ms: 401_000 },
    ]);
    expect(b.totals).toMatchObject({ inputTokens: 1000, outputTokens: 50, costUsd: 0.42, durationMs: 401_000, summary: 'All done.' });
    expect(b.steps.at(-1)).toMatchObject({ kind: 'result', text: 'All done.' });
  });

  it('counts a Claude message\'s usage once even when repeated on each of its events', () => {
    const b = new TimelineBuilder();
    const usage = { input_tokens: 10, output_tokens: 5 };
    b.push([
      { type: 'assistant', _ts: T0, message: { id: 'm1', content: [{ type: 'text', text: 'a' }], usage } },
      { type: 'assistant', _ts: T0, message: { id: 'm1', content: [toolUse('t', 'Read', {})], usage } },
      { type: 'assistant', _ts: T0, message: { id: 'm2', content: [{ type: 'text', text: 'b' }], usage } },
      { type: 'result', _ts: T0, result: 'ok', usage: { input_tokens: 999, output_tokens: 999 } },
    ]);
    expect(b.totals).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it('adds Codex per-turn usage from result events', () => {
    const b = new TimelineBuilder();
    b.push([
      { type: 'result', _ts: T0, result: 'one', message: { usage: { input_tokens: 100, output_tokens: 10 } } },
      { type: 'result', _ts: T0, result: 'two', message: { usage: { input_tokens: 50, output_tokens: 5 } } },
    ]);
    expect(b.totals).toMatchObject({ inputTokens: 150, outputTokens: 15 });
  });

  it('falls back to the last assistant text when the result is empty', () => {
    const b = new TimelineBuilder();
    b.push([assistant(T0, { type: 'text', text: 'Fixed it.' }), { type: 'result', _ts: T0, result: '' }]);
    expect(b.totals.summary).toBe('Fixed it.');
  });

  it('stamps events without _ts with the time they were seen', () => {
    const b = new TimelineBuilder(() => 42);
    b.push([{ type: 'assistant', message: { content: [toolUse('x', 'Read', {})] } }]);
    expect(b.steps[0].ts).toBe(42);
  });

  it('handles the legacy streaming format', () => {
    const b = new TimelineBuilder();
    b.push([
      { type: 'content_block_start', _ts: T0, index: 0, content_block: { type: 'tool_use', name: 'Grep' } },
      { type: 'content_block_stop', _ts: T0 + 500, index: 0 },
      { type: 'content_block_delta', _ts: T0 + 600, delta: { type: 'text_delta', text: 'Found it' } },
      { type: 'message_stop', _ts: T0 + 700 },
    ]);
    expect(b.steps.map((s) => s.kind)).toEqual(['tool', 'text']);
    expect(b.steps[0]).toMatchObject({ name: 'Grep', endTs: T0 + 500 });
  });
});

function tool(name: string, input: Record<string, unknown> = {}, id = name + Math.random()): ToolStep {
  return { kind: 'tool', id, ts: T0, name, input, endTs: T0 + 1 };
}

describe('foldSteps', () => {
  it('folds two or more consecutive reads and searches into one row', () => {
    const rows = foldSteps([
      tool('Grep'), tool('Read'), tool('Read'),
      { kind: 'text', id: 't', ts: T0, text: 'x' },
      tool('Read'),
      tool('Edit'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['fold', 'text', 'tool', 'tool']);
    expect(rows[0].kind === 'fold' && rows[0].steps).toHaveLength(3);
  });

  it('keeps a failed read on its own row', () => {
    const rows = foldSteps([tool('Read'), { ...tool('Read'), isError: true }, tool('Read'), tool('Read')]);
    expect(rows.map((r) => r.kind)).toEqual(['tool', 'tool', 'fold']);
    expect(rows[1]).toMatchObject({ isError: true });
  });

  it('keeps the running or stopped-at read on its own row', () => {
    const rows = foldSteps([tool('Read'), tool('Grep'), { ...tool('Read'), endTs: undefined }]);
    expect(rows.map((r) => r.kind)).toEqual(['fold', 'tool']);
  });

  it('stderr lines inside a run of reads follow the fold instead of splitting it', () => {
    const note = { kind: 'text' as const, id: 'note:1:5', ts: T0, text: 'warning: slow disk' };
    const rows = foldSteps([tool('Read'), note, tool('Read'), tool('Grep')]);
    expect(rows.map((r) => r.kind)).toEqual(['fold', 'text']);
    expect(rows[0].kind === 'fold' && rows[0].steps).toHaveLength(3);
    expect(rows[1]).toBe(note);
  });

  it('an ordinary text step still ends the fold', () => {
    const rows = foldSteps([tool('Read'), tool('Read'), { kind: 'text', id: 'text:1', ts: T0, text: 'Now I know.' }, tool('Read'), tool('Read')]);
    expect(rows.map((r) => r.kind)).toEqual(['fold', 'text', 'fold']);
  });
});

describe('describeFold', () => {
  it('names reads, searches or both', () => {
    expect(describeFold([tool('Read'), tool('Read')])).toBe('Read 2 files');
    expect(describeFold([tool('Grep'), tool('Glob')])).toBe('Searched 2 patterns');
    expect(describeFold([tool('Read'), tool('Grep')])).toBe('Read 1 file, searched 1');
  });

  it('does not count a folder listing as a read', () => {
    expect(describeFold([tool('Read'), tool('LS')])).toBe('Read 1 file, listed 1 folder');
    expect(describeFold([tool('LS'), tool('LS')])).toBe('Listed 2 folders');
    expect(describeTool(tool('LS', { path: '/wt/src' }), '/wt')).toMatchObject({ verb: 'Listed', target: 'src' });
  });
});

describe('describeTool', () => {
  it('describes edits with the file and directory relative to the run', () => {
    expect(describeTool(tool('Edit', { file_path: '/wt/src/renderer/index.css' }), '/wt')).toMatchObject({
      verb: 'Edited', active: 'Editing', target: 'index.css', detail: 'src/renderer', changedPath: 'src/renderer/index.css',
    });
  });

  it('describes commands and searches in mono', () => {
    expect(describeTool(tool('Bash', { command: 'npm run typecheck\nmore' }))).toMatchObject({ verb: 'Ran', target: 'npm run typecheck', mono: true });
    expect(describeTool(tool('Grep', { pattern: '#[0-9a-f]{6}', path: '/wt/src' }), '/wt')).toMatchObject({ verb: 'Searched', target: '#[0-9a-f]{6}', detail: 'src', mono: true });
  });

  it('reads Codex shell and apply_patch inputs', () => {
    expect(describeTool(tool('shell', { command: 'ls' }))).toMatchObject({ verb: 'Ran', target: 'ls' });
    expect(describeTool(tool('apply_patch', { path: 'src/a.ts' }))).toMatchObject({ verb: 'Edited', changedPath: 'src/a.ts' });
    expect(describeTool(tool('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/b.ts\n@@' }))).toMatchObject({ changedPath: 'src/b.ts' });
    expect(describeTool(tool('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@' }))).toMatchObject({ changedPath: 'src/new.ts', target: 'new.ts' });
    expect(describeTool(tool('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n*** Add File: b.ts\n*** Move to: c.ts' }))).toMatchObject({ changedPath: 'a.ts' });
  });

  it('falls back to the tool name and its first string input', () => {
    expect(describeTool(tool('mcp__x__do', { what: 'thing' }))).toMatchObject({ verb: 'mcp__x__do', target: 'thing' });
  });
});

describe('changedPaths', () => {
  it('lists edited and written files once each', () => {
    expect(changedPaths([
      tool('Edit', { file_path: '/wt/a.ts' }), tool('Write', { file_path: '/wt/b.ts' }), tool('Edit', { file_path: '/wt/a.ts' }), tool('Read', { file_path: '/wt/c.ts' }),
    ], '/wt')).toEqual(['a.ts', 'b.ts']);
  });
});

describe('toolCallBuckets and clock', () => {
  it('counts tool calls per 20 seconds', () => {
    const steps = [0, 5_000, 21_000, 59_000].map((d) => ({ ...tool('Read'), ts: T0 + d }));
    expect(toolCallBuckets(steps, T0, T0 + 60_000)).toEqual([2, 1, 1]);
  });

  it('formats time from the run start', () => {
    expect(clock(T0 + 251_000, T0)).toBe('4:11');
    expect(clock(T0 - 5, T0)).toBe('0:00');
  });
});
