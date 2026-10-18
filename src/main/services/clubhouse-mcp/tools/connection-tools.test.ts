/**
 * Orchestrator connection tools (#2230): scoping, the per-project store, the
 * `orchestrator-connections` startup source, disconnect and helper disposal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../../../shared/types';
import type { GroupProject } from '../../../../shared/group-project-types';

const { configs, projects, configListeners, ptyWrite, postMessage, getBoard, groupProjects, gpCounter, storeHooks } = vi.hoisted(() => {
  const postMessage = vi.fn(async () => undefined);
  return {
    configs: new Map<string, DurableAgentConfig[]>(),
    projects: { list: [] as Array<{ id: string; name: string; path: string; displayName?: string }> },
    configListeners: new Set<(projectPath: string) => void>(),
    ptyWrite: vi.fn(),
    postMessage,
    getBoard: vi.fn(() => ({ postMessage })),
    groupProjects: new Map<string, GroupProject>(),
    gpCounter: { n: 0 },
    storeHooks: { afterAdd: undefined as undefined | (() => void) },
  };
});

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
// Lets a test act between saving a connection and binding it.
vi.mock('../../orchestrator-connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../orchestrator-connections')>();
  return {
    ...actual,
    addConnections: vi.fn(async (...args: Parameters<typeof actual.addConnections>) => {
      const added = await actual.addConnections(...args);
      storeHooks.afterAdd?.();
      return added;
    }),
  };
});
vi.mock('../../project-store', () => ({ list: vi.fn(async () => projects.list) }));
vi.mock('../../agent-config', () => {
  const isDisposed = (a: DurableAgentConfig) => !!a.disposedAt;
  return {
    listDurable: vi.fn(async (p: string) => configs.get(p) ?? []),
    getDurableConfig: vi.fn(async (p: string, id: string) => (configs.get(p) ?? []).find((a) => a.id === id) ?? null),
    listHelpers: vi.fn(async (p: string, id: string) =>
      (configs.get(p) ?? []).filter((a) => a.parentAgentId === id && !isDisposed(a))),
    onAgentConfigChanged: vi.fn((listener: (projectPath: string) => void) => {
      configListeners.add(listener);
      return () => configListeners.delete(listener);
    }),
  };
});
// Anything that would announce a member or start polling goes through these.
vi.mock('../../pty-manager', () => ({ write: ptyWrite, isRunning: vi.fn(() => true) }));
vi.mock('../../group-project-bulletin', () => ({
  getBulletinBoard: getBoard,
  ensureInboxChannel: vi.fn(async () => 'inbox'),
  ensureProjectChannels: vi.fn(async () => undefined),
}));
vi.mock('../../group-project-registry', () => {
  const registry = {
    create: vi.fn(async (name: string) => {
      const project: GroupProject = { id: `gp_${++gpCounter.n}`, name, description: '', instructions: '', createdAt: '2026-10-18T00:00:00.000Z', metadata: {} };
      groupProjects.set(project.id, project);
      return project;
    }),
    get: vi.fn(async (id: string) => groupProjects.get(id) ?? null),
    getSync: vi.fn((id: string) => groupProjects.get(id) ?? null),
    list: vi.fn(async () => [...groupProjects.values()]),
    update: vi.fn(async (id: string, fields: { metadata?: Record<string, unknown> }) => {
      const project = groupProjects.get(id);
      if (!project) return null;
      if (fields.metadata) project.metadata = { ...project.metadata, ...fields.metadata };
      return project;
    }),
    onChange: vi.fn(() => () => undefined),
  };
  return { groupProjectRegistry: registry };
});

import { bindingManager } from '../binding-manager';
import { callTool, getScopedToolList } from '../tool-registry';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from '../orchestration-gate';
import { agentRegistry } from '../../agent-registry';
import {
  clearBindingRemovedByUser,
  isBindingRemovedByUser,
  markBindingRemovedByUser,
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  _resetPersistedBindingSourcesForTesting,
  type PersistedBinding,
} from '../../persisted-bindings';
import {
  connectionsStorePath,
  orchestratorConnectionSource,
  readConnections,
  watchOrchestratorConnections,
  _resetOrchestratorConnectionsForTesting,
} from '../../orchestrator-connections';
import { initGroupProjectLifecycle, _resetLifecycleForTesting } from '../../group-project-lifecycle';
import { registerConnectionTools, GROUP_PROJECT_CREATOR_KEY } from './connection-tools';

let root: string;
let projectPath: string;

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id,
  name: id.replace('durable_', ''),
  color: 'emerald',
  createdAt: '2026-10-18T00:00:00.000Z',
  ...extra,
} as DurableAgentConfig);

const pairKey = (b: { agentId: string; targetId: string }) => `${b.agentId}->${b.targetId}`;
const boundPairs = () => bindingManager.getAllBindings().map(pairKey).sort();
const ticks = () => new Promise((r) => setTimeout(r, 20));

/** Watch the stores, rebuilding on each change; `rebuilt(n)` resolves once n rebuilds have finished. */
function watchWithRebuilds() {
  let done = 0;
  const waiters = new Set<() => void>();
  const stop = watchOrchestratorConnections(async () => {
    await rebuildPersistedBindings();
    done++;
    for (const w of [...waiters]) w();
  });
  const rebuilt = (n: number) => new Promise<void>((resolve) => {
    const check = () => {
      if (done < n) return;
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });
  return { stop, rebuilt };
}

async function call(tool: string, args: Record<string, unknown>, caller = 'durable_lead') {
  const result = await callTool(caller, tool, args);
  return { text: result.content.map((c) => ('text' in c ? c.text : '')).join('\n'), isError: !!result.isError };
}

function setAgents(agents: DurableAgentConfig[]): void {
  configs.set(projectPath, agents);
  for (const listener of configListeners) listener(projectPath);
}

/** Simulate an app restart: in-memory bindings and source state are gone, the stores stay. */
function restart(): void {
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
  _resetOrchestratorConnectionsForTesting();
  _resetLifecycleForTesting();
  registerPersistedBindingSource(orchestratorConnectionSource);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-orch-conn-'));
  projectPath = path.join(root, 'wardfall');
  fs.mkdirSync(projectPath, { recursive: true });
  configs.clear();
  configListeners.clear();
  groupProjects.clear();
  gpCounter.n = 0;
  storeHooks.afterAdd = undefined;
  ptyWrite.mockClear();
  postMessage.mockClear();
  getBoard.mockClear();
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
  _resetOrchestratorConnectionsForTesting();
  _resetLifecycleForTesting();
  _resetOrchestrationGateForTesting();
  projects.list = [{ id: 'proj_w', name: 'wardfall', displayName: 'Wardfall', path: projectPath }];
  configs.set(projectPath, [
    agent('durable_lead'),
    agent('durable_h1', { parentAgentId: 'durable_lead' }),
    agent('durable_h2', { parentAgentId: 'durable_lead' }),
    agent('durable_other'),
    agent('durable_otherhelper', { parentAgentId: 'durable_other' }),
  ]);
  for (const id of ['durable_lead', 'durable_other']) {
    agentRegistry.register(id, { projectPath, orchestrator: 'claude-code', runtime: 'pty' });
    setOrchestrationEnabled(id, true);
  }
  registerConnectionTools();
  registerPersistedBindingSource(orchestratorConnectionSource);
});

afterEach(() => {
  vi.useRealTimers();
  for (const id of ['durable_lead', 'durable_other']) agentRegistry.untrack(id);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('gating', () => {
  it('lists and runs the tools only for an agent with orchestration on', async () => {
    const names = getScopedToolList('durable_lead').map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'create_group_project', 'add_to_group_project', 'remove_from_group_project', 'connect_agents', 'disconnect_agents',
    ]));

    setOrchestrationEnabled('durable_lead', false);
    expect(getScopedToolList('durable_lead').map((t) => t.name)).not.toContain('connect_agents');
    const refused = await call('connect_agents', { from: 'h1', to: 'h2' });
    expect(refused.isError).toBe(true);
    expect(boundPairs()).toEqual([]);
  });
});

describe('scoping refusals', () => {
  it('refuses agents that are not the caller or its helpers', async () => {
    for (const [from, to] of [['h1', 'other'], ['otherhelper', 'h1'], ['h1', 'nobody']]) {
      const res = await call('connect_agents', { from, to });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/not you or one of your helpers/);
    }
    expect(boundPairs()).toEqual([]);
    expect(await readConnections(projectPath)).toEqual([]);
  });

  it('refuses a disposed helper', async () => {
    configs.set(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h2' ? { ...a, disposedAt: '2026-10-18T01:00:00.000Z' } : a));
    const res = await call('connect_agents', { from: 'h1', to: 'h2' });
    expect(res.isError).toBe(true);
  });

  it('refuses connecting an agent to itself', async () => {
    const res = await call('connect_agents', { from: 'h1', to: 'durable_h1' });
    expect(res.isError).toBe(true);
  });

  it('creates nothing when a member is out of scope', async () => {
    const res = await call('create_group_project', { name: 'Raid', members: ['h1', 'otherhelper'] });
    expect(res.isError).toBe(true);
    expect(groupProjects.size).toBe(0);
  });

  it('only touches group projects the caller created or belongs to', async () => {
    const created = await call('create_group_project', { name: 'Theirs', members: ['otherhelper'] }, 'durable_other');
    expect(created.isError).toBe(false);

    const add = await call('add_to_group_project', { project: 'Theirs', helper: 'h1' });
    expect(add.isError).toBe(true);
    expect(add.text).toMatch(/created or belong to/);
    const remove = await call('remove_from_group_project', { project: 'gp_1', helper: 'h1' });
    expect(remove.isError).toBe(true);
    // The other orchestrator may not move the caller's helpers into its project either.
    const steal = await call('add_to_group_project', { project: 'Theirs', helper: 'h1' }, 'durable_other');
    expect(steal.isError).toBe(true);
    expect(boundPairs()).toEqual(['durable_otherhelper->gp_1']);
  });

  it('allows a group project the caller belongs to through a canvas wire', async () => {
    groupProjects.set('gp_canvas', { id: 'gp_canvas', name: 'Canvas GP', description: '', instructions: '', createdAt: '', metadata: {} });
    bindingManager.bind('durable_lead', { targetId: 'gp_canvas', targetKind: 'group-project', label: 'Canvas GP' });
    const res = await call('add_to_group_project', { project: 'Canvas GP', helper: 'h1' });
    expect(res.isError).toBe(false);
    expect(boundPairs()).toContain('durable_h1->gp_canvas');
  });
});

describe('connecting and persistence', () => {
  it('records the creator and joins members, announcing the join like a drawn wire', async () => {
    initGroupProjectLifecycle();
    const res = await call('create_group_project', { name: 'Raid', members: ['h1', 'lead'] });
    expect(res.isError).toBe(false);
    const project = [...groupProjects.values()][0];
    expect(project.metadata[GROUP_PROJECT_CREATOR_KEY]).toBe('durable_lead');
    expect(boundPairs()).toEqual(['durable_h1->gp_1', 'durable_lead->gp_1']);
    await ticks();
    // The caller joins first and leads the project.
    expect(project.metadata.admins).toEqual(['durable_lead']);
    expect(postMessage).toHaveBeenCalledWith('system', 'system', expect.stringContaining('joined project "Raid"'));
    // Polling stays off: it starts only from the user's toggle.
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('saves connections in the project store and rebuilds them at startup', async () => {
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    await call('connect_agents', { from: 'h1', to: 'h2' });
    await call('create_group_project', { name: 'Raid', members: ['h2'] });
    const expected = ['durable_h1->durable_h2', 'durable_h1->durable_lead', 'durable_h2->gp_1', 'durable_lead->durable_h1'];
    expect(boundPairs()).toEqual(expected);

    const stored = JSON.parse(fs.readFileSync(path.join(projectPath, '.clubhouse', '.local', 'orchestrator-connections.json'), 'utf-8'));
    expect(stored.connections).toHaveLength(4);
    expect(stored.connections[0]).toMatchObject({ ownerId: 'durable_lead', agentId: 'durable_lead', targetId: 'durable_h1', targetKind: 'agent' });

    restart();
    expect(boundPairs()).toEqual([]);
    const result = await rebuildPersistedBindings();
    expect(result.sources).toEqual([
      { id: 'orchestrator-connections', collected: 4, created: 4, existing: 0, removed: 0, invalid: 0, pruned: 0 },
    ]);
    expect(boundPairs()).toEqual(expected);
    const wire = bindingManager.getBindingsForAgent('durable_h1').find((b) => b.targetId === 'durable_h2')!;
    expect(wire).toMatchObject({ targetKind: 'agent', label: 'h2', agentName: 'h1', targetName: 'h2', projectName: 'Wardfall' });
  });

  it('is idempotent: rebuilding again, or connecting again, changes nothing', async () => {
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    restart();
    await rebuildPersistedBindings();
    const before = bindingManager.getAllBindings().map((b) => ({ ...b }));
    const changes = vi.fn();
    bindingManager.onChange(changes);

    const second = await rebuildPersistedBindings();
    expect(second.sources[0]).toMatchObject({ created: 0, existing: 2, pruned: 0 });
    const again = await call('connect_agents', { from: 'lead', to: 'h1' });
    expect(again.text).toMatch(/already connected/);
    expect(bindingManager.getAllBindings()).toEqual(before);
    expect(changes).not.toHaveBeenCalled();
    expect(await readConnections(projectPath)).toHaveLength(2);
  });

  it('posts no bulletins and starts no polling on the startup rebuild', async () => {
    await call('create_group_project', { name: 'Raid', members: ['lead', 'h1'] });
    await call('connect_agents', { from: 'h1', to: 'h2' });
    groupProjects.get('gp_1')!.metadata.pollingEnabled = true;

    restart();
    getBoard.mockClear();
    postMessage.mockClear();
    initGroupProjectLifecycle();
    await rebuildPersistedBindings();
    await new Promise((r) => setTimeout(r, 600)); // past the lifecycle's polling-start delay

    expect(boundPairs()).toEqual(['durable_h1->durable_h2', 'durable_h1->gp_1', 'durable_lead->gp_1']);
    expect(getBoard).not.toHaveBeenCalled();
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('keeps a connection a concurrent rebuild collected before it was saved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    registerPersistedBindingSource({ id: 'slow', collect: async () => { await gate; return []; } });
    const unbind = vi.spyOn(bindingManager, 'unbind');
    const running = rebuildPersistedBindings(); // orchestrator-connections collects first, sees nothing
    await ticks();
    const connecting = call('connect_agents', { from: 'lead', to: 'h1' });
    await ticks();
    release();
    await running;
    await connecting;
    // Not pruned and re-created: the binding the tool made stays as it is.
    expect(unbind).not.toHaveBeenCalled();
    unbind.mockRestore();
    expect(boundPairs()).toEqual(['durable_lead->durable_h1']);
  });
});

describe('disconnect', () => {
  it('removes the connection from the store and the live binding', async () => {
    initGroupProjectLifecycle();
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    await call('create_group_project', { name: 'Raid', members: ['h1'] });

    const res = await call('disconnect_agents', { from: 'h1', to: 'lead' });
    expect(res.text).toMatch(/Disconnected h1 → lead/);
    expect(boundPairs()).toEqual(['durable_h1->gp_1', 'durable_lead->durable_h1']);

    const left = await call('remove_from_group_project', { project: 'Raid', helper: 'h1' });
    expect(left.text).toMatch(/left "Raid"/);
    expect(boundPairs()).toEqual(['durable_lead->durable_h1']);
    expect((await readConnections(projectPath)).map(pairKey)).toEqual(['durable_lead->durable_h1']);

    // It stays gone after a restart.
    restart();
    await rebuildPersistedBindings();
    expect(boundPairs()).toEqual(['durable_lead->durable_h1']);
  });

  it('never removes a canvas wire for the same pair', async () => {
    const canvasWires: PersistedBinding[] = [
      { agentId: 'durable_h1', targetId: 'durable_h2', targetKind: 'agent', label: 'h2 card' },
    ];
    _resetPersistedBindingSourcesForTesting();
    registerPersistedBindingSource({ id: 'canvas-wires', collect: async () => canvasWires });
    registerPersistedBindingSource(orchestratorConnectionSource);
    await rebuildPersistedBindings();

    const connected = await call('connect_agents', { from: 'h1', to: 'h2' });
    expect(connected.text).toMatch(/already connected/);
    const res = await call('disconnect_agents', { from: 'h1', to: 'h2' });
    expect(res.text).toMatch(/canvas wire/);
    expect(boundPairs()).toEqual(['durable_h1->durable_h2']);
    expect(await readConnections(projectPath)).toEqual([]);
  });

  it('leaves a pair the user drew on the canvas after the tool connected it', async () => {
    await call('connect_agents', { from: 'h1', to: 'h2' });
    // The user draws the same wire: it is the user's now.
    clearBindingRemovedByUser('durable_h1', 'durable_h2');
    bindingManager.bind('durable_h1', { targetId: 'durable_h2', targetKind: 'agent', label: 'h2' });

    await call('disconnect_agents', { from: 'h1', to: 'h2' });
    expect(boundPairs()).toEqual(['durable_h1->durable_h2']);
  });

  it('reports a pair that was not connected', async () => {
    const res = await call('disconnect_agents', { from: 'h1', to: 'h2', twoWay: true });
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/was not connected/);
  });
});

describe('helper disposal', () => {
  it('drops a disposed helper\'s connections from the store and its live bindings', async () => {
    const { stop, rebuilt } = watchWithRebuilds();
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    await call('connect_agents', { from: 'h2', to: 'lead' });
    await call('create_group_project', { name: 'Raid', members: ['h1', 'h2'] });

    setAgents(configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h1' ? { ...a, disposedAt: '2026-10-18T02:00:00.000Z' } : a));
    await rebuilt(1);

    expect(boundPairs()).toEqual(['durable_h2->durable_lead', 'durable_h2->gp_1']);
    expect((await readConnections(projectPath)).map(pairKey).sort()).toEqual(['durable_h2->durable_lead', 'durable_h2->gp_1']);

    // A deleted helper goes the same way.
    setAgents(configs.get(projectPath)!.filter((a) => a.id !== 'durable_h2'));
    await rebuilt(2);
    expect(boundPairs()).toEqual([]);
    expect(await readConnections(projectPath)).toEqual([]);
    stop();
  });

  it('skips a disposed helper at startup even if the store still lists it', async () => {
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    configs.set(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h1' ? { ...a, disposedAt: '2026-10-18T02:00:00.000Z' } : a));
    restart();
    await rebuildPersistedBindings();
    expect(boundPairs()).toEqual([]);
  });
});

describe('store', () => {
  const storeDir = () => path.dirname(connectionsStorePath(projectPath));
  const asideFiles = () => fs.readdirSync(storeDir()).filter((f) => f.includes('.corrupt-'));

  it('writes atomically and leaves no temp files', async () => {
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    expect(fs.readdirSync(storeDir())).toEqual(['orchestrator-connections.json']);
    const stored = JSON.parse(fs.readFileSync(connectionsStorePath(projectPath), 'utf-8'));
    expect(stored.version).toBe(1);
  });

  it('saves every connection from concurrent tool calls', async () => {
    const results = await Promise.all([
      call('connect_agents', { from: 'lead', to: 'h1' }),
      call('connect_agents', { from: 'h1', to: 'h2' }),
      call('connect_agents', { from: 'h2', to: 'lead' }),
      call('create_group_project', { name: 'Raid', members: ['h1', 'h2'] }),
      call('connect_agents', { from: 'h1', to: 'lead' }),
    ]);
    expect(results.every((r) => !r.isError)).toBe(true);
    const expected = [
      'durable_h1->durable_h2', 'durable_h1->durable_lead', 'durable_h1->gp_1',
      'durable_h2->durable_lead', 'durable_h2->gp_1', 'durable_lead->durable_h1',
    ];
    expect((await readConnections(projectPath)).map(pairKey).sort()).toEqual(expected);
    expect(boundPairs()).toEqual(expected);

    await Promise.all([
      call('disconnect_agents', { from: 'lead', to: 'h1' }),
      call('disconnect_agents', { from: 'h1', to: 'h2' }),
      call('remove_from_group_project', { project: 'Raid', helper: 'h1' }),
    ]);
    const left = ['durable_h1->durable_lead', 'durable_h2->durable_lead', 'durable_h2->gp_1'];
    expect((await readConnections(projectPath)).map(pairKey).sort()).toEqual(left);
    expect(boundPairs()).toEqual(left);
  });

  it('moves a corrupt file aside, continues empty, and the tools work after it', async () => {
    await call('connect_agents', { from: 'lead', to: 'h1' });
    fs.writeFileSync(connectionsStorePath(projectPath), '{ torn');

    const result = await rebuildPersistedBindings();
    expect(result.sources[0]).toMatchObject({ collected: 0, pruned: 1 });
    expect(boundPairs()).toEqual([]);
    expect(asideFiles()).toHaveLength(1);
    expect(fs.readFileSync(path.join(storeDir(), asideFiles()[0]), 'utf-8')).toBe('{ torn');

    const res = await call('connect_agents', { from: 'h1', to: 'h2' });
    expect(res.isError).toBe(false);
    expect((await readConnections(projectPath)).map(pairKey)).toEqual(['durable_h1->durable_h2']);
    expect(boundPairs()).toEqual(['durable_h1->durable_h2']);
  });

  it('moves aside a file that parses but is not a connections store', async () => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(connectionsStorePath(projectPath), JSON.stringify({ connections: [] }));
    const res = await call('connect_agents', { from: 'lead', to: 'h1' });
    expect(res.isError).toBe(false);
    expect(asideFiles()).toHaveLength(1);
    expect((await readConnections(projectPath)).map(pairKey)).toEqual(['durable_lead->durable_h1']);
  });

  it('keeps entries it does not recognize when it rewrites the store', async () => {
    const future = { ownerId: 'durable_lead', agentId: 'durable_h1', targetId: 'term_1', targetKind: 'terminal' };
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(connectionsStorePath(projectPath), JSON.stringify({ version: 1, connections: [future] }));

    await call('connect_agents', { from: 'lead', to: 'h1' });
    await call('disconnect_agents', { from: 'lead', to: 'h1' });
    const stored = JSON.parse(fs.readFileSync(connectionsStorePath(projectPath), 'utf-8'));
    expect(stored.connections).toEqual([future]);
  });

  it('reads a store from a newer version but never rewrites it', async () => {
    const entry = { ownerId: 'durable_lead', agentId: 'durable_lead', targetId: 'durable_h1', targetKind: 'agent', createdAt: '' };
    const body = JSON.stringify({ version: 2, connections: [entry] });
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(connectionsStorePath(projectPath), body);

    await rebuildPersistedBindings();
    expect(boundPairs()).toEqual(['durable_lead->durable_h1']);
    const res = await call('connect_agents', { from: 'h1', to: 'h2' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/newer version/);
    expect(fs.readFileSync(connectionsStorePath(projectPath), 'utf-8')).toBe(body);
  });

  it('never moves aside a store from a newer version, even one it cannot make sense of', async () => {
    const body = JSON.stringify({ version: 3, connections: { shape: 'changed' } });
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(connectionsStorePath(projectPath), body);

    expect(await readConnections(projectPath)).toEqual([]);
    const res = await call('connect_agents', { from: 'lead', to: 'h1' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/newer version/);
    expect(asideFiles()).toEqual([]);
    expect(fs.readFileSync(connectionsStorePath(projectPath), 'utf-8')).toBe(body);
  });

  it('only removes the caller\'s own entries from the store', async () => {
    // An entry another orchestrator owns for the same pair (left over from a reparent).
    const foreign = { ownerId: 'durable_other', agentId: 'durable_lead', targetId: 'durable_h1', targetKind: 'agent', createdAt: '' };
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(connectionsStorePath(projectPath), JSON.stringify({ version: 1, connections: [foreign] }));
    await call('connect_agents', { from: 'lead', to: 'h1' });

    await call('disconnect_agents', { from: 'lead', to: 'h1' });
    const stored = JSON.parse(fs.readFileSync(connectionsStorePath(projectPath), 'utf-8'));
    expect(stored.connections).toEqual([foreign]);
    // The foreign entry is out of its owner's scope, so it binds nothing.
    expect(boundPairs()).toEqual([]);
  });
});

describe('scope over time', () => {
  const setup = async () => {
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    await call('connect_agents', { from: 'h1', to: 'h2' });
    await call('create_group_project', { name: 'Raid', members: ['lead', 'h1', 'h2'] });
  };
  const watchAndWait = async (agents: DurableAgentConfig[]) => {
    const { stop, rebuilt } = watchWithRebuilds();
    setAgents(agents);
    await rebuilt(1);
    stop();
  };

  it('drops a reparented helper\'s connections and memberships', async () => {
    await setup();
    await watchAndWait(configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h1' ? { ...a, parentAgentId: 'durable_other' } : a));

    expect(boundPairs()).toEqual(['durable_h2->gp_1', 'durable_lead->gp_1']);
    expect((await readConnections(projectPath)).map(pairKey).sort()).toEqual(['durable_h2->gp_1', 'durable_lead->gp_1']);
  });

  it('drops every helper connection when the orchestrator releases its helpers', async () => {
    await setup();
    // Orchestration turned off (or the orchestrator deleted) with "keep helpers".
    await watchAndWait(configs.get(projectPath)!.map((a) =>
      a.parentAgentId === 'durable_lead' ? { ...a, parentAgentId: undefined } : a));

    expect(boundPairs()).toEqual(['durable_lead->gp_1']);
    expect((await readConnections(projectPath)).map(pairKey)).toEqual(['durable_lead->gp_1']);
  });

  it('drops everything an orchestrator owned once it is deleted', async () => {
    await setup();
    await watchAndWait(configs.get(projectPath)!.filter((a) => a.id !== 'durable_lead'));
    expect(boundPairs()).toEqual([]);
    expect(await readConnections(projectPath)).toEqual([]);
  });

  it('skips out-of-scope entries at restore, before any agent change', async () => {
    await setup();
    configs.set(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h2' ? { ...a, parentAgentId: undefined } : a));
    restart();
    await rebuildPersistedBindings();
    expect(boundPairs()).toEqual(['durable_h1->durable_lead', 'durable_h1->gp_1', 'durable_lead->durable_h1', 'durable_lead->gp_1']);
  });
});

describe('names and user removals', () => {
  it('refuses an ambiguous name and lists the matching ids', async () => {
    configs.set(projectPath, [...configs.get(projectPath)!, agent('durable_h1c', { name: 'h1', parentAgentId: 'durable_lead' })]);
    const res = await call('connect_agents', { from: 'lead', to: 'h1' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/More than one/);
    expect(res.text).toContain('durable_h1, durable_h1c');
    expect(await readConnections(projectPath)).toEqual([]);

    // Case-insensitive matches are ambiguous too; an id always works.
    expect((await call('connect_agents', { from: 'lead', to: 'H1' })).isError).toBe(true);
    expect((await call('connect_agents', { from: 'lead', to: 'durable_h1c' })).isError).toBe(false);
  });

  it('refuses a connection the user removed this session, and saves nothing', async () => {
    await call('connect_agents', { from: 'lead', to: 'h1' });
    // The user deletes the wire in the UI.
    bindingManager.unbind('durable_lead', 'durable_h1');
    markBindingRemovedByUser('durable_lead', 'durable_h1');
    await call('disconnect_agents', { from: 'lead', to: 'h1' });

    const res = await call('connect_agents', { from: 'lead', to: 'h1' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^The user removed this connection\./);
    expect(boundPairs()).toEqual([]);
    expect(await readConnections(projectPath)).toEqual([]);
    expect(isBindingRemovedByUser('durable_lead', 'durable_h1')).toBe(true);
  });
  it('drops the saved entry when the user removes the pair while the tool is binding it', async () => {
    storeHooks.afterAdd = () => markBindingRemovedByUser('durable_lead', 'durable_h1');
    const res = await call('connect_agents', { from: 'lead', to: 'h1' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/The user removed this connection/);
    expect(boundPairs()).toEqual([]);
    expect(await readConnections(projectPath)).toEqual([]);
  });

  it('keeps a tool-made wire the user deleted in the UI deleted across restarts', async () => {
    const { stop } = watchWithRebuilds();
    await call('connect_agents', { from: 'lead', to: 'h1', twoWay: true });
    await call('create_group_project', { name: 'Raid', members: ['h1'] });

    // The user deletes lead -> h1 and h1's membership in the UI (IPC UNBIND).
    for (const [agentId, targetId] of [['durable_lead', 'durable_h1'], ['durable_h1', 'gp_1']]) {
      bindingManager.unbind(agentId, targetId);
      markBindingRemovedByUser(agentId, targetId);
    }
    await vi.waitFor(async () => {
      expect((await readConnections(projectPath)).map(pairKey)).toEqual(['durable_h1->durable_lead']);
    });
    stop();

    restart();
    await rebuildPersistedBindings();
    expect(boundPairs()).toEqual(['durable_h1->durable_lead']);
  });
});
