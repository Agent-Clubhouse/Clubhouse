import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

// The stores it writes (connections, grants) go to a userData folder of each test's own,
// not the one test files share, so files running in parallel can't race on them.
const userData = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', async (original) => {
  const actual = await original<typeof import('electron')>();
  return { ...actual, app: { ...actual.app, getPath: (name: string) => (name === 'userData' && userData.dir ? userData.dir : actual.app.getPath(name)) } };
});

const state = vi.hoisted(() => ({
  agents: new Map<string, DurableAgentConfig[]>(),
  connected: new Set<string>(),
  /** Group projects' metadata, by id (#3174). */
  groups: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../group-project-registry', () => ({ groupProjectRegistry: {
  getSync: (id: string) => (state.groups.has(id) ? { metadata: state.groups.get(id) } : undefined),
  list: async () => [...state.groups].map(([id, metadata]) => ({ id, name: `Team ${id}`, metadata })),
} }));

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
import { resolveArgTargets, resolveGroupProjectArgs } from './arg-targets';
import { checkToolGrant } from './grant-check';
import { setDispatcherAgent, _resetDispatcherGateForTesting } from './dispatcher-gate';
import { setMcpCaller, _resetMcpCallGateForTesting } from './mcp-call-gate';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from './orchestration-gate';
import type { ToolGrant } from './tool-grants';
import { bindingManager } from './binding-manager';

beforeEach(() => {
  userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arg-targets-'));
});
afterEach(() => {
  fs.rmSync(userData.dir, { recursive: true, force: true });
  userData.dir = '';
});

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

  it('checks every registered-name match before a connection handler can resolve it', async () => {
    state.agents.get('/home')!.find((a) => a.id === 'helper')!.name = 'Twin';
    state.agents.get('/far')!.push(agent('other-helper', { name: 'Twin' }));
    const registered: ToolGrant = { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['to'], names: 'registered' } };
    expect(await check('orch', registered, { to: 'Twin' })).toMatchObject({ ok: false, reason: 'no_grant' });
    const [targets] = [...(await resolveArgTargets('orch', registered, { to: 'Twin' })).values()];
    expect(targets).toHaveLength(2);
    state.agents.get('/far')!.push(agent('remote-name', { name: 'Remote colleague' }));
    const [far] = [...(await resolveArgTargets('orch', registered, { to: 'remote colleague' })).values()];
    expect(far).toEqual([expect.objectContaining({ projectPath: '/far' })]);
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

describe('a group project named in a call (#3360)', () => {
  const join = [{ actions: ['connection.manage' as const], target: 'group_project_arg' as const, from: { args: ['project'] } }];

  it('freezes scalar and list references once, without changing caller arguments', async () => {
    state.groups.set('gp1', {}); state.groups.set('gp2', {});
    try {
      const args = { project: ['Team gp1', 'gp2'] };
      const resolved = await resolveGroupProjectArgs('plain', join, args);
      expect('message' in resolved).toBe(false);
      if ('message' in resolved) throw new Error(resolved.message);
      expect(resolved.args).toEqual({ project: ['gp1', 'gp2'] });
      expect(args.project).toEqual(['Team gp1', 'gp2']);
      state.groups.clear(); // A fresh lookup must not replace the already resolved targets.
      const targets = await resolveArgTargets('plain', join, resolved.args, resolved.targets);
      expect([...targets.values()][0]?.map((target) => target.groupProjectId)).toEqual(['gp1', 'gp2']);
    } finally { state.groups.clear(); }
  });

  it('resolves with its id, so a grant on that one group project covers it and no other', async () => {
    state.groups.set('gp1', {});
    state.groups.set('gp2', {});
    bindingManager.bind('plain', { targetId: 'gp1', targetKind: 'group-project', label: 'Team' });
    try {
      const [targets] = [...(await resolveArgTargets('plain', join, { project: 'Team gp1' })).values()];
      expect(targets).toEqual([{ kind: 'group_project', groupRole: 'member', groupProjectId: 'gp1' }]);

      await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'connection.manage', target: { kind: 'group_project', id: 'gp1' }, mode: 'allow' }] }));
      expect(checkToolGrant('plain', join, { project: 'gp1' }, undefined, await resolveArgTargets('plain', join, { project: 'gp1' })).ok).toBe(true);
      expect(checkToolGrant('plain', join, { project: 'gp2' }, undefined, await resolveArgTargets('plain', join, { project: 'gp2' })).ok).toBe(false);
    } finally {
      bindingManager.unbind('plain', 'gp1');
      state.groups.clear();
      await updateAgentGrantChanges('plain', () => undefined);
    }
  });
});
