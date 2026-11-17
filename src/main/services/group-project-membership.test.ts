/**
 * Group project membership (#3357): a record on the host, with auto-join,
 * exclusions, explicit helpers and ephemeral quick agents. Bindings are
 * derived from it through a pruning persisted-binding source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { DurableAgentConfig } from '../../shared/types';
import type { GroupProject } from '../../shared/group-project-types';

const fx = vi.hoisted(() => ({
  home: '',
  projects: [] as Array<{ id: string; name: string; path: string }>,
  configs: new Map<string, DurableAgentConfig[]>(),
  quick: new Map<string, { agentId: string; name: string; projectPath: string; startedAt: number; finishedAt?: number }>(),
  canvasWires: [] as Array<Record<string, unknown>>,
  canvasUnreadable: false,
  linkGroups: [] as Array<Array<{ machine: string; projectId: string }>>,
  satellites: [] as Array<{ fingerprint: string; alias: string; state: string; snapshot: unknown; snapshotUnavailable?: boolean }>,
  linkChanged: null as null | (() => void),
  snapshotChanged: null as null | (() => void),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fx.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({
  list: vi.fn(async () => fx.projects),
  onProjectsChanged: vi.fn(() => () => undefined),
}));
vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (projectPath: string) => fx.configs.get(projectPath) ?? []),
  onAgentConfigChanged: vi.fn(() => () => undefined),
}));
vi.mock('./project-links-store', () => ({ projectLinksStore: () => ({
  groups: () => fx.linkGroups,
  onChange: (fn: (change: { recordsChanged: boolean }) => void) => { fx.linkChanged = () => fn({ recordsChanged: true }); return () => { fx.linkChanged = null; }; },
}) }));
vi.mock('./project-links-network', () => ({ projectLinksSyncedWith: () => true }));
vi.mock('./annex-client', () => ({
  getSatellites: () => fx.satellites,
  onSatelliteSnapshot: (fn: () => void) => { fx.snapshotChanged = fn; return () => { fx.snapshotChanged = null; }; },
}));
vi.mock('./quick-agent-events', () => ({ knownQuickAgents: () => fx.quick }));
// Every Canvas store, read strictly for migration.
vi.mock('./canvas-store-reader', () => ({
  readAllCanvasStores: async () => fx.canvasUnreadable
    ? [{ location: { scope: 'project', projectId: 'proj_b', projectName: 'Beta', projectPath: 'x', kvDir: 'x' }, canvases: null, wires: null, problems: ['Project folder is unavailable: ENOENT'] }]
    : [],
}));
vi.mock('./canvas-wire-source', () => ({
  canvasWireBindingSource: {
    id: 'canvas-wires',
    collect: async () => fx.canvasWires,
    inspect: async () => {
      if (fx.canvasUnreadable) throw new Error('Some Canvas guidance could not be read.');
      return fx.canvasWires;
    },
  },
}));
import { _resetAllBoardsForTesting, flushAllBulletinBoards } from './group-project-bulletin';

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { listDurable } from './agent-config';
import {
  _resetPersistedBindingSourcesForTesting, keepHeldBinding, markBindingRemovedByUser, rebuildPersistedBindings, registerPersistedBindingSource,
} from './persisted-bindings';
import { groupProjectRegistry } from './group-project-registry';
import { groupProjectHost } from './group-project-host';
import * as coverageService from './group-project-coverage';
import { listCoverage } from './group-project-coverage';
import { initGroupProjectLifecycle, _resetLifecycleForTesting } from './group-project-lifecycle';
import { roleModeOf, setGroupProjectRole } from './group-project-roles';
import {
  _resetMembershipForTesting, addMember, answerAutoJoinOffer, beginAutoJoin, previewAutoJoin, describeMembership, excludeMember, membershipBindingSource,
  releaseMembershipBindings, onMembershipChanged, setAutomaticMembership, confirmUnlinkedMembers, quickMemberName, memberPolicyKey, reconcileMembership, recordMemberDisabledTools, savedMemberDisabledTools, watchGroupProjectMembership,
} from './group-project-membership';

const PROJ_A = { id: 'proj_a', name: 'Alpha', path: path.join('work', 'alpha') };
const PROJ_B = { id: 'proj_b', name: 'Beta', path: path.join('work', 'beta') };

function agent(id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name: id, color: 'emerald', createdAt: '2026-01-01T00:00:00.000Z', ...extra } as DurableAgentConfig;
}

function gp(id: string, extra: Partial<GroupProject> = {}): GroupProject {
  return {
    id, name: `GP ${id}`, description: '', instructions: '', metadata: {},
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    scope: { level: 'project', projectId: PROJ_A.id, reach: 'local' },
    ...extra,
  };
}

/** A group project from before this launch: its record has to be migrated. */
function legacyGp(id: string, extra: Partial<GroupProject> = {}): GroupProject {
  return gp(id, { createdAt: '2025-01-01T00:00:00.000Z', ...extra });
}

const membersOf = (gpId: string) => bindingManager.getAllBindings()
  .filter((b) => b.targetKind === 'group-project' && b.targetId === gpId).map((b) => b.agentId).sort();

/** Start (or restart) the app's membership: register the source and run the first rebuild. */
async function start(): Promise<void> {
  registerPersistedBindingSource(membershipBindingSource);
  await rebuildPersistedBindings();
  // Migration runs after the first complete rebuild.
  await vi.waitFor(async () => {
    for (const p of await groupProjectRegistry.list()) {
      const m = await getMembership(p.id);
      expect(m.membershipPolicy === 'project-3546' || m.autoJoin || m.autoJoinOffer !== undefined).toBe(true);
    }
  });
  await reconcileMembership();
}

/** Lose every in-memory state, as quitting the app does; files stay. */
function restart(): void {
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
  _resetMembershipForTesting();
  groupProjectHost._resetForTesting();
}

const getMembership = (id: string) => groupProjectHost.getMembership(id);
const updateMembership: typeof groupProjectHost.updateMembership = (id, fn) => groupProjectHost.updateMembership(id, fn);

beforeEach(async () => {
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  fx.home = await fsp.mkdtemp(path.join(cache, 'gp-membership-'));
  fx.projects = [PROJ_A, PROJ_B];
  fx.configs = new Map([
    [PROJ_A.path, [agent('lead'), agent('dev'), agent('helper1', { parentAgentId: 'lead' }), agent('gone', { disposedAt: '2026-01-02T00:00:00.000Z' } as Partial<DurableAgentConfig>)]],
    [PROJ_B.path, [agent('other')]],
  ]);
  fx.quick = new Map();
  fx.canvasWires = [];
  fx.canvasUnreadable = false;
  fx.linkGroups = []; fx.satellites = []; fx.linkChanged = null; fx.snapshotChanged = null;
  groupProjectRegistry._resetForTesting();
  restart();
});

afterEach(async () => {
  await flushAllBulletinBoards();
  _resetAllBoardsForTesting();
  restart();
  groupProjectRegistry._resetForTesting();
  await fsp.rm(fx.home, { recursive: true, force: true });
});

describe('auto-join', () => {
  it('does not steal an existing inbox when a same-name suffix matches another member name', async () => {
    groupProjectRegistry._setForTesting(gp('gp_collision'));
    const suffix = createHash('sha256').update('third').digest('hex').slice(0, 6);
    fx.configs.set(PROJ_A.path, [agent('first', { name: 'Twin' }), agent('second', { name: `Twin-${suffix}` })]);
    await updateMembership('gp_collision', d => { d.membershipPolicy = 'project-3546'; d.autoJoin = true; });
    await start();
    const existing = await groupProjectHost.inboxFor('gp_collision', `Twin-${suffix}`, 'second');
    fx.configs.get(PROJ_A.path)!.push(agent('third', { name: 'Twin' }));
    await reconcileMembership();
    const added = await groupProjectHost.inboxFor('gp_collision', 'Twin', 'third');
    const { getBulletinBoard } = await import('./group-project-bulletin');
    expect(await getBulletinBoard('gp_collision').inboxOwner(existing)).toBe('second');
    expect(added).not.toBe(existing);
  });

  it.each(['excluded', 'removed', 'disposed'])('does not seed a member %s after the reconcile snapshot but before admission commits', async change => {
    groupProjectRegistry._setForTesting(gp('gp_exclude_race'));
    fx.configs.set(PROJ_A.path, []);
    await updateMembership('gp_exclude_race', d => { d.membershipPolicy = 'project-3546'; d.autoJoin = true; });
    await start();
    fx.configs.set(PROJ_A.path, [agent('late')]);
    const admit = groupProjectHost.ensureMemberAdmissions.bind(groupProjectHost);
    const spy = vi.spyOn(groupProjectHost, 'ensureMemberAdmissions').mockImplementationOnce(async (id, candidates) => {
      const address = candidates[0].address;
      if (change === 'excluded') await updateMembership(id, d => { d.excluded.push({ address, excludedAt: new Date().toISOString() }); });
      else fx.configs.set(PROJ_A.path, change === 'removed' ? [] : [agent(address, { disposedAt: '2026-01-01' } as Partial<DurableAgentConfig>)]);
      await admit(id, candidates);
    });
    try {
      await reconcileMembership();
      expect((await describeMembership('gp_exclude_race')).members).toHaveLength(0);
      expect(await groupProjectHost.readTopic('gp_exclude_race', 'inbox-late')).toHaveLength(0);
      expect(await groupProjectHost.readTopic('gp_exclude_race', 'system')).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });

  it('a new group project includes every top-level durable agent in scope, with no wires', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
    const view = await describeMembership('gp1');
    expect(view.managed).toBe(true);
    expect(view.members.every((m) => m.via === 'auto' && m.kind === 'durable')).toBe(true);
  });

  it('seeds restored automatic and explicit remote admission once, separating same names', async () => {
    const remote = 'remote@' + Array(32).fill('bb').join(':');
    groupProjectRegistry._setForTesting(gp('gp_admit'));
    fx.configs.set(PROJ_A.path, [agent('local', { name: 'Twin' }), agent('excluded'), agent('disposed', { disposedAt: '2026-01-01' } as Partial<DurableAgentConfig>)]);
    await updateMembership('gp_admit', d => {
      d.membershipPolicy = 'project-3546'; d.autoJoin = true;
      d.excluded.push({ address: 'excluded', excludedAt: new Date().toISOString() });
      d.explicit.push({ address: remote, kind: 'durable', name: 'Twin', addedAt: new Date().toISOString() });
    });
    await start();
    const first = await groupProjectHost.inboxFor('gp_admit', 'Twin', 'local');
    const second = await groupProjectHost.inboxFor('gp_admit', 'Twin', remote);
    expect(first).not.toBe(second);
    expect(await groupProjectHost.readTopic('gp_admit', first)).toHaveLength(1);
    expect(await groupProjectHost.readTopic('gp_admit', second)).toHaveLength(1);
    expect(await groupProjectHost.readTopic('gp_admit', 'system')).toHaveLength(2);
    const seq = (await groupProjectHost.get('gp_admit'))!.seq;
    const board = await groupProjectHost.readAll('gp_admit');
    await reconcileMembership();
    await reconcileMembership();
    expect((await groupProjectHost.get('gp_admit'))!.seq).toBe(seq);
    expect(await groupProjectHost.readAll('gp_admit')).toEqual(board);
    await updateMembership('gp_admit', d => { d.excluded.push({ address: 'local', excludedAt: new Date().toISOString() }); });
    await reconcileMembership();
    await updateMembership('gp_admit', d => { d.excluded = d.excluded.filter(e => e.address !== 'local'); });
    await reconcileMembership();
    // Admission is once per address over the board's lifetime, including a re-add.
    expect(await groupProjectHost.readTopic('gp_admit', 'system')).toHaveLength(2);
    restart();
    await start();
    expect(await groupProjectHost.readTopic('gp_admit', 'system')).toHaveLength(2);
  });

  it('startup reconciliation repairs managed admissions and stays read-only on a later startup', async () => {
    groupProjectRegistry._setForTesting(gp('gp_startup'));
    await updateMembership('gp_startup', d => { d.membershipPolicy = 'project-3546'; d.autoJoin = true; });
    registerPersistedBindingSource(membershipBindingSource);
    await rebuildPersistedBindings();
    // No explicit reconcile: afterRebuild must repair an already-managed group.
    await vi.waitFor(async () => expect(await groupProjectHost.readTopic('gp_startup', 'system')).toHaveLength(2));
    await groupProjectHost.flushBoards();
    restart();
    // Recreate baseline restored bindings before observing the extra startup reconcile.
    await membershipBindingSource.collect();
    for (const agentId of ['dev', 'lead']) bindingManager.bind(agentId, { targetId: 'gp_startup', targetKind: 'group-project', label: 'Startup' });
    const before = (await groupProjectHost.get('gp_startup'))!.seq;
    const board = await groupProjectHost.readAll('gp_startup');
    const bind = vi.spyOn(bindingManager, 'bind');
    const unbind = vi.spyOn(bindingManager, 'unbind');
    const admit = vi.spyOn(groupProjectHost, 'ensureMemberAdmissions');
    const commit = vi.spyOn(groupProjectHost as unknown as { commit: (...args: unknown[]) => unknown }, 'commit');
    membershipBindingSource.afterRebuild!(true);
    await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(1));
    // Wait for the async final read checks, including tidy, to finish.
    await reconcileMembership();
    expect(bind).not.toHaveBeenCalled(); expect(unbind).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect((await groupProjectHost.get('gp_startup'))!.seq).toBe(before);
    expect(await groupProjectHost.readAll('gp_startup')).toEqual(board);
    vi.restoreAllMocks();
  });

  it.each([250, 2005])('batches %i automatic admissions into one commit and summary', async count => {
    groupProjectRegistry._setForTesting(gp('gp_bulk'));
    fx.configs.set(PROJ_A.path, Array.from({ length: count }, (_, i) => agent(`member_${i}`)));
    await updateMembership('gp_bulk', d => { d.membershipPolicy = 'project-3546'; d.autoJoin = true; });
    await membershipBindingSource.collect();
    const seqBefore = (await groupProjectHost.get('gp_bulk'))!.seq!;
    const commit = vi.spyOn(groupProjectHost as unknown as { commit: (...args: unknown[]) => unknown }, 'commit');
    const begin = performance.now();
    await Promise.all([reconcileMembership(), reconcileMembership()]);
    const elapsed = performance.now() - begin;
    const boardCommits = commit.mock.calls.filter(args => args[1] === 'board').length;
    const joins = await groupProjectHost.readTopic('gp_bulk', 'system', undefined, count + 10);
    process.stdout.write(JSON.stringify({ admissionCount: count, elapsedMs: Math.round(elapsed), boardCommits, sequenceChanges: (await groupProjectHost.get('gp_bulk'))!.seq! - seqBefore, joinPosts: joins.length }) + '\n');
    expect(boardCommits).toBe(1);
    expect(joins).toEqual([expect.objectContaining({ body: `${count} agents joined project "GP gp_bulk"` })]);
    expect((await groupProjectHost.readDigest('gp_bulk')).filter(t => t.topic.startsWith('inbox-'))).toHaveLength(count);
    commit.mockRestore();
  });

  it('a new app group starts empty', async () => {
    groupProjectRegistry._setForTesting(gp('gp1', { scope: { level: 'app', reach: 'local' } }));
    await start();
    expect(membersOf('gp1')).toEqual([]);
    expect((await getMembership('gp1')).autoJoin).toBe(false);
  });

  it.each(['adopt', 'initialize'])('keeps linked computers off for a network app group via %s', async (method) => {
    groupProjectRegistry._setForTesting(gp('gp_app', { scope: { level: 'app', reach: 'network' } }));
    if (method === 'initialize') await beginAutoJoin('gp_app');
    else await start();
    expect(await getMembership('gp_app')).toMatchObject({ autoJoin: false, includeLinkedComputers: false });
  });

  it('a durable agent created later in scope joins; one leaving scope leaves', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    fx.configs.get(PROJ_A.path)!.push(agent('newbie'));
    await reconcileMembership();
    expect(membersOf('gp1')).toEqual(['dev', 'lead', 'newbie']);

    fx.configs.set(PROJ_A.path, fx.configs.get(PROJ_A.path)!.filter((a) => a.id !== 'dev'));
    await reconcileMembership();
    expect(membersOf('gp1')).toEqual(['lead', 'newbie']);
  });

  it('an excluded agent stays out across restarts, and including it again makes it a member', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    await excludeMember('gp1', 'dev');
    expect(membersOf('gp1')).toEqual(['lead']);

    restart();
    await start();
    expect(membersOf('gp1')).toEqual(['lead']);
    expect((await describeMembership('gp1')).excluded.map((e) => e.agentId)).toEqual(['dev']);

    await addMember('gp1', 'dev');
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
    expect((await getMembership('gp1')).excluded).toEqual([]);
  });
});

describe('helpers and quick agents', () => {
  it('are never auto-joined', async () => {
    fx.quick.set('quick_abcd', { agentId: 'quick_abcd', name: 'swift-fox', projectPath: PROJ_A.path, startedAt: 1 });
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
  });

  it('a helper joins only when added, and leaves when disposed', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    await addMember('gp1', 'helper1');
    expect(membersOf('gp1')).toEqual(['dev', 'helper1', 'lead']);
    expect((await describeMembership('gp1')).members.find((m) => m.agentId === 'helper1')).toMatchObject({ kind: 'helper', via: 'explicit' });

    const helper = fx.configs.get(PROJ_A.path)!.find((a) => a.id === 'helper1')!;
    (helper as DurableAgentConfig & { disposedAt?: string }).disposedAt = '2026-02-01T00:00:00.000Z';
    await reconcileMembership();
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
    expect((await getMembership('gp1')).explicit).toEqual([]);
  });

  it('a quick agent is a member for its run only', async () => {
    fx.quick.set('quick_abcd', { agentId: 'quick_abcd', name: 'swift-fox', projectPath: PROJ_A.path, startedAt: 1 });
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    await addMember('gp1', 'quick_abcd');
    expect(membersOf('gp1')).toContain('quick_abcd');

    fx.quick.get('quick_abcd')!.finishedAt = 2;
    await reconcileMembership();
    expect(membersOf('gp1')).not.toContain('quick_abcd');
    expect((await getMembership('gp1')).explicit).toEqual([]);
  });

  it('two quick agents with the same name get different member names and inboxes (#1646)', async () => {
    fx.quick.set('quick_aaaa', { agentId: 'quick_aaaa', name: 'swift-fox', projectPath: PROJ_A.path, startedAt: 1 });
    fx.quick.set('quick_bbbb', { agentId: 'quick_bbbb', name: 'swift-fox', projectPath: PROJ_A.path, startedAt: 1 });
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    await addMember('gp1', 'quick_aaaa');
    await addMember('gp1', 'quick_bbbb');
    const names = bindingManager.getAllBindings().filter((b) => b.agentId.startsWith('quick_')).map((b) => b.agentName);
    expect(names).toEqual([quickMemberName('swift-fox', 'quick_aaaa'), quickMemberName('swift-fox', 'quick_bbbb')]);
    expect(new Set(names).size).toBe(2);
  });

  it('a quick entry left in the record by a restart does not come back', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await updateMembership('gp1', (d) => {
      d.autoJoin = true;
      d.explicit.push({ address: 'quick_old', kind: 'quick', addedAt: 'x', runId: 'quick_old:1' });
    });
    await start();
    expect(membersOf('gp1')).not.toContain('quick_old');
  });
});

describe('migration', () => {
  it('keeps every current member, adds none, and offers auto-join once', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_old'));
    // Today's members: wires from a canvas (any source that bound them).
    bindingManager.bind('lead', { targetId: 'gp_old', targetKind: 'group-project', label: 'GP gp_old', agentName: 'lead' });
    bindingManager.bind('helper1', { targetId: 'gp_old', targetKind: 'group-project', label: 'GP gp_old', agentName: 'helper1' });
    await start();

    const record = await getMembership('gp_old');
    expect(record.autoJoin).toBe(false);
    expect(record.autoJoinOffer).toBe('pending');
    expect(record.explicit.map((e) => [e.address, e.kind])).toEqual([['lead', 'durable'], ['helper1', 'helper']]);
    expect(membersOf('gp_old')).toEqual(['helper1', 'lead']);

    const view = await describeMembership('gp_old');
    expect(view.autoJoinOffer?.wouldJoin.map((m) => m.agentId)).toEqual(['dev']);

    await answerAutoJoinOffer('gp_old', true);
    expect(membersOf('gp_old')).toEqual(['dev', 'helper1', 'lead']);
    expect((await getMembership('gp_old')).autoJoinOffer).toBe('accepted');
  });

  it('keeps a customized wire\'s tool switches and instructions across a second restart', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_old'));
    // A canvas wire with its own switches and instructions, bound at startup.
    fx.canvasWires = [{
      agentId: 'lead', targetId: 'gp_old', targetKind: 'group-project', label: 'GP gp_old', agentName: 'lead',
      disabledTools: ['broadcast', 'shoulder_tap'], instructions: { post_bulletin: 'Post in #release only' },
    }];
    bindingManager.bind('lead', { targetId: 'gp_old', targetKind: 'group-project', label: 'GP gp_old', agentName: 'lead' });
    bindingManager.setDisabledTools('lead', 'gp_old', ['broadcast', 'shoulder_tap']);
    await start();
    const record = await getMembership('gp_old');
    expect(record.disabledTools?.lead).toEqual(['broadcast', 'shoulder_tap']);
    expect(record.instructions?.lead).toEqual({ post_bulletin: 'Post in #release only' });

    // Second restart: the canvas no longer holds the wire; the record does.
    restart();
    await start();
    const binding = bindingManager.getBindingsForAgent('lead').find((b) => b.targetId === 'gp_old');
    expect(binding?.disabledTools).toEqual(['broadcast', 'shoulder_tap']);
    expect(binding?.instructions).toEqual({ post_bulletin: 'Post in #release only' });
  });

  it('includes members whose wire is only in a Canvas store, not bound', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_old'));
    fx.canvasWires = [{ agentId: 'dev', targetId: 'gp_old', targetKind: 'group-project', label: 'GP gp_old', agentName: 'dev' }];
    await start();
    expect((await getMembership('gp_old')).explicit.map((e) => e.address)).toEqual(['dev']);
  });

  it('leaves a legacy group project on its wires while a Canvas store cannot be read', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_old'));
    fx.canvasUnreadable = true;
    registerPersistedBindingSource(membershipBindingSource);
    await rebuildPersistedBindings();
    await vi.waitFor(async () => expect((await describeMembership('gp_old')).deferred).toContain('the folder of project “Beta” is missing'));
    expect((await describeMembership('gp_old')).managed).toBe(false);

    // Repaired: the next rebuild migrates.
    fx.canvasUnreadable = false;
  fx.linkGroups = []; fx.satellites = []; fx.linkChanged = null; fx.snapshotChanged = null;
    await rebuildPersistedBindings();
    await vi.waitFor(async () => expect((await describeMembership('gp_old')).managed).toBe(true));
  });

  it('dismissing the offer adds no one', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_old'));
    await start();
    await answerAutoJoinOffer('gp_old', false);
    expect(membersOf('gp_old')).toEqual([]);
    expect((await describeMembership('gp_old')).autoJoinOffer?.state).toBe('dismissed');
  });
});

describe('exclusions and preview', () => {
  it('records an exclusion even when the agent\'s project cannot be read', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    vi.mocked(listDurable).mockRejectedValueOnce(new Error('agents.json unreadable'));
    await excludeMember('gp1', 'dev');
    expect((await getMembership('gp1')).excluded.map((e) => e.address)).toEqual(['dev']);
  });

  it('previews who would auto-join a scope, and which projects could not be read', async () => {
    fx.configs.delete(PROJ_B.path);
    vi.mocked(listDurable).mockImplementation(async (p: string) => {
      if (p === PROJ_B.path) throw new Error('unreadable');
      return fx.configs.get(p) ?? [];
    });
    const app = await previewAutoJoin({ level: 'app', reach: 'local' });
    expect(app.wouldJoin).toEqual([]);
    expect(app.unreadableProjects).toEqual([]);
    const project = await previewAutoJoin({ level: 'project', projectId: PROJ_A.id, reach: 'local' });
    expect(project.unreadableProjects).toEqual([]);
    // Shape-checked like creation: unknown levels and unregistered projects are refused.
    await expect(previewAutoJoin({ level: 'galaxy', reach: 'local' })).rejects.toThrow(/project or app/);
    await expect(previewAutoJoin({ level: 'project', projectId: 'nope', reach: 'local' })).rejects.toThrow(/registered project/);
    vi.mocked(listDurable).mockImplementation(async (p: string) => fx.configs.get(p) ?? []);
  });
});

describe('lead and admin end with membership (#3360)', () => {
  afterEach(() => _resetLifecycleForTesting());

  it('an excluded lead loses lead and admin, and doesn\'t get them back by rejoining', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    // The lifecycle sees the members join at startup, then dev leave.
    initGroupProjectLifecycle();
    await start();
    await setGroupProjectRole('gp1', 'dev', 'lead', 'allow');
    await setGroupProjectRole('gp1', 'dev', 'admin', 'ask');

    await excludeMember('gp1', 'dev');
    await vi.waitFor(() => expect([roleModeOf('dev', 'gp1', 'lead'), roleModeOf('dev', 'gp1', 'admin')]).toEqual(['off', 'off']));

    await addMember('gp1', 'dev');
    expect(membersOf('gp1')).toContain('dev');
    expect(roleModeOf('dev', 'gp1', 'lead')).toBe('off');
  });

  it('a lead that leaves scope loses its roles; one that stays keeps them', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    initGroupProjectLifecycle();
    await start();
    await setGroupProjectRole('gp1', 'dev', 'lead', 'allow');
    await setGroupProjectRole('gp1', 'lead', 'lead', 'allow');

    fx.configs.set(PROJ_A.path, fx.configs.get(PROJ_A.path)!.filter((a) => a.id !== 'dev'));
    await reconcileMembership();
    await vi.waitFor(() => expect(roleModeOf('dev', 'gp1', 'lead')).toBe('off'));
    expect(roleModeOf('lead', 'gp1', 'lead')).toBe('allow');
  });
});

describe('a copy of a group project hosted on another machine (#3363)', () => {
  const SELF = 'aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa';
  const HOST = 'bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb';
  const shared = { scope: { level: 'app', reach: 'network' } } as Partial<GroupProject>;
  const remote = (id: string) => gp(id, { createdAt: '2025-01-01T00:00:00.000Z', host: { machine: HOST }, ...shared } as Partial<GroupProject>);

  /** A copy as a sync leaves it: the host's membership record, under a record whose host is the other computer. */
  async function seedCopy(id: string, fill: (d: Parameters<Parameters<typeof updateMembership>[1]>[0]) => void): Promise<void> {
    groupProjectRegistry._setForTesting(gp(id, { createdAt: '2025-01-01T00:00:00.000Z', ...shared }));
    await updateMembership(id, fill);
    groupProjectRegistry._setForTesting(remote(id));
  }

  it('binds only this machine\'s agents the record lists, and never auto-joins or tidies from here', async () => {
    // The host's record: its own agents (bare ids), one of this machine's, and one gone from here.
    await seedCopy('gp_remote', (d) => {
      d.autoJoin = true;
      d.explicit.push(
        { address: 'lead', kind: 'durable', addedAt: 'x' },
        { address: `dev@${SELF}`, kind: 'durable', addedAt: 'x' },
        { address: `ghost@${SELF}`, kind: 'helper', addedAt: 'x' },
      );
    });
    vi.spyOn(groupProjectHost, 'selfMachine').mockReturnValue(SELF);
    await start();
    // 'lead' here is a different agent from the host's 'lead': not bound; this machine's dev is.
    expect(membersOf('gp_remote')).toEqual(['dev']);
    // Nothing removed because this machine doesn't know 'ghost', and no auto-join from local agents.
    expect((await groupProjectHost.getMembership('gp_remote')).explicit.map((e) => e.address)).toEqual(['lead', `dev@${SELF}`, `ghost@${SELF}`]);
    vi.restoreAllMocks();
  });

  it('keys a member\'s own entries by its host-relative address (#3516)', async () => {
    vi.spyOn(groupProjectHost, 'selfMachine').mockReturnValue(SELF);
    // On a copy this machine's agents are `id@<self>`.
    expect(memberPolicyKey(remote('gp_remote'), 'dev')).toBe(`dev@${SELF}`);
    expect(memberPolicyKey(remote('gp_remote'), `dev@${SELF}`)).toBe(`dev@${SELF}`);
    // On the host its own agents are bare ids, however they are named.
    expect(memberPolicyKey(gp('gp_here', shared), 'dev')).toBe('dev');
    expect(memberPolicyKey(gp('gp_here', shared), `dev@${SELF}`)).toBe('dev');
    vi.restoreAllMocks();
  });

  it('sends an addition from here to the host with this machine\'s address', async () => {
    await seedCopy('gp_remote', (d) => { d.autoJoin = true; });
    vi.spyOn(groupProjectHost, 'selfMachine').mockReturnValue(SELF);
    const sent: unknown[] = [];
    groupProjectHost.setNetworkLink({
      connected: () => true, isMember: () => true, machineName: () => 'Desk',
      sync: async () => ({ v: 1, projects: [], unchanged: ['gp_remote'], tombstones: [] }),
      sendWrites: async (_machine, writes) => {
        sent.push(...writes);
        return { v: 1, results: writes.map((w) => ({ id: w.id, status: 'applied' as const, seq: 2 })) };
      },
    });
    await start();
    await addMember('gp_remote', 'dev');
    expect(sent).toEqual([expect.objectContaining({
      groupProjectId: 'gp_remote',
      write: { op: 'membership', patch: expect.objectContaining({ addExplicit: [expect.objectContaining({ address: `dev@${SELF}`, kind: 'durable' })] }) },
    })]);
    vi.restoreAllMocks();
  });
});

describe('bindings follow the record', () => {
  it('after a restart the bindings are exactly the record\'s members', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    await addMember('gp1', 'helper1');
    await excludeMember('gp1', 'lead');
    const before = membersOf('gp1');

    restart();
    await start();
    expect(membersOf('gp1')).toEqual(before);
    expect(before).toEqual(['dev', 'helper1']);
  });

  it('canvas cleanup keeps a member\'s binding: the record holds it', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    expect(keepHeldBinding('lead', 'gp1')).toBe(true);
  });

  it('a member\'s tool switches survive a restart (#2084)', async () => {
    groupProjectRegistry._setForTesting(gp('gp1', { metadata: { defaultDisabledTools: ['broadcast'] } }));
    await start();
    expect(bindingManager.getBindingsForAgent('dev').find((b) => b.targetId === 'gp1')?.disabledTools).toEqual(['broadcast']);

    // "Apply to all" saves each member's list.
    await recordMemberDisabledTools('gp1', 'dev', ['shoulder_tap']);
    await recordMemberDisabledTools('gp1', 'lead', ['shoulder_tap']);
    restart();
    await start();
    expect(bindingManager.getBindingsForAgent('dev').find((b) => b.targetId === 'gp1')?.disabledTools).toEqual(['shoulder_tap']);
    expect(await savedMemberDisabledTools('gp1', 'lead')).toEqual(['shoulder_tap']);
  });

  it('a user-removed pair comes back only when added again', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    bindingManager.unbind('dev', 'gp1');
    markBindingRemovedByUser('dev', 'gp1');
    await excludeMember('gp1', 'dev');
    expect(membersOf('gp1')).toEqual(['lead']);
    await addMember('gp1', 'dev');
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
  });

  it('releasing a deleted group project\'s bindings needs no store access (#3364)', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    releaseMembershipBindings('gp1');
    expect(membersOf('gp1')).toEqual([]);
  });

  it('a host delete releases the members', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    const stop = watchGroupProjectMembership();
    await groupProjectHost.delete('gp1');
    expect(membersOf('gp1')).toEqual([]);
    stop();
  });

  it('answers the host\'s member resolver with the record\'s members', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    const stop = watchGroupProjectMembership();
    await excludeMember('gp1', 'dev');
    expect(await groupProjectHost.resolveMembers('gp1')).toEqual([{ address: 'lead', name: 'lead', projectId: PROJ_A.id }]);
    stop();
  });
});

describe('scope decides explicit adds (#3355)', () => {
  it('refuses to add an agent from another project, for a person or an agent, and keeps a scope exclusion', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    await expect(addMember('gp1', 'other')).rejects.toMatchObject({ code: 'out_of_scope', message: expect.stringContaining('Widen the scope') });
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
    await updateMembership('gp1', (m) => { m.excluded.push({ address: 'other', excludedAt: '2026-11-13T00:00:00.000Z', reason: 'scope' }); });
    await expect(addMember('gp1', 'other')).rejects.toMatchObject({ code: 'out_of_scope' });
    expect((await getMembership('gp1')).excluded.map((e) => e.address)).toEqual(['other']);
  });

  it('refuses a quick agent whose project is outside, and admits one inside', async () => {
    fx.quick.set('quick_b', { agentId: 'quick_b', name: 'far-fox', projectPath: PROJ_B.path, startedAt: 1 });
    fx.quick.set('quick_a', { agentId: 'quick_a', name: 'near-fox', projectPath: PROJ_A.path, startedAt: 1 });
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    await expect(addMember('gp1', 'quick_b')).rejects.toMatchObject({ code: 'out_of_scope' });
    await addMember('gp1', 'quick_a');
    expect(membersOf('gp1')).toContain('quick_a');
  });
});



describe('project membership controls (#3546)', () => {
  it('defaults project groups on, respects off at creation, and keeps creation exclusions', async () => {
    const on = await groupProjectHost.create('On', { projectId: PROJ_A.id });
    const off = await groupProjectHost.create('Off', { projectId: PROJ_A.id, membership: { autoJoin: false, includeLinkedComputers: false } });
    const excluded = await groupProjectHost.create('Excluded', { projectId: PROJ_A.id, membership: { autoJoin: true, includeLinkedComputers: false, excluded: ['dev'] } });
    await start();
    expect(membersOf(on.id)).toEqual(['dev', 'lead']);
    expect(membersOf(off.id)).toEqual([]);
    expect(membersOf(excluded.id)).toEqual(['lead']);
    fx.configs.get(PROJ_A.path)!.push(agent('later'));
    await reconcileMembership();
    expect(membersOf(on.id)).toContain('later');
    expect(membersOf(off.id)).toEqual([]);
    expect(membersOf(excluded.id)).toEqual(['later', 'lead']);
  });

  it('turning off keeps auto members explicit, never revives exclusions, and turning on includes later agents', async () => {
    groupProjectRegistry._setForTesting(gp('gp_controls'));
    await start();
    await excludeMember('gp_controls', 'dev');
    await setAutomaticMembership('gp_controls', { autoJoin: false, includeLinkedComputers: false });
    expect((await getMembership('gp_controls')).explicit).toEqual([expect.objectContaining({ address: 'lead', kind: 'durable' })]);
    expect(membersOf('gp_controls')).toEqual(['lead']);
    fx.configs.get(PROJ_A.path)!.push(agent('later'), agent('helperLater', { parentAgentId: 'lead' }));
    await reconcileMembership();
    expect(membersOf('gp_controls')).toEqual(['lead']);
    await setAutomaticMembership('gp_controls', { autoJoin: true, includeLinkedComputers: false });
    expect(membersOf('gp_controls')).toEqual(['later', 'lead']);
    expect((await getMembership('gp_controls')).excluded.map((e) => e.address)).toEqual(['dev']);
  });

  it('refuses to turn off while the scoped inventory is unreadable, even before bindings are restored', async () => {
    const group = await groupProjectHost.create('Unreadable', { projectId: PROJ_A.id });
    vi.mocked(listDurable).mockImplementationOnce(async () => { throw new Error('unreadable'); });
    await expect(setAutomaticMembership(group.id, { autoJoin: false, includeLinkedComputers: false })).rejects.toThrow(/could not be checked/);
    expect((await getMembership(group.id)).autoJoin).toBe(true);
  });

  it('turning on a migrated project group also answers its pending offer and keeps exclusions', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_old_controls'));
    await start();
    await excludeMember('gp_old_controls', 'lead');
    await setAutomaticMembership('gp_old_controls', { autoJoin: true, includeLinkedComputers: false });
    expect((await getMembership('gp_old_controls')).autoJoinOffer).toBe('accepted');
    expect(membersOf('gp_old_controls')).toEqual(['dev']);
    expect((await getMembership('gp_old_controls')).excluded.map((entry) => entry.address)).toEqual(['lead']);
  });

  it('leaves an existing app auto-join policy and existing explicit membership unchanged across restart', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_existing', { scope: { level: 'app', reach: 'local' } }));
    await updateMembership('gp_existing', (m) => { m.autoJoin = true; m.explicit.push({ address: 'helper1', kind: 'helper', addedAt: 'old' }); });
    const before = await getMembership('gp_existing');
    await start();
    expect(membersOf('gp_existing')).toEqual(['dev', 'helper1', 'lead', 'other']);
    restart(); await start();
    expect(await getMembership('gp_existing')).toEqual(before);
    fx.configs.get(PROJ_B.path)!.push(agent('new-in-old-policy'));
    await reconcileMembership();
    expect(membersOf('gp_existing')).toContain('new-in-old-policy');
  });

  it('rejects automatic membership changes on an app group and on a replica', async () => {
    groupProjectRegistry._setForTesting(gp('gp_app', { scope: { level: 'app', reach: 'local' } }));
    await expect(setAutomaticMembership('gp_app', { autoJoin: true, includeLinkedComputers: true })).rejects.toThrow(/project group/);
    groupProjectRegistry._setForTesting(gp('gp_copy', { host: { machine: REMOTE } }));
    const before = await getMembership('gp_copy');
    await expect(setAutomaticMembership('gp_copy', { autoJoin: true, includeLinkedComputers: true })).rejects.toThrow(/Only the host/);
    await expect(confirmUnlinkedMembers('gp_copy', [])).rejects.toThrow(/Only the host/);
    expect(await getMembership('gp_copy')).toEqual(before);
  });
});

const SELF = 'aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa:aa';
const REMOTE = 'bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb:bb';
const remoteAddress = (id: string) => `${id}@${REMOTE}`;
function remoteSnapshot(agents = [agent('remote'), agent('remote-helper', { parentAgentId: 'remote' })]) {
  return { projects: [{ id: 'remote_project', name: 'Remote Alpha', repositoryKey: 'same-repository' }],
    agents: { remote_project: agents }, quickAgents: { remote_project: [{ id: 'remote-quick', name: 'Quick' }] } };
}
async function linkedGroup() {
  vi.spyOn(groupProjectHost, 'selfMachine').mockReturnValue(SELF);
  vi.spyOn(groupProjectHost, 'isNetworkMember').mockReturnValue(true);
  vi.spyOn(groupProjectHost, 'scopeOptions').mockReturnValue({ network: { available: true } });
  fx.satellites = [{ fingerprint: REMOTE, alias: 'Laptop', state: 'connected', snapshot: remoteSnapshot() }];
  groupProjectRegistry._setForTesting(gp('gp_linked', { host: { machine: SELF }, scope: { level: 'project', projectId: PROJ_A.id, reach: 'network' } }));
  await updateMembership('gp_linked', (m) => { m.membershipPolicy = 'project-3546'; m.autoJoin = true; m.includeLinkedComputers = true; });
  await start();
}
function linkCopy() { fx.linkGroups = [[{ machine: SELF, projectId: PROJ_A.id }, { machine: REMOTE, projectId: 'remote_project' }]]; }

describe('linked automatic membership (#3546)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('repository equality alone never joins; an explicit link adds existing and future durable agents only', async () => {
    await linkedGroup();
    expect((await describeMembership('gp_linked')).members.map((m) => m.agentId)).toEqual(expect.not.arrayContaining([remoteAddress('remote')]));
    linkCopy(); await reconcileMembership();
    expect((await describeMembership('gp_linked')).members.map((m) => m.agentId).sort()).toEqual(['dev', 'lead', remoteAddress('remote')].sort());
    // Host bindings always remain local; the remote computer binds only the host's saved entries.
    expect(membersOf('gp_linked')).toEqual(['dev', 'lead']);
    fx.satellites[0].snapshot = remoteSnapshot([agent('remote'), agent('later'), agent('helper', { parentAgentId: 'remote' }),
      Object.assign(agent('quick-in-durables'), { kind: 'quick' }), Object.assign(agent('helper-kind'), { kind: 'helper' })]);
    await reconcileMembership();
    expect((await getMembership('gp_linked')).explicit.map((e) => e.address).sort()).toEqual([remoteAddress('later'), remoteAddress('remote')].sort());
  });

  it('previews coverage from the same read the directory shows, and keeps it out of the member list (#3549)', async () => {
    await linkedGroup();
    const scope = { level: 'project', projectId: PROJ_A.id, reach: 'network' } as const;
    const coverageOf = async () => (await listCoverage('gp_linked'))[0];
    // A repository match with no link: neither covered nor joined.
    expect((await previewAutoJoin(scope)).coverage.copies.map((c) => c.projectId)).toEqual([PROJ_A.id]);
    linkCopy(); await reconcileMembership();
    const service = await coverageOf();
    const preview = (await previewAutoJoin(scope)).coverage;
    expect(service.copies.map((c) => `${c.machine}/${c.projectId}`)).toEqual([`${SELF}/${PROJ_A.id}`, `${REMOTE}/remote_project`]);
    expect({ ...preview, groupProjectId: service.groupProjectId }).toEqual(service);
    // The agents the preview adds come from exactly the copies it says it covers.
    expect((await previewAutoJoin(scope)).wouldJoin.filter((m) => m.agentId.includes('@')).map((m) => m.projectId)).toEqual(['remote_project']);
    fx.satellites[0].state = 'disconnected';
    expect((await coverageOf()).copies.find((c) => c.machine === REMOTE)?.state).toBe('unknown');
    expect((await previewAutoJoin(scope)).unreadableProjects.map((p) => p.projectId)).toContain(`${REMOTE}/remote_project`);
  });

  it('previews verified linked agents, and keeps cached agents separate with an offline reason (#3661)', async () => {
    await linkedGroup(); linkCopy();
    const scope = { level: 'project', projectId: PROJ_A.id, reach: 'network' } as const;
    const online = await previewAutoJoin(scope);
    expect(online.wouldJoin.find((m) => m.agentId === remoteAddress('remote'))).toMatchObject({ projectName: 'Remote Alpha on Laptop' });
    expect(online.wouldJoin.find((m) => m.agentId === 'lead')).toMatchObject({ projectName: 'Alpha on this computer' });
    fx.satellites[0].state = 'disconnected';
    const offline = await previewAutoJoin(scope);
    expect(offline.wouldJoin.map((m) => m.agentId)).not.toContain(remoteAddress('remote'));
    expect(offline.lastSeen).toEqual([expect.objectContaining({ agentId: remoteAddress('remote'), machineName: 'Laptop' })]);
    expect(offline.unreadableProjects).toEqual([expect.objectContaining({ name: 'Remote Alpha on Laptop', reason: 'Laptop is offline.' })]);
    fx.satellites[0].state = 'connected';
    const reconnected = await previewAutoJoin(scope);
    expect(reconnected.lastSeen).toEqual([]);
    expect(reconnected.wouldJoin.map((m) => m.agentId)).toContain(remoteAddress('remote'));
  });

  it('uses plain fallback names and explains unsynced and oversized inventories (#3661)', async () => {
    await linkedGroup(); linkCopy();
    const scope = { level: 'project', projectId: PROJ_A.id, reach: 'network' } as const;
    fx.satellites[0].snapshot = null;
    expect((await previewAutoJoin(scope)).unreadableProjects).toEqual([expect.objectContaining({ name: 'Linked project on Laptop', reason: 'The project and agent list has not synced yet.' })]);
    fx.satellites[0].snapshot = { ...remoteSnapshot(), snapshotTruncated: { omitted: ['agents'] } };
    expect((await previewAutoJoin(scope)).unreadableProjects[0].reason).toBe('The project or agent list is too long to sync completely.');
    fx.linkGroups = [];
    expect((await previewAutoJoin(scope)).wouldJoin.find((m) => m.agentId === 'lead')?.projectName).toBe('Alpha');
  });

  it('does not compute coverage when listing members: the hub lists every group', async () => {
    await linkedGroup(); linkCopy();
    const describe = vi.spyOn(coverageService, 'describeCoverage');
    const list = vi.spyOn(coverageService, 'listCoverage');
    const view = await describeMembership('gp_linked');
    expect(view).not.toHaveProperty('coverage');
    expect(describe).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('never auto-joins a remote inventory row with an unknown kind', async () => {
    await linkedGroup(); linkCopy();
    fx.satellites[0].snapshot = remoteSnapshot([Object.assign(agent('unknown-kind'), { kind: 'future-agent-kind' })]);
    await reconcileMembership();
    expect((await getMembership('gp_linked')).explicit).toEqual([]);
    expect((await previewAutoJoin({ level: 'project', projectId: PROJ_A.id, reach: 'network' })).wouldJoin.map((m) => m.agentId)).not.toContain(remoteAddress('unknown-kind'));
  });

  it('reviews remote members with missing or unlinked project IDs as leaving a policy scope', async () => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    await updateMembership('gp_linked', (m) => {
      m.explicit.push({ address: remoteAddress('missing-project'), name: 'Missing project', kind: 'durable', addedAt: 'x' });
      m.explicit.push({ address: remoteAddress('unlinked-project'), name: 'Unlinked project', projectId: 'other-copy', kind: 'durable', addedAt: 'x' });
    });
    const stop = watchGroupProjectMembership();
    try {
      const next = { level: 'project' as const, projectId: PROJ_B.id, reach: 'network' as const };
      fx.linkGroups = [[{ machine: SELF, projectId: PROJ_B.id }, { machine: REMOTE, projectId: 'remote_project' }]];
      const { leaving } = await groupProjectHost.previewScope('gp_linked', next);
      expect(leaving.map((m) => m.address).sort()).toEqual(['dev', 'lead', remoteAddress('missing-project'), remoteAddress('unlinked-project')].sort());
      await expect(groupProjectHost.setScope('gp_linked', next, { confirmLeaving: ['dev', 'lead'] })).rejects.toThrow(/Review.*again/);
    } finally { stop(); }
  });

  it('verifies and fills remote project IDs when opting an existing membership record into the policy', async () => {
    await linkedGroup(); linkCopy();
    await updateMembership('gp_linked', (m) => {
      delete m.membershipPolicy;
      m.autoJoin = false; m.autoJoinOffer = 'dismissed';
      m.explicit.push({ address: remoteAddress('remote'), name: 'Remote', kind: 'durable', addedAt: 'x' });
    });
    fx.satellites[0].state = 'disconnected';
    await expect(setAutomaticMembership('gp_linked', { autoJoin: true, includeLinkedComputers: true })).rejects.toThrow(/remote members could not be verified/);
    expect((await getMembership('gp_linked')).membershipPolicy).toBeUndefined();
    fx.satellites[0].state = 'connected';
    await setAutomaticMembership('gp_linked', { autoJoin: true, includeLinkedComputers: true });
    expect((await getMembership('gp_linked')).explicit.find((e) => e.address === remoteAddress('remote'))).toMatchObject({ projectId: 'remote_project', projectName: 'Remote Alpha on Laptop' });
  });

  it.each(['offline', 'unavailable', 'truncated', 'unknown', 'unlinked'])('keeps remote explicit entries when a copy is %s, and prunes only after verified absence', async (state) => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    await addMember('gp_linked', remoteAddress('remote-helper'));
    await setAutomaticMembership('gp_linked', { autoJoin: false, includeLinkedComputers: false });
    fx.satellites[0].snapshot = remoteSnapshot([]);
    if (state === 'offline') fx.satellites[0].state = 'disconnected';
    if (state === 'unavailable') fx.satellites[0].snapshotUnavailable = true;
    if (state === 'truncated') fx.satellites[0].snapshot = { ...remoteSnapshot([]), snapshotTruncated: { omitted: ['agents'] } };
    if (state === 'unknown') fx.satellites[0].snapshot = { projects: [], agents: {} };
    if (state === 'unlinked') fx.linkGroups = [];
    await reconcileMembership();
    expect((await getMembership('gp_linked')).explicit.filter((e) => e.address.includes('@')).map((e) => e.address).sort()).toEqual([remoteAddress('remote'), remoteAddress('remote-helper')].sort());
    linkCopy(); fx.satellites[0].state = 'connected'; fx.satellites[0].snapshotUnavailable = false;
    fx.satellites[0].snapshot = remoteSnapshot([]);
    await reconcileMembership();
    expect((await getMembership('gp_linked')).explicit.filter((e) => e.address.includes('@'))).toEqual([]);
  });

  it.each([{ autoJoin: false, includeLinkedComputers: true }, { autoJoin: true, includeLinkedComputers: false }])('refuses toggle-off with a pending unlink review: %j', async (options) => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    fx.linkGroups = []; await reconcileMembership();
    const before = await getMembership('gp_linked');
    await expect(setAutomaticMembership('gp_linked', options)).rejects.toThrow(/Review who leaves.*before changing automatic membership/);
    expect(await getMembership('gp_linked')).toEqual(before);
    expect((await describeMembership('gp_linked')).coverageLeaving?.map((m) => m.agentId)).toEqual([remoteAddress('remote')]);
    await confirmUnlinkedMembers('gp_linked', [remoteAddress('remote')]);
    await setAutomaticMembership('gp_linked', options);
    expect((await describeMembership('gp_linked')).coverageLeaving).toEqual([]);
  });

  it('announces remote membership removal only after lead and admin have been revoked', async () => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    await setGroupProjectRole('gp_linked', remoteAddress('remote'), 'lead', 'allow');
    await setGroupProjectRole('gp_linked', remoteAddress('remote'), 'admin', 'allow');
    const rolesAtNotification: string[][] = [];
    const off = groupProjectHost.onChange((change) => {
      if (change.groupProjectId === 'gp_linked' && change.part === 'membership') rolesAtNotification.push([
        roleModeOf(remoteAddress('remote'), 'gp_linked', 'lead'), roleModeOf(remoteAddress('remote'), 'gp_linked', 'admin'),
      ]);
    });
    try { await excludeMember('gp_linked', remoteAddress('remote')); }
    finally { off(); }
    expect(rolesAtNotification.length).toBeGreaterThan(0);
    expect(rolesAtNotification.every((roles) => roles.every((mode) => mode === 'off'))).toBe(true);
  });

  it('watches incoming links and new remote snapshots, and keeps exclusions through both toggles', async () => {
    vi.useFakeTimers();
    try {
      await linkedGroup();
      const stop = watchGroupProjectMembership();
      await vi.waitFor(() => expect(fx.snapshotChanged).not.toBeNull());
      linkCopy(); fx.linkChanged!(); await vi.advanceTimersByTimeAsync(300);
      await vi.waitFor(async () => expect((await getMembership('gp_linked')).explicit).toHaveLength(1));
      await excludeMember('gp_linked', remoteAddress('remote'));
      await setAutomaticMembership('gp_linked', { autoJoin: true, includeLinkedComputers: false });
      await setAutomaticMembership('gp_linked', { autoJoin: true, includeLinkedComputers: true });
      fx.satellites[0].snapshot = remoteSnapshot([agent('remote'), agent('later')]);
      fx.snapshotChanged!(); await vi.advanceTimersByTimeAsync(300);
      await vi.waitFor(async () => expect((await getMembership('gp_linked')).explicit.some((e) => e.address === remoteAddress('later'))).toBe(true));
      const view = await describeMembership('gp_linked');
      expect(view.excluded.map((e) => e.agentId)).toContain(remoteAddress('remote'));
      expect(view.members.map((m) => m.agentId)).not.toContain(remoteAddress('remote'));
      stop();
    } finally { vi.useRealTimers(); }
  });

  it('notifies the host UI after a remote-only membership change commits', async () => {
    vi.useFakeTimers();
    try {
      await linkedGroup(); linkCopy(); await reconcileMembership();
      const stop = watchGroupProjectMembership();
      await vi.waitFor(() => expect(fx.snapshotChanged).not.toBeNull());
      const changed = vi.fn();
      const off = onMembershipChanged(changed);
      fx.satellites[0].snapshot = remoteSnapshot([agent('remote'), agent('later')]);
      fx.snapshotChanged!();
      await vi.advanceTimersByTimeAsync(300);
      await vi.waitFor(async () => expect((await getMembership('gp_linked')).explicit.some((e) => e.address === remoteAddress('later'))).toBe(true));
      // One refresh for the inventory, another for its committed host record.
      await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(changed).toHaveBeenCalledWith('gp_linked');
      off(); stop();
    } finally { vi.useRealTimers(); }
  });

  it('unlink keeps members pending review, refuses a stale list, then removes exactly the reviewed members', async () => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    fx.linkGroups = []; await reconcileMembership();
    await setGroupProjectRole('gp_linked', remoteAddress('remote'), 'lead', 'allow');
    const view = await describeMembership('gp_linked');
    expect(view.members.map((m) => m.agentId)).toContain(remoteAddress('remote'));
    expect(view.coverageLeaving?.map((m) => m.agentId)).toEqual([remoteAddress('remote')]);
    await expect(confirmUnlinkedMembers('gp_linked', [])).rejects.toThrow(/Review.*again/);
    linkCopy();
    await expect(confirmUnlinkedMembers('gp_linked', [remoteAddress('remote')])).rejects.toThrow(/Review.*again/);
    fx.linkGroups = [];
    await confirmUnlinkedMembers('gp_linked', [remoteAddress('remote')]);
    await vi.waitFor(() => expect(roleModeOf(remoteAddress('remote'), 'gp_linked', 'lead')).toBe('off'));
    expect((await describeMembership('gp_linked')).members.map((m) => m.agentId)).not.toContain(remoteAddress('remote'));
    linkCopy(); await reconcileMembership();
    expect((await describeMembership('gp_linked')).members.map((m) => m.agentId)).toContain(remoteAddress('remote'));
  });

  it('remote helpers remain explicit additions and remote quick agents cannot join', async () => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    await addMember('gp_linked', remoteAddress('remote-helper'));
    const entry = (await getMembership('gp_linked')).explicit.find((e) => e.address === remoteAddress('remote-helper'));
    expect(entry).toMatchObject({ kind: 'helper' });
    expect(entry?.autoProject).toBeUndefined();
    await expect(addMember('gp_linked', remoteAddress('remote-quick'))).rejects.toThrow(/explicitly linked project copy/);
  });

  it('keeps an excluded saved auto entry excluded through off, and includes it again explicitly', async () => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    await updateMembership('gp_linked', (membership) => {
      membership.excluded.push({ address: remoteAddress('remote'), excludedAt: 'x' });
    });
    await setAutomaticMembership('gp_linked', { autoJoin: false, includeLinkedComputers: false });
    expect((await describeMembership('gp_linked')).members.map((m) => m.agentId)).not.toContain(remoteAddress('remote'));
    expect((await getMembership('gp_linked')).excluded.map((e) => e.address)).toContain(remoteAddress('remote'));
    await addMember('gp_linked', remoteAddress('remote'));
    expect((await describeMembership('gp_linked')).members.find((m) => m.agentId === remoteAddress('remote'))?.via).toBe('explicit');
    fx.linkGroups = []; await reconcileMembership();
    expect((await describeMembership('gp_linked')).coverageLeaving).toEqual([]);
  });

  it('turning linked computers off preserves remote auto members explicitly, including across unlink', async () => {
    await linkedGroup(); linkCopy(); await reconcileMembership();
    await setAutomaticMembership('gp_linked', { autoJoin: true, includeLinkedComputers: false });
    expect((await getMembership('gp_linked')).explicit.find((e) => e.address === remoteAddress('remote'))?.autoProject).toBeUndefined();
    fx.linkGroups = []; await reconcileMembership();
    expect((await describeMembership('gp_linked')).members.map((m) => m.agentId)).toContain(remoteAddress('remote'));
    expect((await describeMembership('gp_linked')).coverageLeaving).toEqual([]);
  });

  it('does not add from an offline, unavailable or truncated copy and reports unknown in preview', async () => {
    await linkedGroup(); linkCopy();
    fx.satellites[0].state = 'disconnected';
    await reconcileMembership();
    const preview = await previewAutoJoin({ level: 'project', projectId: PROJ_A.id, reach: 'network' });
    expect(preview.wouldJoin.some((m) => m.agentId === remoteAddress('remote'))).toBe(false);
    expect(preview.unreadableProjects).toEqual([expect.objectContaining({ name: 'Remote Alpha on Laptop' })]);
    fx.satellites[0].state = 'connected';
    fx.satellites[0].snapshotUnavailable = true;
    await reconcileMembership();
    expect((await getMembership('gp_linked')).explicit).toEqual([]);
    fx.satellites[0].snapshotUnavailable = false;
    fx.satellites[0].snapshot = { ...remoteSnapshot(), snapshotTruncated: { omitted: ['agents'] } };
    await reconcileMembership();
    expect((await getMembership('gp_linked')).explicit).toEqual([]);
  });
});
