/**
 * Verified network project coverage (#3549): explicit project links decide, a
 * repository match only offers a link, and a copy this computer can't check is
 * unknown rather than not covered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject } from '../../shared/group-project-types';

const fx = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; displayName?: string; path: string }>,
  linkGroups: [] as Array<Array<{ machine: string; projectId: string }>>,
  records: [] as Array<{ projects: Array<{ machine: string; projectId: string }>; linked: boolean }>,
  satellites: [] as Array<{ fingerprint: string; alias: string; state: string; snapshot: unknown; snapshotUnavailable?: boolean }>,
  repoKeys: {} as Record<string, string>,
  groups: [] as unknown[],
  linksThrow: false,
  member: true,
}));
const SELF = 'aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa';
const REMOTE = 'bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: async () => fx.projects }));
vi.mock('./project-repo-keys', () => ({ repoKeysFor: async () => fx.repoKeys }));
vi.mock('./annex-client', () => ({ getSatellites: () => fx.satellites }));
vi.mock('./project-links-store', () => ({ projectLinksStore: () => ({
  groups: () => { if (fx.linksThrow) throw new Error('Shared project links could not be read.'); return fx.linkGroups; },
  records: () => fx.records,
}) }));
vi.mock('./group-project-host', () => ({ groupProjectHost: {
  selfMachine: () => SELF,
  isNetworkMember: () => fx.member,
  list: async () => fx.groups,
} }));

import { computeCoverage, describeCoverage, listCoverage, previewCoverage, type CoverageInputs } from './group-project-coverage';
import { verifyCopy } from './group-project-linked-agents';

const ATLAS = { id: 'p-atlas', name: 'atlas', displayName: 'Atlas', path: '/w/atlas' };
const OTHER = { id: 'p-other', name: 'Other', path: '/w/other' };
const snapshot = (projects = [{ id: 'remote-atlas', name: 'Atlas', repoKey: 'git:acme/atlas' }]) => ({
  projects, agents: Object.fromEntries(projects.map((p) => [p.id, []])),
});
const link = (...refs: Array<[string, string]>) => { fx.linkGroups = [refs.map(([machine, projectId]) => ({ machine, projectId }))]; };
const sat = (over: Record<string, unknown> = {}) => ({ fingerprint: REMOTE, alias: 'Laptop', state: 'connected', snapshot: snapshot(), ...over });

const gp = (over: Partial<GroupProject> = {}): GroupProject => ({
  id: 'g1', name: 'Release', description: '', instructions: '', createdAt: '', metadata: {},
  scope: { level: 'project', projectId: ATLAS.id, reach: 'network' }, ...over,
});
const replica = (over: Partial<GroupProject> = {}) => gp({
  id: 'g-replica', scope: { level: 'project', projectId: 'remote-atlas', reach: 'network' },
  host: { machine: REMOTE }, network: { role: 'replica', state: 'online', waitingWrites: 0, refusals: [] }, ...over,
});

beforeEach(() => {
  fx.projects = [ATLAS, OTHER]; fx.linkGroups = []; fx.records = []; fx.satellites = [sat()]; fx.repoKeys = {};
  fx.groups = []; fx.linksThrow = false; fx.member = true;
});

describe('coverage of a group this computer hosts', () => {
  it('covers its own project and an explicitly linked copy, verified when the copy can be checked', async () => {
    link([SELF, ATLAS.id], [REMOTE, 'remote-atlas']);
    const coverage = await describeCoverage(gp());
    expect(coverage.copies).toEqual([
      { machine: SELF, projectId: ATLAS.id, name: 'Atlas', thisComputer: true, state: 'verified' },
      { machine: REMOTE, projectId: 'remote-atlas', name: 'Atlas on Laptop', thisComputer: false, state: 'verified' },
    ]);
    expect(coverage).toMatchObject({ scoped: true, complete: true, localUnknown: false });
  });

  it('covers only its own project with no link, even when the other computer has the same repository', async () => {
    fx.repoKeys = { [ATLAS.id]: 'git:acme/atlas' };
    const coverage = await describeCoverage(gp());
    expect(coverage.copies.map((c) => c.projectId)).toEqual([ATLAS.id]);
    expect(coverage.repositoryMatches).toEqual([]);
  });

  it('follows a link added and a link removed', async () => {
    expect((await describeCoverage(gp())).copies).toHaveLength(1);
    link([SELF, ATLAS.id], [REMOTE, 'remote-atlas']);
    expect((await describeCoverage(gp())).copies.map((c) => c.projectId)).toEqual([ATLAS.id, 'remote-atlas']);
    fx.linkGroups = [];
    expect((await describeCoverage(gp())).copies.map((c) => c.projectId)).toEqual([ATLAS.id]);
  });

  it.each([
    ['offline', () => { fx.satellites = [sat({ state: 'disconnected' })]; }],
    ['not yet paired', () => { fx.satellites = []; }],
    ['snapshot unavailable', () => { fx.satellites = [sat({ snapshotUnavailable: true })]; }],
    ['snapshot truncated', () => { fx.satellites = [sat({ snapshot: { ...snapshot(), snapshotTruncated: { omitted: ['agents'] } } })]; }],
    ['project missing from the snapshot', () => { fx.satellites = [sat({ snapshot: snapshot([]) })]; }],
    ['not a network member', () => { fx.member = false; }],
  ])('keeps a linked copy as unknown, never dropped, when it is %s', async (_name, arrange) => {
    link([SELF, ATLAS.id], [REMOTE, 'remote-atlas']);
    arrange();
    const coverage = await describeCoverage(gp());
    expect(coverage.copies.find((c) => c.machine === REMOTE)).toMatchObject({ projectId: 'remote-atlas', state: 'unknown' });
    expect(coverage.complete).toBe(false);
  });

  it('covers a local-reach group by its own project alone: links extend network groups only', async () => {
    link([SELF, ATLAS.id], [REMOTE, 'remote-atlas']);
    const coverage = await describeCoverage(gp({ scope: { level: 'project', projectId: ATLAS.id, reach: 'local' } }));
    expect(coverage.copies.map((c) => c.projectId)).toEqual([ATLAS.id]);
  });

  it('covers no project for an app-wide group', async () => {
    expect(await describeCoverage(gp({ scope: { level: 'app', reach: 'network' } }))).toMatchObject({ scoped: false, copies: [], complete: true });
  });

  it('reports unreadable project links as unknown rather than throwing', async () => {
    fx.linksThrow = true;
    const coverage = await describeCoverage(gp());
    expect(coverage.copies.map((c) => c.projectId)).toEqual([ATLAS.id]);
    expect(coverage).toMatchObject({ localUnknown: true, complete: false });
  });
});

describe('coverage of a copy of another computer\'s group', () => {
  it('covers this computer\'s project through a link, including the host\'s own project', async () => {
    link([REMOTE, 'remote-atlas'], [SELF, ATLAS.id]);
    const coverage = await describeCoverage(replica());
    expect(coverage.copies.filter((c) => c.thisComputer).map((c) => c.projectId)).toEqual([ATLAS.id]);
    expect(coverage.copies.find((c) => c.machine === REMOTE)).toMatchObject({ projectId: 'remote-atlas', state: 'verified' });
    expect(coverage).toMatchObject({ localUnknown: false, complete: true });
  });

  it('does not cover an unlinked project when the host is connected to say so', async () => {
    const coverage = await describeCoverage(replica());
    expect(coverage.copies.some((c) => c.thisComputer)).toBe(false);
    expect(coverage.localUnknown).toBe(false);
  });

  it('is unknown, not "not covered", while the host is offline and no link is known', async () => {
    fx.satellites = [sat({ state: 'disconnected' })];
    const coverage = await describeCoverage(replica());
    expect(coverage).toMatchObject({ localUnknown: true, complete: false });
  });

  it('keeps a known link covering while the host is offline', async () => {
    fx.satellites = [sat({ state: 'disconnected' })];
    link([REMOTE, 'remote-atlas'], [SELF, ATLAS.id]);
    const coverage = await describeCoverage(replica());
    expect(coverage.copies.filter((c) => c.thisComputer).map((c) => c.projectId)).toEqual([ATLAS.id]);
    expect(coverage.localUnknown).toBe(false);
  });

  it('offers a link for a repository match and never covers it', async () => {
    fx.repoKeys = { [ATLAS.id]: 'git:acme/atlas', [OTHER.id]: 'git:acme/other' };
    const coverage = await describeCoverage(replica());
    expect(coverage.repositoryMatches).toEqual([{ projectId: ATLAS.id, name: 'Atlas' }]);
    expect(coverage.copies.some((c) => c.thisComputer)).toBe(false);
  });

  it('stops offering once linked, and respects a pair the person kept separate', async () => {
    fx.repoKeys = { [ATLAS.id]: 'git:acme/atlas' };
    link([REMOTE, 'remote-atlas'], [SELF, ATLAS.id]);
    expect((await describeCoverage(replica())).repositoryMatches).toEqual([]);
    fx.linkGroups = [];
    fx.records = [{ projects: [{ machine: REMOTE, projectId: 'remote-atlas' }, { machine: SELF, projectId: ATLAS.id }], linked: false }];
    expect((await describeCoverage(replica())).repositoryMatches).toEqual([]);
  });

  it('offers nothing when the host\'s repository can\'t be read', async () => {
    fx.repoKeys = { [ATLAS.id]: 'git:acme/atlas' };
    fx.satellites = [sat({ snapshot: snapshot([{ id: 'remote-atlas', name: 'Atlas', repoKey: undefined as unknown as string }]) })];
    expect((await describeCoverage(replica())).repositoryMatches).toEqual([]);
  });

  it('is unknown with no host machine on record', async () => {
    expect(await describeCoverage(replica({ host: undefined }))).toMatchObject({ localUnknown: true, complete: false });
  });
});

describe('one rule for the directory, Members and the create preview', () => {
  it('previews a scope with the same copies the created group will show', async () => {
    link([SELF, ATLAS.id], [REMOTE, 'remote-atlas']);
    const scope = { level: 'project', projectId: ATLAS.id, reach: 'network' } as const;
    const preview = await previewCoverage(scope);
    const real = await describeCoverage(gp({ scope }));
    expect({ ...preview, groupProjectId: '' }).toEqual({ ...real, groupProjectId: '' });
  });

  it('lists coverage for every group in one read, changing no group', async () => {
    fx.groups = [gp(), replica()];
    link([SELF, ATLAS.id], [REMOTE, 'remote-atlas']);
    const list = await listCoverage();
    expect(list.map((c) => c.groupProjectId)).toEqual(['g1', 'g-replica']);
    expect(fx.groups).toHaveLength(2);
  });

  it('judges agents and coverage by the same copy check', () => {
    const sats = [sat()] as Parameters<typeof verifyCopy>[1];
    expect(verifyCopy({ machine: REMOTE, projectId: 'remote-atlas' }, sats, () => true).verified).toBe(true);
    expect(verifyCopy({ machine: REMOTE, projectId: 'remote-atlas' }, sats, () => false).verified).toBe(false);
  });
});

describe('computeCoverage', () => {
  it('is pure over its inputs: no self means nothing is verified for a copy', () => {
    const inputs: CoverageInputs = {
      groupProjectId: 'g', scope: { level: 'project', projectId: 'x', reach: 'network' }, replica: true, host: REMOTE, self: null,
      isMember: () => true, projects: [], satellites: [], repoKeys: {},
    };
    expect(computeCoverage(inputs)).toMatchObject({ localUnknown: true, complete: false, copies: [] });
  });
});
