import { describe, expect, it } from 'vitest';
import { applyNoticeDelta, noticeCoverageDigest, noticeLegacyFloor, validateNoticeState, type NoticeDelta, type SequencedNoticeState } from './state';

const recipient = { groupId: 'synthetic-group', host: null, agentId: 'synthetic-member', generation: 'generation-one' };
function initialize(): SequencedNoticeState { return applyNoticeDelta(undefined, { kind: 'initialize', recipient, baseline: 0 }); }
const scan = (seq: number): NoticeDelta => ({ kind: 'scan', through: seq, eligible: [{ seq, postId: `synthetic-post-${seq}` }] });
const intent = (seq: number): NoticeDelta => ({ kind: 'intent', attemptId: `attempt-${seq}`, posts: [{ seq, postId: `synthetic-post-${seq}` }], startedAt: 1, handoffProcess: 'synthetic-process' });
const accepted = (seq: number): NoticeDelta => ({ kind: 'settle', attemptId: `attempt-${seq}`, outcome: 'accepted', acknowledgement: { kind: 'same-process-exact-handoff', handoffProcess: 'synthetic-process', coverageDigest: noticeCoverageDigest([{ seq, postId: `synthetic-post-${seq}` }]) } });

describe('sequenced notice state', () => {
  it('keeps A uncertain, records B success, permits C and does not revive scan-time exclusions', () => {
    let state = initialize();
    for (const delta of [scan(1), intent(1), { kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' }, scan(3), intent(3), accepted(3)] as NoticeDelta[]) state = applyNoticeDelta(state, delta);
    expect(state.pending).toEqual([{ seq: 1, postId: 'synthetic-post-1', attemptId: 'attempt-1' }]);
    expect(state.terminal).toEqual([[2, 3]]);
    expect(noticeLegacyFloor(state)).toBe(0);
    expect(applyNoticeDelta(state, scan(2))).toBe(state);
    state = applyNoticeDelta(state, scan(4));
    state = applyNoticeDelta(state, intent(4));
    expect(state.attempts.map((a) => a.attemptId)).toEqual(['attempt-1', 'attempt-4']);
    expect(validateNoticeState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('bounds million-post terminal coverage independently of an early hole', () => {
    let state = applyNoticeDelta(initialize(), scan(1));
    state = applyNoticeDelta(state, intent(1));
    state = applyNoticeDelta(state, { kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    state = applyNoticeDelta(state, { kind: 'scan', through: 1_000_001, eligible: [] });
    expect(state.terminal).toEqual([[2, 1_000_001]]);
    expect(state.pending).toHaveLength(1);
    expect(state.attempts).toHaveLength(1);
    expect(JSON.stringify(state).length).toBeLessThan(1024);
    expect(validateNoticeState(state)).toEqual(state);
  });

  it('recovery is uncertainty, never zero or a safe-to-retry hint', () => {
    let state = applyNoticeDelta(initialize(), scan(1));
    state = applyNoticeDelta(state, intent(1));
    state = applyNoticeDelta(state, { kind: 'queued', attemptId: 'attempt-1', messageId: 'runtime-item' });
    const recovered = applyNoticeDelta(state, { kind: 'recover' });
    expect(recovered.attempts[0]).toMatchObject({ status: 'uncertain', reason: 'recovered' });
    expect(applyNoticeDelta(recovered, { kind: 'recover' })).toBe(recovered);
    expect(() => applyNoticeDelta(recovered, { kind: 'settle', attemptId: 'attempt-1', outcome: 'unsubmitted' })).toThrow('Uncertainty');
    expect(() => applyNoticeDelta(recovered, { ...intent(1), attemptId: 'blind-retry' })).toThrow('not ready');
    expect(() => applyNoticeDelta(recovered, accepted(1))).toThrow('Recovered');
  });

  it('handles settlement before queued return and repeated callbacks without recreating coverage', () => {
    let state = applyNoticeDelta(applyNoticeDelta(initialize(), scan(1)), intent(1));
    state = applyNoticeDelta(state, accepted(1));
    expect(applyNoticeDelta(state, { kind: 'queued', attemptId: 'attempt-1', messageId: 'late-return' })).toBe(state);
    expect(applyNoticeDelta(state, { kind: 'settle', attemptId: 'attempt-1', outcome: 'accepted' })).toBe(state);
    expect(state.acceptedCount).toBe(1);
    expect(noticeLegacyFloor(state)).toBe(1);
  });

  it('permits proven unsubmitted recovery without clearing unrelated uncertainty', () => {
    let state = applyNoticeDelta(applyNoticeDelta(initialize(), scan(1)), intent(1));
    state = applyNoticeDelta(state, { kind: 'settle', attemptId: 'attempt-1', outcome: 'unsubmitted' });
    expect(state.pending[0].attemptId).toBeUndefined();
    expect(state.acceptedCount).toBe(0);
    state = applyNoticeDelta(state, { ...intent(1), attemptId: 'fresh-attempt' });
    expect(state.attempts[0].attemptId).toBe('fresh-attempt');
  });

  it('rejects reused keys, conflicting source IDs and oversized candidate batches', () => {
    const state = applyNoticeDelta(applyNoticeDelta(initialize(), scan(1)), intent(1));
    expect(applyNoticeDelta(state, intent(1))).toBe(state);
    expect(() => applyNoticeDelta(state, { ...intent(1), posts: [{ seq: 2, postId: 'other' }] })).toThrow('key conflict');
    expect(() => applyNoticeDelta(state, { kind: 'scan', through: 2, eligible: [{ seq: 1, postId: 'wrong' }] })).toThrow('identity');
    expect(() => applyNoticeDelta(state, { kind: 'scan', through: 51, eligible: Array.from({ length: 51 }, (_, seq) => ({ seq, postId: `p${seq}` })) })).toThrow('too large');
    expect(() => applyNoticeDelta(state, { kind: 'settle', attemptId: 'attempt-1', outcome: 'future' } as unknown as NoticeDelta)).toThrow('Unsupported');
  });

  it('refuses corrupt snapshots rather than silently baselining away uncertainty', () => {
    const state = applyNoticeDelta(applyNoticeDelta(initialize(), scan(1)), intent(1));
    for (const bad of [{ ...state, pending: [] }, { ...state, terminal: [[1, 1]] }, { ...state, attempts: [] }, { ...state, acceptedCount: 1 }, { ...state, schemaVersion: 2 }]) {
      expect(() => validateNoticeState(bad)).toThrow();
    }
    const future = { ...state, futureOptional: { keep: true } };
    expect(validateNoticeState(future)).toMatchObject({ futureOptional: { keep: true } });
  });

  it('permits only exact same-process late acknowledgement and records an anomaly count', () => {
    let state = applyNoticeDelta(applyNoticeDelta(initialize(), scan(1)), intent(1));
    state = applyNoticeDelta(state, { kind: 'settle', attemptId: 'attempt-1', outcome: 'uncertain' });
    expect(() => applyNoticeDelta(state, { kind: 'settle', attemptId: 'attempt-1', outcome: 'accepted' })).toThrow('provenance');
    const wrong = accepted(1) as Extract<NoticeDelta, { kind: 'settle' }>;
    expect(() => applyNoticeDelta(state, { ...wrong, acknowledgement: { ...wrong.acknowledgement!, handoffProcess: 'other-process' } })).toThrow('provenance');
    state = applyNoticeDelta(state, accepted(1));
    expect(state.lateAcknowledgementCount).toBe(1);
    expect(state.pending).toEqual([]);
    expect(state.terminal).toEqual([[1, 1]]);
  });

  it('rejects a cap50 scan with an unproved trailing frontier and names nonpost coverage honestly', () => {
    const state = initialize();
    const eligible = Array.from({ length: 50 }, (_, index) => ({ seq: index + 1, postId: `p${index}` }));
    expect(() => applyNoticeDelta(state, { kind: 'scan', through: 100, eligible })).toThrow('Capped');
    expect(applyNoticeDelta(state, { kind: 'scan', through: 50, eligible }).scannedThrough).toBe(50);
    const nonpostChanges = applyNoticeDelta(state, { kind: 'scan', through: 100, eligible: [] });
    expect(nonpostChanges.excludedSequenceCount).toBe(100);
    expect(nonpostChanges.acceptedCount).toBe(0);
  });
});
