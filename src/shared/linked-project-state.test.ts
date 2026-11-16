import { describe, expect, it } from 'vitest';
import {
  compareLinkedStateWrites, groupLinkedState, indexLinkedState, legacyLinkedStateRecords, linkedStateWrite, mergeLinkedStateRecords,
  parseIncomingLinkedStateRecords, parseLinkedStateRecords, projectLinkedState, type LinkedProjectStateRecord,
} from './linked-project-state';
import { DEFAULT_PROJECT_STATE, type ProjectState } from './project-state';
import type { NetworkProjectRef } from './project-links';

const A = Array(16).fill('aa').join(':'), B = Array(16).fill('bb').join(':'), C = Array(16).fill('cc').join(':');
const ref = (machine: string, projectId: string): NetworkProjectRef => ({ machine, projectId });
const a = ref(A, 'site'), b = ref(B, 'site-b'), c = ref(C, 'site-c');
const rec = (project: NetworkProjectRef, field: LinkedProjectStateRecord['field'], value: boolean, at: number, by = A): LinkedProjectStateRecord => ({ project, field, value, at, by });
const state = (over: Partial<ProjectState> = {}): ProjectState => ({ ...DEFAULT_PROJECT_STATE, ...over });
const NOW = 1_800_000_000_000;

/** One computer's view: its own state projected from the shared records. */
function project(records: LinkedProjectStateRecord[], groups: NetworkProjectRef[][], self: string, base = state()): ProjectState {
  return projectLinkedState(base, groups, indexLinkedState(records), self, NOW);
}

describe('linked project state merge rule', () => {
  it('lets the newest explicit edit win, whatever the values', () => {
    expect(compareLinkedStateWrites(rec(a, 'pinned', false, 20), rec(a, 'pinned', true, 10))).toBeGreaterThan(0);
    expect(compareLinkedStateWrites(rec(a, 'inactive', true, 20), rec(a, 'inactive', false, 10))).toBeGreaterThan(0);
  });

  it('folds clock-zero values as pinned if any and inactive only if all', () => {
    expect(compareLinkedStateWrites(rec(a, 'pinned', true, 0, B), rec(a, 'pinned', false, 0, A))).toBeGreaterThan(0);
    expect(compareLinkedStateWrites(rec(a, 'inactive', false, 0, B), rec(a, 'inactive', true, 0, A))).toBeGreaterThan(0);
    // Any explicit edit beats a value from before sharing.
    expect(compareLinkedStateWrites(rec(a, 'pinned', false, 1), rec(a, 'pinned', true, 0))).toBeGreaterThan(0);
  });

  it('breaks a full tie by writer, so every replica picks the same record', () => {
    const x = rec(a, 'pinned', true, 5, A), y = rec(a, 'pinned', true, 5, B);
    expect(mergeLinkedStateRecords([x], [y])).toEqual(mergeLinkedStateRecords([y], [x]));
  });

  it('merges idempotently and in any order', () => {
    const writes = [rec(a, 'pinned', true, 3), rec(a, 'pinned', false, 7, B), rec(b, 'inactive', true, 2), rec(b, 'inactive', false, 0, C), rec(a, 'pinned', true, 0, C)];
    const once = mergeLinkedStateRecords([], writes);
    expect(mergeLinkedStateRecords(once, writes)).toBe(once);
    for (let i = 0; i < 10; i++) {
      const shuffled = [...writes].sort(() => Math.random() - 0.5);
      expect(shuffled.reduce((acc, r) => mergeLinkedStateRecords(acc, [r]), [] as LinkedProjectStateRecord[])).toEqual(once);
    }
  });
});

describe('linked project state records from the network', () => {
  it('accepts only well-formed records', () => {
    expect(parseLinkedStateRecords([{ project: { machine: A.toUpperCase(), projectId: 'p' }, field: 'pinned', value: true, at: 1, by: B.toUpperCase() }]))
      .toEqual([{ project: { machine: A, projectId: 'p' }, field: 'pinned', value: true, at: 1, by: B }]);
    const bad = [
      { project: { machine: 'nope', projectId: 'p' }, field: 'pinned', value: true, at: 1, by: A },
      { project: a, field: 'idle', value: true, at: 1, by: A },
      { project: a, field: 'pinned', value: 'yes', at: 1, by: A },
      { project: a, field: 'activated', value: false, at: 1, by: A },
      { project: a, field: 'pinned', value: true, at: -1, by: A },
      { project: a, field: 'pinned', value: true, at: 1.5, by: A },
      { project: a, field: 'pinned', value: true, at: 1, by: A, extra: 1 },
    ];
    for (const r of bad) expect(() => parseLinkedStateRecords([r])).toThrow();
    expect(() => parseLinkedStateRecords(Array(3).fill(rec(a, 'pinned', true, 1)), 2)).toThrow();
  });

  it('drops records clocked more than a day ahead, keeping the rest of the page', () => {
    const page = [rec(a, 'pinned', true, NOW + 2 * 86_400_000), rec(b, 'pinned', true, NOW + 1000)];
    expect(parseIncomingLinkedStateRecords(page, 200, NOW)).toEqual([page[1]]);
  });
});

describe('explicit writes', () => {
  const groups = [[a, b]];

  it('writes one clock to every copy; pinning also clears inactive', () => {
    const records = [rec(a, 'pinned', false, 40)];
    const written = linkedStateWrite(records, groups, { type: 'setPinned', projectId: 'site', pinned: true }, A, 10);
    expect(written).toEqual([
      rec(a, 'pinned', true, 41), rec(a, 'inactive', false, 41),
      rec(b, 'pinned', true, 41), rec(b, 'inactive', false, 41),
    ]);
  });

  it('Mark active writes the activity moment for every copy; Mark inactive does not', () => {
    const active = linkedStateWrite([rec(a, 'inactive', true, 5), rec(b, 'inactive', true, 5)], groups, { type: 'setInactive', projectId: `remote||${B}||site-b`, inactive: false, at: 99 }, A, 100);
    expect(active.filter((r) => r.field === 'activated').map((r) => r.project)).toEqual([a, b]);
    const inactive = linkedStateWrite([], groups, { type: 'setInactive', projectId: 'site', inactive: true, at: 99 }, A, 100);
    expect(inactive.map((r) => r.field)).toEqual(['inactive', 'inactive']);
  });

  it('writes nothing when every copy already has the value from an explicit edit', () => {
    const records = [rec(a, 'pinned', true, 5), rec(b, 'pinned', true, 5), rec(a, 'inactive', false, 5), rec(b, 'inactive', false, 5)];
    expect(linkedStateWrite(records, groups, { type: 'setPinned', projectId: 'site', pinned: true }, A, 100)).toEqual([]);
    // A clock-zero value is still written, so the choice is explicit from now on.
    expect(linkedStateWrite([rec(a, 'pinned', true, 0), rec(b, 'pinned', true, 0)], groups, { type: 'setPinned', projectId: 'site', pinned: true }, A, 100)).toHaveLength(4);
    expect(linkedStateWrite([], groups, { type: 'markActivity', projectId: 'site', at: 1 }, A, 100)).toEqual([]);
  });

  it('writes just the project when it is not linked, so an edit before linking still counts', () => {
    expect(linkedStateWrite([], [], { type: 'setPinned', projectId: 'other', pinned: false }, A, 100)).toEqual([rec(ref(A, 'other'), 'pinned', false, 100)]);
  });
});

describe('values from before sharing', () => {
  it('offers this computer\'s own copies either way, and other machines\' rows it pinned or marked', () => {
    const local = state({ pinnedProjectIds: ['site', `remote||${C}||site-c`], inactiveProjectIds: [] });
    expect(legacyLinkedStateRecords(local, [[a, b, c]], A)).toEqual([
      rec(a, 'pinned', true, 0), rec(a, 'inactive', false, 0), rec(c, 'pinned', true, 0),
    ]);
  });

  it('fold to pinned if any copy was pinned, and inactive only if every copy was', () => {
    const groups = [[a, b]];
    const fromA = legacyLinkedStateRecords(state({ pinnedProjectIds: ['site'], inactiveProjectIds: [] }), groups, A);
    const fromB = legacyLinkedStateRecords(state({ inactiveProjectIds: ['site-b'] }), groups, B);
    const records = mergeLinkedStateRecords(mergeLinkedStateRecords([], fromA), fromB);
    const index = indexLinkedState(records);
    expect(groupLinkedState(index, groups[0], 'pinned')?.value).toBe(true);
    expect(groupLinkedState(index, groups[0], 'inactive')?.value).toBe(false);
    const bothInactive = mergeLinkedStateRecords([], [
      ...legacyLinkedStateRecords(state({ inactiveProjectIds: ['site'] }), groups, A), ...fromB,
    ]);
    expect(groupLinkedState(indexLinkedState(bothInactive), groups[0], 'inactive')?.value).toBe(true);
  });

  it('lose to any explicit edit, even one made earlier on another copy', () => {
    const groups = [[a, b]];
    const records = mergeLinkedStateRecords([rec(b, 'pinned', false, 5, B)], legacyLinkedStateRecords(state({ pinnedProjectIds: ['site'] }), groups, A));
    expect(groupLinkedState(indexLinkedState(records), groups[0], 'pinned')?.value).toBe(false);
  });
});

describe('projection onto each computer', () => {
  const remoteB = `remote||${B}||site-b`, remoteA = `remote||${A}||site`;

  it('gives every copy the group value under the id each computer shows', () => {
    const records = [rec(a, 'pinned', true, 9), rec(b, 'pinned', true, 9)];
    expect(project(records, [[a, b]], A).pinnedProjectIds).toEqual([remoteB, 'site']);
    expect(project(records, [[a, b]], B).pinnedProjectIds).toEqual([remoteA, 'site-b']);
  });

  it('leaves unlinked projects and fields with no record alone, and returns the same state when nothing changes', () => {
    const base = state({ pinnedProjectIds: ['solo'], inactiveProjectIds: ['other'], projectActivity: { solo: 1 } });
    // A record for an unlinked project is kept but not applied.
    expect(project([rec(ref(A, 'solo'), 'pinned', false, 50)], [[a, b]], A, base)).toBe(base);
    const settled = project([rec(a, 'pinned', true, 9)], [[a, b]], A, base);
    expect(project([rec(a, 'pinned', true, 9)], [[a, b]], A, settled)).toBe(settled);
  });

  it('keeps existing pins in place and adds new ones after them, oldest first', () => {
    const base = state({ pinnedProjectIds: ['x', 'site'] });
    const groups = [[a, b], [ref(A, 'p2'), ref(B, 'q2')]];
    const records = [rec(a, 'pinned', true, 9), rec(ref(A, 'p2'), 'pinned', true, 3)];
    expect(project(records, groups, A, base).pinnedProjectIds).toEqual(['x', 'site', 'p2', `remote||${B}||q2`, remoteB]);
  });

  it('records an explicit Mark active as activity on every copy, never in the future and never earlier than known', () => {
    const base = state({ projectActivity: { site: NOW - 10, [remoteB]: NOW - 99_999 } });
    const out = project([rec(a, 'activated', true, NOW - 50)], [[a, b]], A, base);
    expect(out.projectActivity).toEqual({ site: NOW - 10, [remoteB]: NOW - 50 });
    expect(project([rec(a, 'activated', true, NOW + 5000)], [[a, b]], A).projectActivity[remoteB]).toBe(NOW);
  });

  it('a third copy joining takes the group value; its own older value doesn\'t count', () => {
    const records = mergeLinkedStateRecords([], [rec(a, 'pinned', true, 9), rec(b, 'pinned', true, 9), rec(c, 'pinned', false, 4, C)]);
    expect(project(records, [[a, b, c]], C).pinnedProjectIds).toEqual([remoteA, `remote||${B}||site-b`, 'site-c']);
  });

  it('a split keeps the shared value on each copy, and changes after it stay separate', () => {
    const shared = mergeLinkedStateRecords([], linkedStateWrite([], [[a, b]], { type: 'setPinned', projectId: 'site', pinned: true }, A, 10));
    const onA = project(shared, [[a, b]], A);
    // Split: no groups any more. Nothing is restored; each keeps the pin.
    expect(project(shared, [], A, onA)).toBe(onA);
    expect(onA.pinnedProjectIds).toContain('site');
    // An unpin on A's copy alone, after the split, doesn't reach B's.
    const later = mergeLinkedStateRecords(shared, linkedStateWrite(shared, [], { type: 'setPinned', projectId: 'site', pinned: false }, A, 20));
    expect(groupLinkedState(indexLinkedState(later), [b], 'pinned')?.value).toBe(true);
  });

  it('a late offline member with older edits converges to the newer value; with newer edits it wins', () => {
    const groups = [[a, b]];
    const online = mergeLinkedStateRecords([], linkedStateWrite([], groups, { type: 'setPinned', projectId: 'site', pinned: true }, A, 100));
    const older = linkedStateWrite([], groups, { type: 'setPinned', projectId: `remote||${A}||site`, pinned: false }, B, 50);
    expect(groupLinkedState(indexLinkedState(mergeLinkedStateRecords(online, older)), groups[0], 'pinned')?.value).toBe(true);
    const newer = linkedStateWrite([], groups, { type: 'setPinned', projectId: `remote||${A}||site`, pinned: false }, B, 150);
    expect(groupLinkedState(indexLinkedState(mergeLinkedStateRecords(online, newer)), groups[0], 'pinned')?.value).toBe(false);
  });

  it('concurrent Pin and Mark inactive leave both set; the idle rule keeps pinned first', () => {
    const groups = [[a, b]];
    const pin = linkedStateWrite([], groups, { type: 'setPinned', projectId: 'site', pinned: true }, A, 10);
    const mark = linkedStateWrite([], groups, { type: 'setInactive', projectId: 'site-b', inactive: true, at: 12 }, B, 12);
    const out = project(mergeLinkedStateRecords([], [...pin, ...mark]), groups, A);
    expect(out.pinnedProjectIds).toContain('site');
    expect(out.inactiveProjectIds).toContain('site');
  });
});
