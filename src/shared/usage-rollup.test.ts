import { describe, expect, it } from 'vitest';
import { rollupUsage } from './usage-rollup.mjs';

const turn = (meta: Record<string, unknown>, ts = '2026-11-24T10:00:00.000Z') => ({ t: 'diag', ts, ns: 'core:usage', level: 'info', msg: 'Usage turn', meta });
const base = { agentId: 'a1', sessionId: 's1', role: 'helper', parentAgentId: 'orch', provider: 'codex', driver: 'codex_app_server', model: 'gpt-x', effort: 'high', kind: 'turn', source: 'cumulative_delta' };

describe('rollupUsage', () => {
  it('adds turn lines, keeps cached input apart and never adds session totals', () => {
    const out = rollupUsage([
      turn({ ...base, turnId: 't1', input: 1000, cachedInput: 900, output: 10, reasoning: 4 }),
      turn({ ...base, turnId: 't2', input: 500, cachedInput: 100, output: 5 }),
      { t: 'diag', ts: '2026-11-24T11:00:00.000Z', ns: 'core:usage', msg: 'Usage session total', meta: { ...base, kind: 'final', input: 99_999 } },
      { t: 'diag', ts: '2026-11-24T11:00:00.000Z', ns: 'core:chat', msg: 'Usage turn', meta: { input: 5 } },
      { t: 'signal', name: 'x' },
    ]);
    expect(out.rows).toEqual([expect.objectContaining({ day: '2026-11-24', provider: 'codex', role: 'helper', agentId: 'a1', turns: 2, input: 1500, cachedInput: 1000, uncachedInput: 500, output: 15, reasoning: 4 })]);
    expect(out.rows[0].missing).toEqual({ cacheWrite: 2, reasoning: 1 });
    // No turn reported a cache write: null, not 0. Reasoning was reported by one turn: its sum.
    expect(out.rows[0].cacheWrite).toBeNull();
    expect(out.noLines).toBe(false);
    expect(out.sessionTotalsSkipped).toBe(1);
    expect(out.totals.input).toBe(1500);
  });

  it('counts a turn once even when its line is read twice', () => {
    const line = turn({ ...base, turnId: 't1', input: 10, output: 1 });
    const out = rollupUsage([line, line]);
    expect(out.totals.turns).toBe(1);
    expect(out.repeats).toBe(1);
  });

  it('keeps a turn without usage as such, not as zeros, and a reported zero as zero', () => {
    const out = rollupUsage([turn({ ...base, turnId: 't1', completeness: 'none' }), turn({ ...base, turnId: 't2', input: 0, output: 0 })]);
    expect(out.totals).toMatchObject({ turns: 2, turnsWithoutUsage: 1, input: 0, output: 0, cachedInput: null, uncachedInput: null });
    expect(out.totals.missing).toMatchObject({ input: 1, output: 1 });
    const none = rollupUsage([turn({ ...base, turnId: 't1' })]);
    expect(none.totals).toMatchObject({ input: null, output: null, reasoning: null, uncachedInput: null });
  });

  it('adds turn lines without an id but counts them, since a repeat of one cannot be told apart', () => {
    const line = turn({ ...base, input: 5, output: 1 });
    const out = rollupUsage([line, line, turn({ ...base, turnId: 't1', input: 1, output: 1 })]);
    expect(out.totals).toMatchObject({ turns: 3, turnsWithoutId: 2, input: 11 });
    expect(out.rows[0].turnsWithoutId).toBe(2);
  });

  it('says when there are no turn lines at all, and counts unreadable lines', () => {
    const out = rollupUsage([null, { ns: 'core:usage', msg: 'Usage session total', meta: {} }, { t: 'signal' }]);
    expect(out.noLines).toBe(true);
    expect(out.malformed).toBe(1);
    expect(out.rows).toEqual([]);
    expect(out.totals.input).toBeNull();
  });

  it('groups by the dimensions asked for, with unknown and none for what a line lacks', () => {
    const out = rollupUsage([
      turn({ ...base, turnId: 't1', input: 1, output: 1 }),
      turn({ agentId: 'x', sessionId: 's', turnId: 't', input: 2, output: 2 }),
    ], { groupBy: ['provider', 'parentAgentId', 'source'] });
    expect(out.rows.map((r) => [r.provider, r.parentAgentId, r.source, r.input])).toEqual([
      ['codex', 'orch', 'cumulative_delta', 1],
      ['unknown', 'none', 'unknown', 2],
    ]);
  });

  it('filters by UTC day and reports malformed lines', () => {
    const out = rollupUsage([
      turn({ ...base, turnId: 't1', input: 1 }, '2026-11-23T23:59:59.000Z'),
      turn({ ...base, turnId: 't2', input: 2 }, '2026-11-24T00:00:00.000Z'),
      { ns: 'core:usage', msg: 'Usage turn', ts: 'bad', meta: {} },
    ], { since: '2026-11-24' });
    expect(out.totals.input).toBe(2);
    expect(out.malformed).toBe(1);
  });
});
