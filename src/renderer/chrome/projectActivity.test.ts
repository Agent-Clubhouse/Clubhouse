import { describe, it, expect } from 'vitest';
import { isProjectIdle, partitionIdle, type IdleInput } from './projectActivity';

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;
const base: IdleInput = { activity: { old: now - 8 * DAY, fresh: now - 2 * DAY }, pinnedIds: [], runningIds: new Set(), activeProjectId: null, idleDays: 7, now };

describe('idle rule', () => {
  it('is idle after the window with no activity', () => {
    expect(isProjectIdle('old', base)).toBe(true);
    expect(isProjectIdle('fresh', base)).toBe(false);
  });

  it('never folds pinned, running or selected projects, or ones with no record yet', () => {
    expect(isProjectIdle('old', { ...base, pinnedIds: ['old'] })).toBe(false);
    expect(isProjectIdle('old', { ...base, runningIds: new Set(['old']) })).toBe(false);
    expect(isProjectIdle('old', { ...base, activeProjectId: 'old' })).toBe(false);
    expect(isProjectIdle('unseen', base)).toBe(false);
  });

  it('follows the configured window, and 0 means never', () => {
    expect(isProjectIdle('old', { ...base, idleDays: 14 })).toBe(false);
    expect(isProjectIdle('fresh', { ...base, idleDays: 1 })).toBe(true);
    expect(isProjectIdle('old', { ...base, idleDays: 0 })).toBe(false);
  });

  it('partitions in order', () => {
    const projects = [{ id: 'old' }, { id: 'fresh' }, { id: 'unseen' }];
    const { active, idle } = partitionIdle(projects, base);
    expect(active.map((p) => p.id)).toEqual(['fresh', 'unseen']);
    expect(idle.map((p) => p.id)).toEqual(['old']);
  });
});
