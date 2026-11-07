import { describe, expect, it } from 'vitest';
import { classifyCreationComposition, commitCreationComposition, type CreationCompositionMarker } from './new-agent-composition-lifecycle';

const marker: CreationCompositionMarker = {
  reservationId: 'owned-reservation', agentId: 'new-agent', beforeRevision: 0, expectedRevision: 1, phase: 'prepared',
};

describe('creation composition recovery', () => {
  it('allows record cleanup only for a known absent precommit composition', () => {
    expect(classifyCreationComposition(marker, { known: true, revision: null })).toEqual({ kind: 'absent', mayRemoveCreation: true });
    expect(classifyCreationComposition(marker, { known: false })).toEqual({ kind: 'retain', mayRemoveCreation: false, reason: 'unknown' });
  });
  it('retains a saved composition after interrupted commit, even before marker advancement', () => {
    expect(classifyCreationComposition(marker, { known: true, revision: 1 })).toEqual({ kind: 'retain', mayRemoveCreation: false, reason: 'saved' });
  });
  it('retains newer state and missing state after recorded commit', () => {
    expect(classifyCreationComposition(marker, { known: true, revision: 2 })).toEqual({ kind: 'retain', mayRemoveCreation: false, reason: 'changed' });
    expect(classifyCreationComposition({ ...marker, phase: 'committed' }, { known: true, revision: null })).toEqual({ kind: 'retain', mayRemoveCreation: false, reason: 'missing-after-commit' });
  });
});

describe('required creation composition phase', () => {
  it('records ownership and commit before completing', async () => {
    const calls: string[] = [];
    await commitCreationComposition({
      assertCurrent: () => { calls.push('guard'); },
      prepare: async () => { calls.push('prepare'); },
      commit: async () => { calls.push('commit'); },
      recordCommitted: async () => { calls.push('record'); },
    });
    expect(calls).toEqual(['guard', 'prepare', 'guard', 'commit', 'record', 'guard']);
  });
  it('refuses cancellation after preparation without calling commit', async () => {
    const cancelled = new Error('cancelled');
    let closing = false;
    let committed = false;
    await expect(commitCreationComposition({
      assertCurrent: () => { if (closing) throw cancelled; },
      prepare: async () => { closing = true; },
      commit: async () => { committed = true; },
      recordCommitted: async () => { throw new Error('unexpected'); },
    })).rejects.toBe(cancelled);
    expect(committed).toBe(false);
  });
  it('records commit before reporting cancellation that arrived during commit', async () => {
    const cancelled = new Error('cancelled');
    let closing = false;
    let recorded = false;
    await expect(commitCreationComposition({
      assertCurrent: () => { if (closing) throw cancelled; },
      prepare: async () => {},
      commit: async () => { closing = true; },
      recordCommitted: async () => { recorded = true; },
    })).rejects.toBe(cancelled);
    expect(recorded).toBe(true);
  });
  it('preserves an undefined commit rejection and never records success', async () => {
    let recorded = false;
    await expect(commitCreationComposition({
      assertCurrent: () => {}, prepare: async () => {},
      commit: async () => { throw undefined; },
      recordCommitted: async () => { recorded = true; },
    })).rejects.toBeUndefined();
    expect(recorded).toBe(false);
  });
  it('propagates journal failure after commit instead of allowing readiness', async () => {
    const failure = new Error('journal unavailable');
    await expect(commitCreationComposition({
      assertCurrent: () => {}, prepare: async () => {}, commit: async () => {},
      recordCommitted: async () => { throw failure; },
    })).rejects.toBe(failure);
  });
});
