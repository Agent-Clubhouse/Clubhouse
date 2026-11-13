/**
 * Group project membership (#3357): a record on the host, with auto-join,
 * exclusions, explicit helpers and ephemeral quick agents. Bindings are
 * derived from it through a pruning persisted-binding source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { DurableAgentConfig } from '../../shared/types';
import type { GroupProject } from '../../shared/group-project-types';

const fx = vi.hoisted(() => ({
  home: '',
  projects: [] as Array<{ id: string; name: string; path: string }>,
  configs: new Map<string, DurableAgentConfig[]>(),
  quick: new Map<string, { agentId: string; name: string; projectPath: string; startedAt: number; finishedAt?: number }>(),
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
vi.mock('./quick-agent-events', () => ({ knownQuickAgents: () => fx.quick }));
vi.mock('./group-project-bulletin', () => ({
  getBulletinBoard: vi.fn(), ensureInboxChannel: vi.fn(), ensureProjectChannels: vi.fn(), destroyBulletinBoard: vi.fn(),
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  _resetPersistedBindingSourcesForTesting, keepHeldBinding, markBindingRemovedByUser, rebuildPersistedBindings, registerPersistedBindingSource,
} from './persisted-bindings';
import { groupProjectRegistry } from './group-project-registry';
import { groupProjectHost } from './group-project-host';
import {
  _resetMembershipForTesting, addMember, answerAutoJoinOffer, describeMembership, excludeMember, membershipBindingSource,
  releaseMembershipBindings, quickMemberName, reconcileMembership, recordMemberDisabledTools, savedMemberDisabledTools, watchGroupProjectMembership,
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
      expect(m.autoJoin || m.autoJoinOffer !== undefined).toBe(true);
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
  groupProjectRegistry._resetForTesting();
  restart();
});

afterEach(async () => {
  restart();
  groupProjectRegistry._resetForTesting();
  await fsp.rm(fx.home, { recursive: true, force: true });
});

describe('auto-join', () => {
  it('a new group project includes every top-level durable agent in scope, with no wires', async () => {
    groupProjectRegistry._setForTesting(gp('gp1'));
    await start();
    expect(membersOf('gp1')).toEqual(['dev', 'lead']);
    const view = await describeMembership('gp1');
    expect(view.managed).toBe(true);
    expect(view.members.every((m) => m.via === 'auto' && m.kind === 'durable')).toBe(true);
  });

  it('app scope includes every project\'s top-level durable agents', async () => {
    groupProjectRegistry._setForTesting(gp('gp1', { scope: { level: 'app', reach: 'local' } }));
    await start();
    expect(membersOf('gp1')).toEqual(['dev', 'lead', 'other']);
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

  it('dismissing the offer adds no one', async () => {
    groupProjectRegistry._setForTesting(legacyGp('gp_old'));
    await start();
    await answerAutoJoinOffer('gp_old', false);
    expect(membersOf('gp_old')).toEqual([]);
    expect((await describeMembership('gp_old')).autoJoinOffer?.state).toBe('dismissed');
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
