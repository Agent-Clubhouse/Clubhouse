import { describe, expect, it } from 'vitest';
import type { GroupProject } from '../../../shared/group-project-types';
import {
  buildDirectory, coverageOf, COVERAGE_NOT_VERIFIED, matchesQuery, scopeKind, scopeReachLine, type DirectoryProject,
} from './groupProjectsDirectory';

const group = (id: string, name: string, over: Partial<GroupProject> = {}): GroupProject => ({
  id, name, description: '', instructions: '', createdAt: '2026-11-15T00:00:00Z', metadata: {},
  scope: { level: 'app', reach: 'local' }, ...over,
});
const projects: DirectoryProject[] = [
  { id: 'p-atlas', name: 'atlas', displayName: 'Atlas' },
  { id: 'p-beacon', name: 'Beacon' },
];
const atlasLocal = group('g1', 'Release checks', { scope: { level: 'project', projectId: 'p-atlas', reach: 'local' } });
const atlasNetwork = group('g2', 'Release planning', { scope: { level: 'project', projectId: 'p-atlas', reach: 'network' }, hostName: 'Studio Mac' });
const beaconLocal = group('g3', 'Beacon board', { scope: { level: 'project', projectId: 'p-beacon', reach: 'local' } });
const appWide = group('g4', 'Daily coordination');
const appNetwork = group('g5', 'Cross review', { scope: { level: 'app', reach: 'network' }, hostName: 'Travel laptop' });
const legacy = group('g6', 'Legacy review', { scope: undefined });
const replica = group('g7', 'Copy of their project', {
  scope: { level: 'project', projectId: 'their-project-id', reach: 'network' }, hostName: 'Studio Mac',
  network: { role: 'replica', state: 'online', waitingWrites: 0, refusals: [] },
});
const all = [atlasLocal, atlasNetwork, beaconLocal, appWide, appNetwork, legacy, replica];

describe('scopeKind', () => {
  it('reads app, project and unresolved scopes, never inferring one', () => {
    expect(scopeKind(appWide)).toBe('app');
    expect(scopeKind(atlasLocal)).toBe('project');
    expect(scopeKind(legacy)).toBe('unresolved');
    expect(scopeKind(group('x', 'X', { scope: { level: 'project', projectId: '  ', reach: 'local' } }))).toBe('unresolved');
  });
});

describe('coverageOf', () => {
  it('covers the project a group this computer holds names, local or network reach', () => {
    expect(coverageOf(atlasLocal, 'p-atlas')).toBe('covers');
    expect(coverageOf(atlasNetwork, 'p-atlas')).toBe('covers');
    expect(coverageOf(atlasLocal, 'p-beacon')).toBe('no');
  });

  it('does not say a copy of another computer\'s project group covers anything, or doesn\'t', () => {
    expect(coverageOf(replica, 'p-atlas')).toBe('not-verified');
    expect(coverageOf(replica, 'their-project-id')).toBe('not-verified');
  });

  it('has app-wide and unresolved groups cover no particular project', () => {
    expect(coverageOf(appWide, 'p-atlas')).toBe('no');
    expect(coverageOf(legacy, 'p-atlas')).toBe('no');
  });
});

describe('buildDirectory, all groups', () => {
  const dir = buildDirectory(all, projects, { kind: 'all' }, '');

  it('sections by project, then copies by host, then app-wide, then scope review', () => {
    expect(dir.sections.map((s) => s.heading)).toEqual(['Atlas', 'Beacon', 'Projects on Studio Mac', 'App-wide', 'Needs scope review']);
    expect(dir.shown).toBe(7);
    expect(dir.hiddenByView).toBe(0);
  });

  it('lists both reaches of a project together, by name', () => {
    expect(dir.sections[0].groups.map((g) => g.name)).toEqual(['Release checks', 'Release planning']);
  });

  it('says a copy\'s coverage is not verified here, and what a legacy group is', () => {
    expect(dir.sections[2].note).toContain(COVERAGE_NOT_VERIFIED);
    expect(dir.sections[4].note).toContain('no scope is inferred');
  });

  it('puts a project that is no longer here under its own heading rather than dropping the group', () => {
    const orphan = group('g8', 'Orphan', { scope: { level: 'project', projectId: 'gone', reach: 'local' } });
    const result = buildDirectory([orphan], projects, { kind: 'all' }, '');
    expect(result.sections.map((s) => s.heading)).toEqual(['Project not on this computer']);
  });

  it('orders names naturally and breaks ties by id, so a row never moves between renders', () => {
    const rows = [group('b', 'Board 10'), group('a2', 'Board 2'), group('a1', 'Board 2')];
    const result = buildDirectory(rows, projects, { kind: 'all' }, '');
    expect(result.sections[0].groups.map((g) => g.id)).toEqual(['a1', 'a2', 'b']);
  });

  it('is empty, with no sections, for no groups', () => {
    expect(buildDirectory([], projects, { kind: 'all' }, '')).toEqual({ sections: [], hiddenByView: 0, shown: 0 });
  });
});

describe('buildDirectory, a project view', () => {
  const dir = buildDirectory(all, projects, { kind: 'project', projectId: 'p-atlas' }, '');

  it('shows groups verified to cover the project, then app-wide groups, then copies that cannot be verified', () => {
    expect(dir.sections.map((s) => s.heading)).toEqual(['Atlas', 'App-wide', 'Copies from other computers']);
    expect(dir.sections[0].groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(dir.sections[1].groups.map((g) => g.id)).toEqual(['g5', 'g4']);
    expect(dir.sections[2].groups.map((g) => g.id)).toEqual(['g7']);
    expect(dir.sections[2].note).toContain(COVERAGE_NOT_VERIFIED);
  });

  it('counts what it leaves out, so All groups is an honest escape', () => {
    expect(dir.shown).toBe(5);
    expect(dir.hiddenByView).toBe(2);
  });

  it('leaves another project\'s groups and legacy groups out of the view', () => {
    const ids = dir.sections.flatMap((s) => s.groups.map((g) => g.id));
    expect(ids).not.toContain('g3');
    expect(ids).not.toContain('g6');
  });

  it('keeps app-wide groups when the project has none of its own', () => {
    const result = buildDirectory([appWide, beaconLocal], projects, { kind: 'project', projectId: 'p-atlas' }, '');
    expect(result.sections.map((s) => s.heading)).toEqual(['App-wide']);
    expect(result.hiddenByView).toBe(1);
  });

  it('never changes a group: the view only filters', () => {
    const before = JSON.stringify(all);
    buildDirectory(all, projects, { kind: 'project', projectId: 'p-atlas' }, '');
    expect(JSON.stringify(all)).toBe(before);
  });
});

describe('search', () => {
  it('matches the name, description, covered project and host, every word', () => {
    const rows = [group('g1', 'Release checks', { description: 'Gate for launches', scope: { level: 'project', projectId: 'p-atlas', reach: 'local' } }), atlasNetwork, appWide];
    expect(matchesQuery(rows[0], projects, 'release')).toBe(true);
    expect(matchesQuery(rows[0], projects, 'gate launches')).toBe(true);
    expect(matchesQuery(rows[0], projects, 'atlas')).toBe(true);
    expect(matchesQuery(atlasNetwork, projects, 'studio')).toBe(true);
    expect(matchesQuery(appWide, projects, 'this computer')).toBe(true);
    expect(matchesQuery(rows[0], projects, 'release zzz')).toBe(false);
    expect(matchesQuery(rows[0], projects, '   ')).toBe(true);
  });

  it('narrows sections, and counts only what the view leaves out of the matches', () => {
    const result = buildDirectory(all, projects, { kind: 'project', projectId: 'p-atlas' }, 'review');
    expect(result.sections.flatMap((s) => s.groups.map((g) => g.id))).toEqual(['g5']);
    expect(result.hiddenByView).toBe(1);
  });
});

describe('scopeReachLine', () => {
  it('says scope and reach in plain text', () => {
    expect(scopeReachLine(appWide, projects)).toBe('Scope: App-wide. Reach: This computer.');
    expect(scopeReachLine(appNetwork, projects)).toBe('Scope: App-wide. Reach: Network.');
    expect(scopeReachLine(atlasLocal, projects)).toBe('Scope: Atlas. Reach: This computer.');
    expect(scopeReachLine(replica, projects)).toBe('Scope: a project on Studio Mac. Reach: Network.');
    expect(scopeReachLine(legacy, projects)).toBe('Scope unresolved. Existing members kept.');
  });
});
