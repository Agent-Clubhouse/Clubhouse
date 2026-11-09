import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agentOf: undefined as string | undefined,
  targets: [] as unknown[] | null,
  result: { ok: true } as Record<string, unknown>,
  resolved: [] as Array<{ callerId: string; actions: string[]; args: Record<string, unknown> }>,
}));

vi.mock('./plugin-tool-registry', () => ({ agentOfPluginCall: () => h.agentOf }));
vi.mock('./arg-targets', () => ({
  resolveArgTargets: async (callerId: string, d: { actions: string[] }, args: Record<string, unknown>) => {
    h.resolved.push({ callerId, actions: d.actions, args });
    return new Map([[d, h.targets]]);
  },
}));
vi.mock('./grant-check', () => ({ checkToolGrant: () => h.result }));

import { checkPluginCaller } from './plugin-caller-check';

beforeEach(() => {
  h.agentOf = 'agent-1';
  h.targets = [{ kind: 'agent', relations: ['connected'] }];
  h.result = { ok: true };
  h.resolved = [];
});

describe('what a plugin may do for the agent whose call it answers (D126, #3168)', () => {
  it('waking checks the calling agent\'s agent.wake on the target, and changing defaults its project.configure', async () => {
    expect(await checkPluginCaller('p', 'c', { kind: 'wake', agentId: 'other' })).toBeNull();
    expect(await checkPluginCaller('p', 'c', { kind: 'project_defaults', projectPath: '/proj' })).toBeNull();
    expect(h.resolved).toEqual([
      { callerId: 'agent-1', actions: ['agent.wake'], args: { agent: 'other' } },
      { callerId: 'agent-1', actions: ['project.configure'], args: { project: '/proj' } },
    ]);
  });

  it('a refusal passes on what the agent lacks', async () => {
    h.result = { ok: false, reason: 'no_grant', message: 'You don\'t have the Clubhouse permission agent.wake on that agent.' };
    expect(await checkPluginCaller('p', 'c', { kind: 'wake', agentId: 'other' }))
      .toBe('A plugin can\'t do for an agent what the agent can\'t: You don\'t have the Clubhouse permission agent.wake on that agent.');
  });

  it('Ask first counts as no: the plugin\'s change can\'t wait for an answer', async () => {
    h.result = { ok: false, reason: 'ask_first', message: 'needs approval', asks: [] };
    expect(await checkPluginCaller('p', 'c', { kind: 'project_defaults', projectPath: '/proj' }))
      .toBe('The calling agent\'s Clubhouse permission to change that project\'s agent defaults is set to Ask first, and a plugin\'s change for it can\'t wait for an answer. Ask the user.');
  });

  it('a target the agent can\'t name, or a call that is over, is refused', async () => {
    h.targets = [];
    expect(await checkPluginCaller('p', 'c', { kind: 'wake', agentId: 'nobody' })).toBe('The calling agent can\'t wake that agent.');
    h.targets = null;
    expect(await checkPluginCaller('p', 'c', { kind: 'project_defaults', projectPath: '/x' })).toBe('The calling agent can\'t change that project\'s agent defaults.');
    h.agentOf = undefined;
    expect(await checkPluginCaller('p', 'c', { kind: 'wake', agentId: 'other' })).toMatch(/call this plugin was answering is over/);
  });
});
