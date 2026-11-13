/**
 * The Group Project as a principal (#3360): lead and admin as explicit grants
 * on one group project, its own grants, and the one-time migration of the old
 * admins role.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject, GroupProjectChange } from '../../shared/group-project-types';
import { evaluateGrant } from '../../shared/agent-grants';
import { applyGrantChanges } from '../../shared/agent-grant-changes';
import { defaultGrants } from '../../shared/default-grants';

const fx = vi.hoisted(() => ({
  projects: new Map<string, GroupProject>(),
  grants: new Map<string, unknown>(),
  members: new Map<string, string[]>(),
  listeners: new Set<(c: GroupProjectChange) => void>(),
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-grants-store', () => ({
  getAgentGrantChanges: (id: string) => fx.grants.get(id),
  listAgentsWithGrantChanges: () => [...fx.grants.keys()],
  updateAgentGrantChanges: async (id: string, fn: (c: unknown) => unknown) => {
    const next = fn(fx.grants.get(id));
    if (next) fx.grants.set(id, next); else fx.grants.delete(id);
    return next;
  },
}));
vi.mock('./group-project-host', () => ({
  groupProjectHost: {
    list: async () => [...fx.projects.values()],
    get: async (id: string) => fx.projects.get(id) ?? null,
    resolveMembers: async (id: string) => (fx.members.get(id) ?? []).map((address) => ({ address, name: address })),
    update: async (id: string, fields: { metadata?: Record<string, unknown> }) => {
      const gp = fx.projects.get(id);
      if (!gp) return null;
      gp.metadata = { ...gp.metadata, ...fields.metadata };
      return gp;
    },
    onChange: (fn: (c: GroupProjectChange) => void) => { fx.listeners.add(fn); return () => fx.listeners.delete(fn); },
  },
}));

import {
  describeGroupProjectRoles, grantGroupProjectRole, groupProjectMay, listGroupProjectRoles, migrateGroupProjectRoles, ownGrantsOf, roleModeOf,
  setGroupProjectRole, setOwnGrant, watchGroupProjectRoles,
} from './group-project-roles';
import { getAgentGrantChanges } from './agent-grants-store';

const PLAIN = { dispatcher: false, helper: false, orchestrates: false, crossProject: false };

function gp(id: string, metadata: Record<string, unknown> = {}): GroupProject {
  return { id, name: id, description: '', instructions: '', createdAt: '', metadata };
}

/** What the grant check decides for an agent on a group project. */
function decide(agentId: string, action: 'group_project.lead' | 'group_project.admin', groupProjectId: string) {
  const grants = applyGrantChanges(defaultGrants(PLAIN), getAgentGrantChanges(agentId) as never);
  return evaluateGrant({ caller: { kind: 'agent', agentId }, action, target: { kind: 'group_project', groupRole: 'member', groupProjectId } }, grants).outcome;
}

beforeEach(() => {
  fx.projects.clear();
  fx.grants.clear();
  fx.listeners.clear();
  fx.members.clear();
});

describe('lead and admin are explicit grants', () => {
  it('no agent leads or administers a group project by default, the creator included', () => {
    expect(decide('creator', 'group_project.lead', 'gp1')).toBe('refuse');
    expect(decide('creator', 'group_project.admin', 'gp1')).toBe('refuse');
  });

  it('a grant on one group project covers that group project only, in its mode', async () => {
    await setGroupProjectRole('gp1', 'lead-agent', 'lead', 'allow');
    await setGroupProjectRole('gp1', 'lead-agent', 'admin', 'ask');
    expect(decide('lead-agent', 'group_project.lead', 'gp1')).toBe('allow');
    expect(decide('lead-agent', 'group_project.admin', 'gp1')).toBe('ask');
    expect(decide('lead-agent', 'group_project.lead', 'gp2')).toBe('refuse');
    expect(listGroupProjectRoles('gp1')).toEqual([{ agentId: 'lead-agent', lead: 'allow', admin: 'ask' }]);

    await setGroupProjectRole('gp1', 'lead-agent', 'lead', 'off');
    await setGroupProjectRole('gp1', 'lead-agent', 'admin', 'off');
    expect(decide('lead-agent', 'group_project.lead', 'gp1')).toBe('refuse');
    expect(listGroupProjectRoles('gp1')).toEqual([]);
  });

  it('the Dispatcher may administer any group project, asking first', () => {
    const grants = defaultGrants({ ...PLAIN, dispatcher: true });
    const target = { kind: 'group_project' as const, groupRole: 'member' as const, groupProjectId: 'gp1' };
    expect(evaluateGrant({ caller: { kind: 'agent', agentId: 'd' }, action: 'group_project.admin', target }, grants).outcome).toBe('ask');
    expect(evaluateGrant({ caller: { kind: 'agent', agentId: 'd' }, action: 'group_project.lead', target }, grants).outcome).toBe('refuse');
  });
});

describe('a person gives a role (#3360)', () => {
  it('only to a current member of an existing group project, and writes nothing when refused', async () => {
    fx.projects.set('gp1', gp('gp1'));
    fx.members.set('gp1', ['dev']);
    await grantGroupProjectRole('gp1', 'dev', 'lead', 'allow');
    expect(roleModeOf('dev', 'gp1', 'lead')).toBe('allow');

    // Not a member, or excluded (an excluded agent isn't resolved as a member).
    await expect(grantGroupProjectRole('gp1', 'outsider', 'lead', 'allow')).rejects.toMatchObject({ code: 'not_member' });
    await expect(grantGroupProjectRole('gp1', 'outsider', 'admin', 'ask')).rejects.toMatchObject({ code: 'not_member' });
    expect(fx.grants.has('outsider')).toBe(false);
    await expect(grantGroupProjectRole('gp_missing', 'dev', 'lead', 'allow')).rejects.toMatchObject({ code: 'not_found' });

    // Taking a role away always may, member or not.
    fx.members.set('gp1', []);
    await grantGroupProjectRole('gp1', 'dev', 'lead', 'off');
    expect(roleModeOf('dev', 'gp1', 'lead')).toBe('off');
  });
});

describe('migration from the admins role', () => {
  it('gives today\'s admins lead and admin, once', async () => {
    fx.projects.set('gp1', gp('gp1', { admins: ['old-lead'] }));
    fx.projects.set('gp2', gp('gp2'));
    expect(await migrateGroupProjectRoles()).toBe(1);
    expect(roleModeOf('old-lead', 'gp1', 'lead')).toBe('allow');
    expect(roleModeOf('old-lead', 'gp1', 'admin')).toBe('allow');
    expect(decide('old-lead', 'group_project.lead', 'gp1')).toBe('allow');
    expect(fx.projects.get('gp1')!.metadata.rolesMigratedAt).toBeTruthy();

    // A person takes lead away later: a second pass doesn't give it back.
    await setGroupProjectRole('gp1', 'old-lead', 'lead', 'off');
    expect(await migrateGroupProjectRoles()).toBe(0);
    expect(roleModeOf('old-lead', 'gp1', 'lead')).toBe('off');
  });
});

describe('the group project\'s own grants', () => {
  it('delivers by default and doesn\'t wake; both can be changed', async () => {
    fx.projects.set('gp1', gp('gp1'));
    expect(ownGrantsOf(fx.projects.get('gp1')!)).toEqual({ deliver: 'allow', wake: 'off' });
    expect(groupProjectMay(fx.projects.get('gp1')!, 'wake')).toBe(false);
    await setOwnGrant('gp1', 'wake', 'allow');
    await setOwnGrant('gp1', 'deliver', 'off');
    expect(ownGrantsOf(fx.projects.get('gp1')!)).toEqual({ deliver: 'off', wake: 'allow' });
    expect((await describeGroupProjectRoles('gp1')).own).toEqual({ deliver: 'off', wake: 'allow' });
  });
});

describe('delete', () => {
  it('takes a deleted group project\'s role grants away', async () => {
    await setGroupProjectRole('gp1', 'a', 'lead', 'allow');
    await setGroupProjectRole('gp2', 'a', 'lead', 'allow');
    const stop = watchGroupProjectRoles();
    for (const fn of fx.listeners) fn({ groupProjectId: 'gp1', seq: 3, part: 'deleted' });
    await vi.waitFor(() => expect(roleModeOf('a', 'gp1', 'lead')).toBe('off'));
    expect(roleModeOf('a', 'gp2', 'lead')).toBe('allow');
    stop();
  });
});
