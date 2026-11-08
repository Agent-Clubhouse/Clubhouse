import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

const state = vi.hoisted(() => ({
  agents: new Map<string, DurableAgentConfig[]>(),
  connected: new Set<string>(),
}));

vi.mock('../project-store', () => ({
  peekProjects: async () => [{ id: 'p1', name: 'Home', path: '/home' }, { id: 'p2', name: 'Far', path: '/far' }],
}));
vi.mock('../agent-config', () => ({ peekDurableConfigs: async (p: string) => state.agents.get(p) ?? [] }));
vi.mock('../orchestration-policy', () => ({
  resolveOrchestrationPolicies: async (_p: string, agents: DurableAgentConfig[]) =>
    new Map(agents.map((a) => [a.id, { connectToDispatcher: state.connected.has(a.id) }])),
}));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => true,
}));

import { agentRegistry } from '../agent-registry';
import { updateAgentGrantChanges } from '../agent-grants-store';
import { resolveArgTargets } from './arg-targets';
import { checkToolGrant } from './grant-check';
import { setDispatcherAgent, _resetDispatcherGateForTesting } from './dispatcher-gate';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from './orchestration-gate';
import type { ToolGrant } from './tool-grants';

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({ id, name: id, color: 'blue', createdAt: '', ...extra });

async function check(caller: string, grant: ToolGrant, args: Record<string, unknown>) {
  return checkToolGrant(caller, grant, args, undefined, await resolveArgTargets(caller, grant, args));
}

beforeEach(() => {
  _resetMcpCallGateForTesting();
  _resetOrchestrationGateForTesting();
  _resetDispatcherGateForTesting();
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  state.agents = new Map([
    ['/home', [agent('plain'), agent('orch'), agent('helper', { parentAgentId: 'orch' }), agent('peer')]],
    ['/far', [agent('faraway')]],
  ]);
  state.connected = new Set(['orch']);
  for (const id of ['plain', 'orch', 'helper', 'peer', 'dispatcher']) {
    agentRegistry.register(id, { projectPath: '/home', orchestrator: 'claude-code', runtime: 'chat' });
    setMcpCaller(id, '/home', id === 'helper' ? { parentAgentId: 'orch' } : {});
  }
  setOrchestrationEnabled('orch', true);
  setDispatcherAgent('dispatcher', true);
});

describe('targets named in the arguments (#2974)', () => {
  const display: ToolGrant = { actions: ['agent.display'], target: 'agent_arg', from: { args: ['agent_id'], missing: 'caller' } };
  const connect: ToolGrant = { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['from', 'to'] } };
  const configure: ToolGrant = { actions: ['agent.configure'], target: 'agent_arg', from: { args: ['agent_id'] } };
  const projectDisplay: ToolGrant = { actions: ['project.display'], target: 'project_arg', from: { args: ['project'], missing: 'caller' } };

  it('an agent changes itself, by default or by id, and not another', async () => {
    expect((await check('plain', display, {})).ok).toBe(true);
    expect((await check('plain', display, { agent_id: 'plain' })).ok).toBe(true);
    expect(await check('plain', display, { agent_id: 'peer' })).toMatchObject({ ok: false, reason: 'no_grant' });
  });

  it('an orchestrator connects itself and its helpers, by id or name, and nothing else', async () => {
    expect((await check('orch', connect, { from: 'orch', to: 'helper' })).ok).toBe(true);
    expect(await check('orch', connect, { from: 'orch', to: 'peer' })).toMatchObject({ ok: false, message: expect.stringContaining('connection.manage on that agent') });
  });

  it('the Dispatcher configures a connected orchestrator, not one that is off', async () => {
    expect((await check('dispatcher', configure, { agent_id: 'orch' })).ok).toBe(true);
    expect((await check('dispatcher', configure, { agent_id: 'peer' })).ok).toBe(false);
  });

  it('its own project by default; another project needs any project', async () => {
    expect((await check('plain', projectDisplay, {})).ok).toBe(true);
    expect((await check('plain', projectDisplay, { project: 'Far' })).ok).toBe(false);
    expect((await check('dispatcher', projectDisplay, { project: '/far' })).ok).toBe(true);
  });

  it('a helper in another project without Cross-project helpers says how to turn it on', async () => {
    const create: ToolGrant = { actions: ['agent.create'], target: 'project_arg', from: { args: ['project'], missing: 'caller' } };
    expect((await check('orch', create, {})).ok).toBe(true);
    expect(await check('orch', create, { project: 'Far' })).toMatchObject({ ok: false, message: expect.stringContaining('Cross-project helpers are turned off') });
  });

  it('every agent or project (`all`) needs a grant on any', async () => {
    const read: ToolGrant = { actions: ['project.read'], target: 'project_arg', from: { args: ['project'], missing: 'caller', all: 'all_projects' } };
    expect((await check('plain', read, { all_projects: true })).ok).toBe(false);
    expect((await check('dispatcher', read, { all_projects: true })).ok).toBe(true);
  });

  it('a reference that doesn\'t resolve is left to the tool, which says it wasn\'t found', async () => {
    expect((await check('plain', display, { agent_id: 'nobody' })).ok).toBe(true);
    expect((await check('plain', projectDisplay, { project: 'Nowhere' })).ok).toBe(true);
  });

  it('an unknown reference in a list doesn\'t switch off the check for the others', async () => {
    const read: ToolGrant = { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent_ids'], missing: 'caller' } };
    expect((await check('plain', read, { agent_ids: ['plain', 'nobody'] })).ok).toBe(true);
    expect((await check('plain', read, { agent_ids: ['nobody', 'peer'] })).ok).toBe(false);
  });

  it('a name two agents share is checked against both', async () => {
    state.agents.get('/home')!.push(agent('twin-1', { name: 'twin' }), agent('twin-2', { name: 'twin', parentAgentId: 'orch' }));
    const restart: ToolGrant = { actions: ['agent.wake'], target: 'agent_arg', from: { args: ['agent'] } };
    // The orchestrator may wake its helper twin-2, but not twin-1: the shared name is refused.
    expect((await check('orch', restart, { agent: 'twin-2' })).ok).toBe(true);
    expect((await check('orch', restart, { agent: 'twin' })).ok).toBe(false);
  });

  it('an id is found before any name, and connection tools place names among the caller and its helpers', async () => {
    state.agents.get('/home')!.push(agent('builder-local', { name: 'builder' }));
    state.agents.get('/far')!.push(agent('builder-helper', { name: 'builder', parentAgentId: 'orch' }), agent('named-like-an-id', { name: 'peer' }));
    const helpersOnly: ToolGrant = { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['to'], names: 'self_and_helpers' } };
    expect((await check('orch', helpersOnly, { to: 'builder' })).ok).toBe(true);
    // "peer" is an id in the caller's project before it is anyone's name.
    const [targets] = [...(await resolveArgTargets('dispatcher', configure, { agent_id: 'peer' })).values()];
    expect(targets).toEqual([expect.objectContaining({ projectPath: '/home' })]);
  });

  it('every agent in a named project is that project\'s', async () => {
    const all: ToolGrant = { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent_ids'], project: 'project', missing: 'caller', all: 'all_agents' } };
    const [targets] = [...(await resolveArgTargets('plain', all, { all_agents: true, project: 'Far' })).values()];
    expect(targets).toEqual([{ kind: 'agent', relations: [], projectPath: '/far' }]);
  });

  it('an agent elsewhere is found by id', async () => {
    const [targets] = [...(await resolveArgTargets('dispatcher', configure, { agent_id: 'faraway' })).values()];
    expect(targets).toEqual([expect.objectContaining({ kind: 'agent', projectPath: '/far' })]);
  });

  it('a folder being added is checked by its path, even though it isn\'t a project yet (#3050)', async () => {
    const add: ToolGrant = { actions: ['project.add'], target: 'project_arg', from: { args: ['path'] } };
    // Resolved as main resolves it, so on Windows it is a drive path too.
    const folder = path.resolve('/new/repo');
    const other = path.resolve('/other');
    const [targets] = [...(await resolveArgTargets('dispatcher', add, { path: folder })).values()];
    expect(targets).toEqual([{ kind: 'project', projectPath: folder }]);
    // A name it can't place, or no folder at all, is still checked: only a grant on every project covers it.
    for (const args of [{ path: 'somewhere' }, {}]) {
      const [unplaced] = [...(await resolveArgTargets('dispatcher', add, args)).values()];
      expect(unplaced, JSON.stringify(args)).toEqual([{ kind: 'project' }]);
    }
    expect(await check('dispatcher', add, { path: folder })).toMatchObject({ ok: false, reason: 'ask_first' });
    expect(await check('plain', add, { path: folder })).toMatchObject({ ok: false, reason: 'no_grant' });
    expect(await check('plain', add, { path: 'somewhere' })).toMatchObject({ ok: false, reason: 'no_grant' });
    // Opening one that is already a project is checked on that project.
    expect(await check('dispatcher', add, { path: 'Far' })).toMatchObject({ ok: false, reason: 'ask_first' });
    await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'project.add', target: { kind: 'project', project: { path: folder } }, mode: 'allow' }] }));
    try {
      expect((await check('plain', add, { path: folder })).ok).toBe(true);
      expect((await check('plain', add, { path: other })).ok).toBe(false);
    } finally {
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });

  it('a person\'s change on the permissions page now reaches these tools', async () => {
    const restart: ToolGrant = { actions: ['agent.restart'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } };
    expect((await check('dispatcher', restart, { agent: 'orch', project: 'Home' })).ok).toBe(true);
    await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.restart', target: { kind: 'any' }, mode: 'off' }] }));
    try {
      expect((await check('dispatcher', restart, { agent: 'orch', project: 'Home' })).ok).toBe(false);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
    }
  });
});
