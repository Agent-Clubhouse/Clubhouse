import { describe, it, expect } from 'vitest';
import {
  applyFinishedQuickAgentOp,
  MAX_FINISHED_QUICK_AGENTS,
  parseFinishedQuickAgentOp,
  sanitizeFinishedQuickAgents,
  type FinishedQuickAgents,
} from './finished-quick-agents';
import type { CompletedQuickAgent } from './types';

const rec = (id: string, projectId = 'p', extra: Partial<CompletedQuickAgent> = {}): CompletedQuickAgent => ({
  id, projectId, name: `n-${id}`, mission: 'm', summary: null, filesModified: [], exitCode: 0, completedAt: 1, ...extra,
});

describe('finished quick agent ops (#2467)', () => {
  it('adds newest first, ignores an id already listed, and keeps the latest 50', () => {
    let state: FinishedQuickAgents = {};
    state = applyFinishedQuickAgentOp(state, { type: 'add', record: rec('a') });
    state = applyFinishedQuickAgentOp(state, { type: 'add', record: rec('b') });
    expect(state.p.map((r) => r.id)).toEqual(['b', 'a']);
    expect(applyFinishedQuickAgentOp(state, { type: 'add', record: rec('a', 'p', { name: 'other' }) })).toBe(state);

    for (let i = 0; i < MAX_FINISHED_QUICK_AGENTS; i++) state = applyFinishedQuickAgentOp(state, { type: 'add', record: rec(`x${i}`) });
    expect(state.p).toHaveLength(MAX_FINISHED_QUICK_AGENTS);
    expect(state.p[0].id).toBe(`x${MAX_FINISHED_QUICK_AGENTS - 1}`);
    expect(state.p.some((r) => r.id === 'a')).toBe(false);
  });

  it('keeps projects apart', () => {
    const state = applyFinishedQuickAgentOp({ p: [rec('a')] }, { type: 'add', record: rec('b', 'q') });
    expect(state).toEqual({ p: [rec('a')], q: [rec('b', 'q')] });
  });

  it('dismisses one, and clears a project; both are no-ops when there is nothing to remove', () => {
    const state: FinishedQuickAgents = { p: [rec('a'), rec('b')], q: [rec('c', 'q')] };
    expect(applyFinishedQuickAgentOp(state, { type: 'dismiss', projectId: 'p', agentId: 'a' })).toEqual({ p: [rec('b')], q: [rec('c', 'q')] });
    expect(applyFinishedQuickAgentOp(state, { type: 'dismiss', projectId: 'p', agentId: 'zz' })).toBe(state);
    expect(applyFinishedQuickAgentOp(state, { type: 'dismiss', projectId: 'none', agentId: 'a' })).toBe(state);
    expect(applyFinishedQuickAgentOp(state, { type: 'clear', projectId: 'p' })).toEqual({ p: [], q: [rec('c', 'q')] });
    expect(applyFinishedQuickAgentOp({ p: [] }, { type: 'clear', projectId: 'p' })).toEqual({ p: [] });
    const empty = { p: [] };
    expect(applyFinishedQuickAgentOp(empty, { type: 'clear', projectId: 'p' })).toBe(empty);
  });

  it('sanitizes untrusted lists: drops bad entries and ones filed under the wrong project, and caps each list', () => {
    const many = Array.from({ length: 60 }, (_, i) => rec(`r${i}`));
    expect(sanitizeFinishedQuickAgents({
      p: [rec('ok', 'p', { costUsd: 2 }), { id: 'bad' }, rec('elsewhere', 'q'), null, { ...rec('fix'), summary: 3, filesModified: ['a', 1] }],
      q: 'nope',
      big: many.map((r) => ({ ...r, projectId: 'big' })),
    })).toEqual({
      p: [rec('ok', 'p', { costUsd: 2 }), rec('fix', 'p', { filesModified: ['a'] })],
      big: many.slice(0, MAX_FINISHED_QUICK_AGENTS).map((r) => ({ ...r, projectId: 'big' })),
    });
    expect(sanitizeFinishedQuickAgents(null)).toEqual({});
    expect(sanitizeFinishedQuickAgents([rec('a')])).toEqual({});
  });

  it('parses ops from untrusted IPC', () => {
    expect(parseFinishedQuickAgentOp({ type: 'add', record: rec('a') })).toEqual({ type: 'add', record: rec('a') });
    expect(parseFinishedQuickAgentOp({ type: 'dismiss', projectId: 'p', agentId: 'a' })).toEqual({ type: 'dismiss', projectId: 'p', agentId: 'a' });
    expect(parseFinishedQuickAgentOp({ type: 'clear', projectId: 'p' })).toEqual({ type: 'clear', projectId: 'p' });
    for (const bad of [null, 'x', { type: 'add' }, { type: 'add', record: { id: 'a' } }, { type: 'dismiss', projectId: 'p' },
      { type: 'dismiss', projectId: '', agentId: 'a' }, { type: 'clear' }, { type: 'nuke', projectId: 'p' }]) {
      expect(parseFinishedQuickAgentOp(bad)).toBeNull();
    }
  });
});
