import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_WRITE_INTERVAL_MS,
  applyProjectStateOp,
  DEFAULT_IDLE_DAYS,
  DEFAULT_PROJECT_STATE,
  parseProjectStateOp,
  sanitizeProjectState,
  type ProjectState,
} from './project-state';

const state = (s: Partial<ProjectState> = {}): ProjectState => ({ ...DEFAULT_PROJECT_STATE, ...s });

describe('applyProjectStateOp (#2458)', () => {
  it('pins at the end and unpins, returning the same state when nothing changes', () => {
    const pinned = applyProjectStateOp(state({ pinnedProjectIds: ['a'] }), { type: 'setPinned', projectId: 'b', pinned: true });
    expect(pinned.pinnedProjectIds).toEqual(['a', 'b']);
    expect(applyProjectStateOp(pinned, { type: 'setPinned', projectId: 'a', pinned: false }).pinnedProjectIds).toEqual(['b']);
    expect(applyProjectStateOp(pinned, { type: 'setPinned', projectId: 'b', pinned: true })).toBe(pinned);
  });

  it('refuses to mark a pinned project inactive', () => {
    const s = state({ pinnedProjectIds: ['a'] });
    expect(applyProjectStateOp(s, { type: 'setInactive', projectId: 'a', inactive: true, at: 1 })).toBe(s);
    expect(applyProjectStateOp(s, { type: 'setInactive', projectId: 'b', inactive: true, at: 1 }).inactiveProjectIds).toEqual(['b']);
  });

  it('marking active clears the mark and counts as activity, unthrottled', () => {
    const s = state({ inactiveProjectIds: ['a'], projectActivity: { a: 1_000 } });
    const next = applyProjectStateOp(s, { type: 'setInactive', projectId: 'a', inactive: false, at: 1_001 });
    expect(next).toEqual(state({ inactiveProjectIds: [], projectActivity: { a: 1_001 } }));
    // Again at the same time: nothing to change.
    expect(applyProjectStateOp(next, { type: 'setInactive', projectId: 'a', inactive: false, at: 1_001 })).toBe(next);
  });

  it('throttles activity to one write per interval per project', () => {
    const s = state({ projectActivity: { a: 1_000 } });
    expect(applyProjectStateOp(s, { type: 'markActivity', projectId: 'a', at: 1_000 + ACTIVITY_WRITE_INTERVAL_MS - 1 })).toBe(s);
    expect(applyProjectStateOp(s, { type: 'markActivity', projectId: 'a', at: 1_000 + ACTIVITY_WRITE_INTERVAL_MS }).projectActivity.a)
      .toBe(1_000 + ACTIVITY_WRITE_INTERVAL_MS);
    expect(applyProjectStateOp(s, { type: 'markActivity', projectId: 'b', at: 5 }).projectActivity).toEqual({ a: 1_000, b: 5 });
  });

  it('seeds only projects with no activity yet', () => {
    const s = state({ projectActivity: { a: 1 } });
    expect(applyProjectStateOp(s, { type: 'seedActivity', projectIds: ['a', 'b'], at: 9 }).projectActivity).toEqual({ a: 1, b: 9 });
    expect(applyProjectStateOp(s, { type: 'seedActivity', projectIds: ['a'], at: 9 })).toBe(s);
  });

  it('rounds the idle window and keeps it at 0 or more', () => {
    expect(applyProjectStateOp(state(), { type: 'setIdleDays', days: 13.6 }).idleDays).toBe(14);
    expect(applyProjectStateOp(state(), { type: 'setIdleDays', days: -3 }).idleDays).toBe(0);
  });

  it('forgets removed projects', () => {
    const s = state({ pinnedProjectIds: ['a', 'b'], inactiveProjectIds: ['a'], projectActivity: { a: 1, b: 2 } });
    expect(applyProjectStateOp(s, { type: 'forget', projectIds: ['a'] }))
      .toEqual(state({ pinnedProjectIds: ['b'], inactiveProjectIds: [], projectActivity: { b: 2 } }));
    expect(applyProjectStateOp(s, { type: 'forget', projectIds: ['z'] })).toBe(s);
  });
});

describe('sanitizeProjectState', () => {
  it('drops bad fields to their defaults', () => {
    expect(sanitizeProjectState({ pinnedProjectIds: ['a', 3], inactiveProjectIds: 'x', projectActivity: { a: 1, b: 'no', c: Infinity }, idleDays: -1 }))
      .toEqual({ pinnedProjectIds: ['a'], inactiveProjectIds: [], projectActivity: { a: 1 }, idleDays: DEFAULT_IDLE_DAYS });
    expect(sanitizeProjectState(null)).toEqual(DEFAULT_PROJECT_STATE);
    expect(sanitizeProjectState({ idleDays: 0 }).idleDays).toBe(0);
  });
});

describe('parseProjectStateOp', () => {
  it('accepts each op and rejects malformed ones', () => {
    expect(parseProjectStateOp({ type: 'setPinned', projectId: 'a', pinned: true, extra: 1 })).toEqual({ type: 'setPinned', projectId: 'a', pinned: true });
    expect(parseProjectStateOp({ type: 'setInactive', projectId: 'a', inactive: false, at: 5 })).toEqual({ type: 'setInactive', projectId: 'a', inactive: false, at: 5 });
    expect(parseProjectStateOp({ type: 'seedActivity', projectIds: ['a'], at: 1 })).not.toBeNull();
    expect(parseProjectStateOp({ type: 'forget', projectIds: ['a'] })).not.toBeNull();
    expect(parseProjectStateOp({ type: 'setIdleDays', days: 3 })).not.toBeNull();
    expect(parseProjectStateOp({ type: 'setPinned', projectId: '', pinned: true })).toBeNull();
    expect(parseProjectStateOp({ type: 'setInactive', projectId: 'a', inactive: true })).toBeNull();
    expect(parseProjectStateOp({ type: 'markActivity', projectId: 'a', at: NaN })).toBeNull();
    expect(parseProjectStateOp({ type: 'forget', projectIds: [1] })).toBeNull();
    expect(parseProjectStateOp({ type: 'drop' })).toBeNull();
    expect(parseProjectStateOp('setPinned')).toBeNull();
  });
});
