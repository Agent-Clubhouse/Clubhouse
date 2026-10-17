import { describe, it, expect } from 'vitest';
import { extractModifiedFiles, parseApplyPatchPaths, summarizeHeadlessTranscript } from './headless-transcript';
import { createCodexHeadlessNormalizer } from '../main/orchestrators/codex-headless-events';
import type { StreamJsonEvent } from '../main/services/jsonl-parser';

function toolUse(name: string, input: Record<string, unknown>, id?: string, messageId?: string, usage?: Record<string, number>) {
  return {
    type: 'assistant',
    message: {
      ...(messageId ? { id: messageId } : {}),
      role: 'assistant',
      content: [{ type: 'tool_use', ...(id ? { id } : {}), name, input }],
      ...(usage ? { usage } : {}),
    },
  };
}

function text(t: string, messageId?: string, usage?: Record<string, number>) {
  return {
    type: 'assistant',
    message: { ...(messageId ? { id: messageId } : {}), role: 'assistant', content: [{ type: 'text', text: t }], ...(usage ? { usage } : {}) },
  };
}

const CODEX_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const x = 1;',
  '*** Update File: src/old.ts',
  '*** Move to: src/renamed.ts',
  '@@',
  '-a',
  '+b',
  '*** Delete File: src/gone.ts',
  '*** End Patch',
].join('\n');

describe('parseApplyPatchPaths', () => {
  it('reads add, update, delete and move headers in order', () => {
    expect(parseApplyPatchPaths(CODEX_PATCH)).toEqual([
      'src/new.ts', 'src/old.ts', 'src/renamed.ts', 'src/gone.ts',
    ]);
  });

  it('handles CRLF line endings and ignores body lines', () => {
    expect(parseApplyPatchPaths('*** Begin Patch\r\n*** Update File: a.txt\r\n+*** Add File: not-a-header\r\n*** End Patch')).toEqual(['a.txt']);
  });

  it('returns [] for text with no headers', () => {
    expect(parseApplyPatchPaths('hello')).toEqual([]);
  });
});

describe('extractModifiedFiles', () => {
  it('collects Write, Edit, MultiEdit and NotebookEdit paths', () => {
    const events = [
      toolUse('Write', { file_path: '/repo/a.ts', content: 'x' }),
      toolUse('Edit', { file_path: '/repo/b.ts', old_string: 'a', new_string: 'b' }),
      toolUse('MultiEdit', { file_path: '/repo/c.ts', edits: [] }),
      toolUse('NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: '' }),
    ];
    expect(extractModifiedFiles(events)).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts', '/repo/n.ipynb']);
  });

  it('de-duplicates in first-seen order', () => {
    const events = [
      toolUse('Edit', { file_path: 'b.ts' }),
      toolUse('Write', { file_path: 'a.ts' }),
      toolUse('Edit', { file_path: 'b.ts' }),
      toolUse('apply_patch', { patch: '*** Update File: a.ts\n*** Add File: c.ts' }),
    ];
    expect(extractModifiedFiles(events)).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });

  it('ignores read-only tools, tool results and missing inputs', () => {
    const events = [
      toolUse('Read', { file_path: 'r.ts' }),
      toolUse('Grep', { pattern: 'x', path: 'src' }),
      toolUse('Write', {}),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ];
    expect(extractModifiedFiles(events)).toEqual([]);
  });

  it('parses apply_patch text under patch, input or command keys', () => {
    expect(extractModifiedFiles([toolUse('apply_patch', { input: CODEX_PATCH })])).toEqual([
      'src/new.ts', 'src/old.ts', 'src/renamed.ts', 'src/gone.ts',
    ]);
    expect(extractModifiedFiles([toolUse('apply_patch', { command: ['apply_patch', '*** Add File: z.md'] })])).toEqual(['z.md']);
  });

  it('reads apply_patch path, paths and changes lists', () => {
    expect(extractModifiedFiles([
      toolUse('apply_patch', { path: 'one.ts' }),
      toolUse('apply_patch', { paths: ['two.ts', 'one.ts'] }),
      toolUse('apply_patch', { changes: [{ path: 'three.ts', kind: 'add' }, 'four.ts'] }),
    ])).toEqual(['one.ts', 'two.ts', 'three.ts', 'four.ts']);
  });

  it('reads apply_patch heredocs run through the Codex shell tool', () => {
    const command = `apply_patch <<'EOF'\n${CODEX_PATCH}\nEOF`;
    expect(extractModifiedFiles([toolUse('shell', { command })])).toEqual([
      'src/new.ts', 'src/old.ts', 'src/renamed.ts', 'src/gone.ts',
    ]);
    // A plain shell command is not a file change.
    expect(extractModifiedFiles([toolUse('shell', { command: 'echo "*** Add File: x"' })])).toEqual([]);
  });

  it('ignores legacy streaming events and junk', () => {
    expect(extractModifiedFiles([
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } },
      null, 42, 'str', [], { type: 'assistant' }, { type: 'assistant', message: { content: 'text' } },
    ])).toEqual([]);
  });

  it('reads files from a normalized Codex transcript (file_change items)', () => {
    const normalize = createCodexHeadlessNormalizer();
    const raw = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.started', item: { id: 'i1', type: 'file_change', changes: [{ path: '/w/a.ts', kind: 'update' }, { path: '/w/b.ts', kind: 'add' }] } },
      { type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: '/w/a.ts', kind: 'update' }, { path: '/w/b.ts', kind: 'add' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', path: 'legacy.ts' } },
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'a' } },
    ] as unknown as StreamJsonEvent[];
    const events = raw.flatMap(normalize);
    expect(extractModifiedFiles(events)).toEqual(['/w/a.ts', '/w/b.ts', 'legacy.ts']);
  });
});

describe('summarizeHeadlessTranscript', () => {
  it('returns empty defaults for an empty transcript', () => {
    expect(summarizeHeadlessTranscript([])).toEqual({
      summary: null,
      filesModified: [],
      toolsUsed: [],
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('reads summary, cost and duration from the result event', () => {
    const s = summarizeHeadlessTranscript([
      text('working'),
      { type: 'result', result: 'All done', total_cost_usd: 0.42, cost_usd: 0.1, duration_ms: 1234 },
    ]);
    expect(s.summary).toBe('All done');
    expect(s.costUsd).toBe(0.42);
    expect(s.durationMs).toBe(1234);
  });

  it('falls back to cost_usd when total_cost_usd is absent', () => {
    expect(summarizeHeadlessTranscript([{ type: 'result', result: 'x', cost_usd: 0.05 }]).costUsd).toBe(0.05);
  });

  it('omits cost and duration when no result reports them', () => {
    const s = summarizeHeadlessTranscript([text('hi')]);
    expect(s).not.toHaveProperty('costUsd');
    expect(s).not.toHaveProperty('durationMs');
  });

  it('falls back to the last assistant text, truncated to 500 chars', () => {
    expect(summarizeHeadlessTranscript([text('first'), text('  second  '), { type: 'result', result: '' }]).summary).toBe('second');
    const long = 'y'.repeat(800);
    const s = summarizeHeadlessTranscript([text(long)]);
    expect(s.summary).toHaveLength(500);
    expect(s.summary!.endsWith('...')).toBe(true);
  });

  it('accumulates legacy text deltas for the fallback summary', () => {
    const s = summarizeHeadlessTranscript([
      { type: 'message_start' },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
    ]);
    expect(s.summary).toBe('Hello world');
  });

  it('lists tools in first-seen order, including legacy content_block_start', () => {
    const s = summarizeHeadlessTranscript([
      toolUse('Read', { file_path: 'a' }, 't1'),
      toolUse('Edit', { file_path: 'a' }, 't2'),
      toolUse('Read', { file_path: 'b' }, 't3'),
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
    ]);
    expect(s.toolsUsed).toEqual(['Read', 'Edit', 'Bash']);
    expect(s.toolCalls).toBe(3);
    expect(s.filesModified).toEqual(['a']);
  });

  it('counts a tool_use repeated under the same id once', () => {
    const s = summarizeHeadlessTranscript([
      toolUse('apply_patch', { path: 'a' }, 'i1'),
      toolUse('apply_patch', { path: 'a' }, 'i1'),
      toolUse('shell', { command: 'ls' }),
      toolUse('shell', { command: 'ls' }),
    ]);
    expect(s.toolCalls).toBe(3);
  });

  it('sums Claude usage once per message id, including cache tokens', () => {
    const usage1 = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 };
    const usage1Final = { ...usage1, output_tokens: 7 };
    const usage2 = { input_tokens: 2, output_tokens: 4 };
    const s = summarizeHeadlessTranscript([
      text('a', 'msg_1', usage1),
      toolUse('Edit', { file_path: 'x' }, 't1', 'msg_1', usage1Final),
      text('b', 'msg_2', usage2),
      // Claude Code's result total must not be added on top.
      { type: 'result', result: 'ok', usage: { input_tokens: 999, output_tokens: 999 } },
    ]);
    expect(s.inputTokens).toBe(115 + 2);
    expect(s.outputTokens).toBe(7 + 4);
  });

  it('sums usage on assistant messages that carry no id', () => {
    const s = summarizeHeadlessTranscript([
      text('a', undefined, { input_tokens: 1, output_tokens: 2 }),
      text('b', undefined, { input_tokens: 3, output_tokens: 4 }),
    ]);
    expect(s.inputTokens).toBe(4);
    expect(s.outputTokens).toBe(6);
  });

  it('uses the result usage total when no per-message usage exists', () => {
    const s = summarizeHeadlessTranscript([
      text('a'),
      { type: 'result', result: 'ok', usage: { input_tokens: 50, cache_read_input_tokens: 10, output_tokens: 20 } },
    ]);
    expect(s.inputTokens).toBe(60);
    expect(s.outputTokens).toBe(20);
  });

  it('sums Codex per-turn usage from normalized result events', () => {
    const normalize = createCodexHeadlessNormalizer();
    const raw = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Patched it' } },
      { type: 'item.completed', item: { id: 'p1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } },
    ] as unknown as StreamJsonEvent[];
    const s = summarizeHeadlessTranscript(raw.flatMap(normalize));
    expect(s.summary).toBe('Patched it');
    expect(s.inputTokens).toBe(105);
    expect(s.outputTokens).toBe(11);
    expect(s.toolCalls).toBe(1);
    expect(s.toolsUsed).toEqual(['apply_patch']);
    expect(s.filesModified).toEqual(['a.ts']);
    expect(s.costUsd).toBeUndefined();
  });

  it('tolerates _ts stamps and malformed events', () => {
    const s = summarizeHeadlessTranscript([
      null, 'x', 1,
      { ...toolUse('Write', { file_path: 'w.ts' }, 't1'), _ts: 1000 },
      { type: 'result', result: 'ok', duration_ms: 'nope', _ts: 2000 },
    ]);
    expect(s.filesModified).toEqual(['w.ts']);
    expect(s.summary).toBe('ok');
    expect(s.durationMs).toBe(0);
  });
});
