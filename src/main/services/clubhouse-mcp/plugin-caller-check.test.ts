import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agentOf: undefined as string | undefined,
  targets: [] as unknown[] | null,
  result: { ok: true } as Record<string, unknown>,
  resolved: [] as Array<{ callerId: string; actions: string[]; target: string; args: Record<string, unknown> }>,
}));

vi.mock('./plugin-tool-registry', () => ({ agentOfPluginCall: () => h.agentOf }));
vi.mock('./arg-targets', () => ({
  resolveArgTargets: async (callerId: string, d: { actions: string[]; target: string }, args: Record<string, unknown>) => {
    h.resolved.push({ callerId, actions: d.actions, target: d.target, args });
    return new Map([[d, h.targets]]);
  },
}));
vi.mock('./grant-check', () => ({ checkToolGrant: () => h.result }));
vi.mock('../group-project-registry', () => ({ groupProjectRegistry: { getSync: () => undefined } }));

import { checkPluginCaller, isPluginCallerCheck } from './plugin-caller-check';

beforeEach(() => {
  h.agentOf = 'agent-1';
  h.targets = [{ kind: 'agent', relations: ['connected'] }];
  h.result = { ok: true };
  h.resolved = [];
});

describe('a Clubhouse permission a plugin needs from the agent whose call it answers (D126, #3174)', () => {
  it('checks the action on an agent, or on a project, for the agent behind the call', async () => {
    expect(await checkPluginCaller('p', 'c', { action: 'agent.sleep', agentId: 'other' })).toBeNull();
    expect(await checkPluginCaller('p', 'c', { action: 'agent.create', projectPath: '/proj' })).toBeNull();
    expect(h.resolved).toEqual([
      { callerId: 'agent-1', actions: ['agent.sleep'], target: 'agent_arg', args: { agent: 'other' } },
      { callerId: 'agent-1', actions: ['agent.create'], target: 'project_arg', args: { project: '/proj' } },
    ]);
  });

  it('a refusal passes on what the agent lacks; Ask first counts as no', async () => {
    h.result = { ok: false, reason: 'no_grant', message: 'You don\'t have the Clubhouse permission agent.sleep on that agent.' };
    expect(await checkPluginCaller('p', 'c', { action: 'agent.sleep', agentId: 'other' }))
      .toBe('A plugin can\'t do for an agent what the agent can\'t: You don\'t have the Clubhouse permission agent.sleep on that agent.');
    h.result = { ok: false, reason: 'ask_first', message: 'needs approval', asks: [] };
    expect(await checkPluginCaller('p', 'c', { action: 'project.configure', projectPath: '/proj' }))
      .toBe('The calling agent\'s Clubhouse permission project.configure is set to Ask first, and a plugin acting for it can\'t wait for an answer. Ask the user.');
  });

  it('a target the agent can\'t name, or a call that is over, is refused', async () => {
    h.targets = [];
    expect(await checkPluginCaller('p', 'c', { action: 'agent.wake', agentId: 'nobody' })).toBe('The calling agent can\'t reach that agent.');
    h.targets = null;
    expect(await checkPluginCaller('p', 'c', { action: 'project.configure', projectPath: '/x' })).toBe('The calling agent can\'t reach that project.');
    h.agentOf = undefined;
    expect(await checkPluginCaller('p', 'c', { action: 'agent.wake', agentId: 'other' })).toMatch(/call this plugin was answering is over/);
  });

  it('accepts only a known action with exactly one of an agent or a project', () => {
    expect(isPluginCallerCheck({ action: 'agent.wake', agentId: 'a' })).toBe(true);
    expect(isPluginCallerCheck({ action: 'project.configure', projectPath: '/p' })).toBe(true);
    expect(isPluginCallerCheck({ action: 'agent.wake', agentId: 'a', projectPath: '/p' })).toBe(false);
    expect(isPluginCallerCheck({ action: 'root.everything', agentId: 'a' })).toBe(false);
    expect(isPluginCallerCheck({ kind: 'wake', agentId: 'a' })).toBe(false);
    expect(isPluginCallerCheck(null)).toBe(false);
  });
});
