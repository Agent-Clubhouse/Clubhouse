/**
 * The host's grant check of other computers' agents' writes (#3363, #3360),
 * through the real grant engine: members post, lead and admin changes need
 * Allow on the group project, Ask first refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupProject } from '../../shared/group-project-types';
import type { QueuedWrite } from '../../shared/group-project-network';

const fx = vi.hoisted(() => ({ grants: new Map<string, unknown>() }));
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
vi.mock('./group-project-host', () => ({ groupProjectHost: { onChange: () => () => undefined } }));

import { remoteGroupProjectGrantGate } from './group-project-remote-grants';
import { setGroupProjectRole } from './group-project-roles';

const OTHER = Array.from({ length: 32 }, () => 'bb').join(':');
const address = `builder@${OTHER}`;
const project = { id: 'gp_net', name: 'Launch', description: '', instructions: '', createdAt: 't', metadata: {}, scope: { level: 'app', reach: 'network' } } as GroupProject;
const write = { id: 'w1', groupProjectId: project.id, queuedAt: 't', author: { agentId: 'builder', label: 'builder' }, write: { op: 'post', sender: 'b', topic: 'work', body: 'x' } } as QueuedWrite;
const check = (action: 'group_project.post' | 'group_project.lead' | 'group_project.admin', isMember = true) =>
  remoteGroupProjectGrantGate({ project, machine: OTHER, write, address, isMember, action });

beforeEach(() => fx.grants.clear());

describe('remote group project writes against grants (#3363, #3360)', () => {
  it('lets a member post, and refuses a non-member anything', async () => {
    expect(await check('group_project.post')).toBeUndefined();
    expect(await check('group_project.post', false)).toContain('member');
    expect(await check('group_project.admin', false)).toContain('member');
  });

  it('refuses lead and admin changes without a grant', async () => {
    expect(await check('group_project.lead')).toEqual(expect.any(String));
    expect(await check('group_project.admin')).toEqual(expect.any(String));
  });

  it('allows lead and admin changes with Allow on this group project, for the remote agent\'s address', async () => {
    await setGroupProjectRole(project.id, address, 'lead', 'allow');
    expect(await check('group_project.lead')).toBeUndefined();
    expect(await check('group_project.admin')).toEqual(expect.any(String));
    await setGroupProjectRole(project.id, address, 'admin', 'allow');
    expect(await check('group_project.admin')).toBeUndefined();
    // On another group project the grant doesn't count.
    expect(await remoteGroupProjectGrantGate({ project: { ...project, id: 'gp_other' }, machine: OTHER, write, address, isMember: true, action: 'group_project.admin' }))
      .toEqual(expect.any(String));
  });

  it('refuses Ask first: no person on the host sees a remote write to ask', async () => {
    await setGroupProjectRole(project.id, address, 'admin', 'ask');
    expect(await check('group_project.admin')).toContain('can\'t ask');
  });
});
