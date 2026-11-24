/** scripts/codex-usage-summary.mjs: counts each response once, keeps cached and missing figures apart, reads no text. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { agentLabel, summarizeRollouts } from './codex-usage-summary.mjs';

const line = (o: unknown) => JSON.stringify(o);
const meta = (id: string, cwd: string, source: unknown = 'vscode') => line({ type: 'session_meta', payload: { id, cwd, source } });
const ctx = (turn: string, model: string, effort: string) => line({ type: 'turn_context', payload: { turn_id: turn, model, effort } });
const rec = (ts: string, turn: string, response: string | undefined, usage: Record<string, number>) =>
  line({ timestamp: ts, type: 'token_usage_record', payload: { turn_id: turn, ...(response && { response_id: response }), usage, thread_token_usage: { total_tokens: 999999 } } });
const count = (ts: string, total: number) => line({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } } });

describe('codex usage summary', () => {
  it('names the agent from its Clubhouse folder', () => {
    expect(agentLabel('/u/src/Proj/.clubhouse/agents/ux-root')).toBe('ux-root');
    expect(agentLabel('/u/.clubhouse/dispatcher')).toBe('Dispatcher');
    expect(agentLabel('/u/.clubhouse/dispatcher-chat')).toBe('Dispatcher');
    expect(agentLabel('/u/src/dispatcher-tools')).toBe('dispatcher-tools');
    expect(agentLabel(undefined)).toBe('(unknown)');
  });

  it('sums per-response records by record day, once per response id, with cached input apart', () => {
    const main = [
      meta('a', '/p/.clubhouse/agents/orch'),
      ctx('t1', 'gpt-x', 'high'),
      line({ type: 'response_item', payload: { type: 'message', content: [{ text: 'secret prompt' }] } }),
      rec('2026-11-17T23:59:00Z', 't1', 'r1', { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 105 }),
      count('2026-11-17T23:59:00Z', 105),
      // Resumed next day in the same file: counted on its own day.
      rec('2026-11-18T01:00:00Z', 't1', 'r2', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, total_tokens: 11 }),
      rec('2026-11-18T01:00:00Z', 't1', 'r2', { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, total_tokens: 11 }),
    ];
    // A forked subagent file repeats its parent's meta after its own.
    const fork = [meta('b', '/p/.clubhouse/agents/orch', { subagent: {} }), meta('a', '/p/.clubhouse/agents/orch'), rec('2026-11-18T02:00:00Z', 'x', 'r3', { input_tokens: 7, output_tokens: 1 })];
    const out = summarizeRollouts([{ name: 'm', lines: main }, { name: 'f', lines: fork }]);
    expect(out.duplicates).toBe(1);
    expect(out.rows).toEqual([
      expect.objectContaining({ day: '2026-11-17', agent: 'orch', model: 'gpt-x', effort: 'high', responses: 1, input_tokens: 100, cached_input_tokens: 80, uncachedInput: 20, reasoning_output_tokens: 2 }),
      expect.objectContaining({ day: '2026-11-18', agent: 'orch', responses: 1, input_tokens: 10 }),
      expect.objectContaining({ day: '2026-11-18', agent: 'orch (subagent)', model: '(unknown)', responses: 1, input_tokens: 7, missing: expect.objectContaining({ cached_input_tokens: 1, total_tokens: 1 }) }),
    ]);
    expect(JSON.stringify(out)).not.toContain('secret prompt');
  });

  it('filters by day and reports the token_count cross-check', () => {
    const lines = [meta('a', '/x/agents/none'), rec('2026-11-16T00:00:00Z', 't', 'r1', { total_tokens: 50 }), count('2026-11-16T00:00:00Z', 50), rec('2026-11-17T00:00:00Z', 't', 'r2', { total_tokens: 30 }), count('2026-11-17T00:00:00Z', 70)];
    const out = summarizeRollouts([{ name: 'a', lines }], { since: '2026-11-17' });
    expect(out.rows.map((r: { total_tokens: number }) => r.total_tokens)).toEqual([30]);
    expect(out.crossCheck).toEqual({ records: 30, tokenCountDiffs: 20, resets: 0 });
  });
});
