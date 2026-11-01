/**
 * Dispatcher ↔ orchestrator wires (#2537): derived from the orchestration
 * policy's `orchestrate` and `connectToDispatcher`, only while the Dispatcher
 * is on, rebuilt in main alongside the other persisted wires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../shared/types';

const { configs, projects, configListeners, dispatcher, unreadablePolicies } = vi.hoisted(() => ({
  configs: new Map<string, DurableAgentConfig[]>(),
  projects: {
    list: [] as Array<{ id: string; name: string; path: string; displayName?: string }>,
    listeners: new Set<() => void>(),
  },
  configListeners: new Set<(projectPath: string) => void>(),
  dispatcher: {
    enabled: true,
    id: 'durable_dispatcher' as string | null,
    path: '',
    listeners: new Set<() => void>(),
  },
  unreadablePolicies: new Set<string>(),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({
  list: vi.fn(async () => projects.list),
  onProjectsChanged: (listener: () => void) => {
    projects.listeners.add(listener);
    return () => projects.listeners.delete(listener);
  },
}));
vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (projectPath: string) => {
    const agents = configs.get(projectPath);
    if (!agents) throw new Error('EACCES');
    return agents;
  }),
  onAgentConfigChanged: vi.fn((listener: (projectPath: string) => void) => {
    configListeners.add(listener);
    return () => configListeners.delete(listener);
  }),
}));
// The policy resolves from the agent's own orchestration config here; the
// persona layer is covered by orchestration-policy's own tests.
vi.mock('./orchestration-policy', () => ({
  resolveOrchestrationPolicies: vi.fn(async (projectPath: string, agents: DurableAgentConfig[]) => {
    if (unreadablePolicies.has(projectPath)) throw new Error('persona unreadable');
    return new Map(agents.map((a) => [a.id, {
      orchestrate: a.orchestration?.orchestrate ?? false,
      connectToDispatcher: a.orchestration?.connectToDispatcher ?? false,
    }]));
  }),
}));
vi.mock('./dispatcher/dispatcher-service', () => ({
  DISPATCHER_NAME: 'Dispatcher',
  getDispatcherAgentId: () => dispatcher.id,
  isDispatcherEnabled: () => dispatcher.enabled,
  isDispatcherPath: (p: string) => p === dispatcher.path,
  onDispatcherChanged: (listener: () => void) => {
    dispatcher.listeners.add(listener);
    return () => dispatcher.listeners.delete(listener);
  },
}));
vi.mock('./pty-manager', () => ({ write: vi.fn(), isRunning: vi.fn(() => true) }));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  _resetPersistedBindingSourcesForTesting,
} from './persisted-bindings';
import {
  dispatcherWireBindingSource,
  dispatcherWiresForProject,
  watchDispatcherWires,
  _resetDispatcherWireSourceForTesting,
} from './dispatcher-wire-source';
import { notifyPersonaChanged, notifyProjectDefaultPersonaChanged } from './persona-change-hook';
import { listDurable } from './agent-config';
import { resolveOrchestrationPolicies } from './orchestration-policy';

const projectPath = path.join(os.tmpdir(), 'clubhouse-dispatcher-wires', 'wardfall');
const otherProjectPath = path.join(os.tmpdir(), 'clubhouse-dispatcher-wires', 'other');
const DISPATCHER = 'durable_dispatcher';

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id,
  name: id.replace('durable_', ''),
  color: 'emerald',
  createdAt: '2026-10-31T00:00:00.000Z',
  ...extra,
} as DurableAgentConfig);

const connected = { orchestrate: true, connectToDispatcher: true };

const key = (b: { agentId: string; targetId: string }) => `${b.agentId}->${b.targetId}`;
const boundPairs = () => bindingManager.getAllBindings().map(key).sort();

function setAgents(p: string, agents: DurableAgentConfig[]): void {
  configs.set(p, agents);
  for (const listener of configListeners) listener(p);
}

function setProjects(list: typeof projects.list): void {
  projects.list = list;
  for (const listener of projects.listeners) listener();
}

function setDispatcher(next: { enabled?: boolean; id?: string | null }): void {
  Object.assign(dispatcher, next);
  for (const listener of dispatcher.listeners) listener();
}

async function rebuild() {
  registerPersistedBindingSource(dispatcherWireBindingSource);
  return rebuildPersistedBindings();
}

beforeEach(() => {
  configs.clear();
  configListeners.clear();
  unreadablePolicies.clear();
  dispatcher.enabled = true;
  dispatcher.id = DISPATCHER;
  dispatcher.path = path.join(os.tmpdir(), 'clubhouse-dispatcher-wires', 'dispatcher');
  dispatcher.listeners.clear();
  projects.listeners.clear();
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
  _resetDispatcherWireSourceForTesting();
  projects.list = [
    { id: 'proj_w', name: 'wardfall', displayName: 'Wardfall', path: projectPath },
    { id: 'proj_o', name: 'other', path: otherProjectPath },
  ];
  configs.set(projectPath, [
    agent('durable_lead', { orchestration: connected }),
    agent('durable_quiet', { orchestration: { orchestrate: true } }),
    agent('durable_worker'),
  ]);
  configs.set(otherProjectPath, [agent('durable_o1')]);
});

const stops: Array<() => void> = [];

afterEach(() => {
  // The persona hook's listeners outlive a test, so every watcher is stopped.
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

describe('dispatcherWiresForProject', () => {
  it('wires an orchestrator with the switch on both ways, named Dispatcher at its end', async () => {
    const out = await dispatcherWiresForProject(DISPATCHER, projectPath, configs.get(projectPath)!, 'Wardfall');
    expect(out).toEqual([
      { agentId: DISPATCHER, targetId: 'durable_lead', targetKind: 'agent', label: 'lead', agentName: 'Dispatcher', targetName: 'lead', projectName: 'Wardfall' },
      { agentId: 'durable_lead', targetId: DISPATCHER, targetKind: 'agent', label: 'Dispatcher', agentName: 'lead', targetName: 'Dispatcher', projectName: 'Wardfall' },
    ]);
  });

  it('needs orchestration on as well as the switch', async () => {
    const out = await dispatcherWiresForProject(DISPATCHER, projectPath, [
      agent('durable_x', { orchestration: { connectToDispatcher: true } }),
    ]);
    expect(out).toEqual([]);
  });

  it('skips disposed agents and the Dispatcher itself', async () => {
    const out = await dispatcherWiresForProject(DISPATCHER, projectPath, [
      agent('durable_gone', { orchestration: connected, disposedAt: '2026-10-31T00:00:00.000Z' }),
      agent(DISPATCHER, { orchestration: connected }),
    ]);
    expect(out).toEqual([]);
  });
});

describe('Dispatcher wire rebuild', () => {
  it('binds only the connected orchestrator, both ways', async () => {
    const result = await rebuild();
    expect(boundPairs()).toEqual([`${DISPATCHER}->durable_lead`, `durable_lead->${DISPATCHER}`]);
    expect(result.sources.find((s) => s.id === 'dispatcher-wires')).toMatchObject({ collected: 2, created: 2 });
  });

  it('binds nothing while the Dispatcher is off, and removes its wires when it turns off', async () => {
    dispatcher.enabled = false;
    await rebuild();
    expect(boundPairs()).toEqual([]);

    dispatcher.enabled = true;
    await rebuild();
    expect(boundPairs()).toHaveLength(2);

    dispatcher.enabled = false;
    await rebuild();
    expect(boundPairs()).toEqual([]);
  });

  it('binds nothing before the Dispatcher was first created', async () => {
    dispatcher.id = null;
    await rebuild();
    expect(boundPairs()).toEqual([]);
  });

  it('adds the wire when the switch turns on and removes it when it turns off', async () => {
    await rebuild();
    configs.set(projectPath, [
      agent('durable_lead', { orchestration: connected }),
      agent('durable_quiet', { orchestration: connected }),
    ]);
    await rebuild();
    expect(boundPairs()).toContain(`${DISPATCHER}->durable_quiet`);
    expect(boundPairs()).toContain(`durable_quiet->${DISPATCHER}`);

    configs.set(projectPath, [
      agent('durable_lead', { orchestration: { orchestrate: true, connectToDispatcher: false } }),
      agent('durable_quiet', { orchestration: connected }),
    ]);
    await rebuild();
    expect(boundPairs()).toEqual([`${DISPATCHER}->durable_quiet`, `durable_quiet->${DISPATCHER}`]);
  });

  it('removes the wire of an orchestrator that turns orchestration off', async () => {
    await rebuild();
    configs.set(projectPath, [agent('durable_lead', { orchestration: { orchestrate: false, connectToDispatcher: true } })]);
    await rebuild();
    expect(boundPairs()).toEqual([]);
  });

  it('wires orchestrators in every registered project', async () => {
    configs.set(otherProjectPath, [agent('durable_o1', { orchestration: connected })]);
    await rebuild();
    expect(boundPairs()).toEqual([
      `${DISPATCHER}->durable_lead`, `${DISPATCHER}->durable_o1`,
      `durable_lead->${DISPATCHER}`, `durable_o1->${DISPATCHER}`,
    ].sort());
    expect(bindingManager.getBindingsForAgent('durable_o1')[0]).toMatchObject({ label: 'Dispatcher', projectName: 'other' });
  });

  it('comes back after a restart, with nothing but the policy to go on', async () => {
    await rebuild();
    bindingManager._resetForTesting();
    _resetPersistedBindingSourcesForTesting();
    _resetDispatcherWireSourceForTesting();
    await rebuild();
    expect(boundPairs()).toEqual([`${DISPATCHER}->durable_lead`, `durable_lead->${DISPATCHER}`]);
  });
});

describe('a removed project', () => {
  it('loses its wires on the next rebuild, with no config write', async () => {
    configs.set(otherProjectPath, [agent('durable_o1', { orchestration: connected })]);
    await rebuild();
    expect(boundPairs()).toContain(`durable_o1->${DISPATCHER}`);

    projects.list = projects.list.filter((p) => p.path !== otherProjectPath);
    await rebuild();
    expect(boundPairs()).toEqual([`${DISPATCHER}->durable_lead`, `durable_lead->${DISPATCHER}`]);
  });
});

describe('a project whose agents cannot be read', () => {
  it('keeps its wires unverified, neither applied nor pruned, until a read succeeds', async () => {
    await rebuild();
    configs.delete(projectPath);
    const result = await rebuild();
    expect(boundPairs()).toEqual([`${DISPATCHER}->durable_lead`, `durable_lead->${DISPATCHER}`]);
    expect(result.sources.find((s) => s.id === 'dispatcher-wires')).toMatchObject({ collected: 0 });

    configs.set(projectPath, [agent('durable_lead')]);
    await rebuild();
    expect(boundPairs()).toEqual([]);
  });

  it('treats a project whose policies cannot be resolved the same way', async () => {
    await rebuild();
    unreadablePolicies.add(projectPath);
    await rebuild();
    expect(boundPairs()).toHaveLength(2);
  });

  it('keeps nothing from a Dispatcher that was turned off in between', async () => {
    await rebuild();
    dispatcher.enabled = false;
    await rebuild();
    dispatcher.enabled = true;
    configs.delete(projectPath);
    await rebuild();
    expect(boundPairs()).toEqual([]);
  });
});

describe('watchDispatcherWires', () => {
  async function watched() {
    vi.useFakeTimers();
    await rebuild();
    const onChange = vi.fn(() => rebuildPersistedBindings());
    const stop = watchDispatcherWires(onChange);
    stops.push(stop);
    const flush = () => vi.advanceTimersByTimeAsync(100);
    return { onChange, stop, flush };
  }

  it('rebuilds when an orchestrator turns the switch on or off, and not for other writes', async () => {
    const { onChange, stop, flush } = await watched();

    setAgents(projectPath, [...configs.get(projectPath)!, agent('durable_new')]);
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    setAgents(projectPath, [agent('durable_lead', { orchestration: connected }), agent('durable_quiet', { orchestration: connected })]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).toContain(`durable_quiet->${DISPATCHER}`);

    setAgents(projectPath, [agent('durable_lead', { orchestration: connected })]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(boundPairs()).toEqual([`${DISPATCHER}->durable_lead`, `durable_lead->${DISPATCHER}`]);

    stop();
    setAgents(projectPath, []);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when the Dispatcher turns off and on', async () => {
    const { onChange, flush } = await watched();

    setDispatcher({ enabled: false });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).toEqual([]);

    setDispatcher({ enabled: true });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(boundPairs()).toHaveLength(2);
  });

  it('wires up once the Dispatcher is first created', async () => {
    dispatcher.id = null;
    const { onChange, flush } = await watched();
    expect(boundPairs()).toEqual([]);

    setDispatcher({ id: DISPATCHER });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).toHaveLength(2);
  });

  it('rebuilds after a persona change turns the policy on', async () => {
    const { onChange, flush } = await watched();
    // The persona's defaults moved; agents.json itself is untouched, so only the persona hook says so.
    configs.set(projectPath, [agent('durable_lead', { orchestration: connected }), agent('durable_quiet', { orchestration: connected })]);
    await notifyPersonaChanged(projectPath, 'durable_quiet', undefined);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).toContain(`${DISPATCHER}->durable_quiet`);
  });

  it('rebuilds when a project with a connected orchestrator is removed, and when one is added', async () => {
    configs.set(otherProjectPath, [agent('durable_o1', { orchestration: connected })]);
    const { onChange, flush } = await watched();
    expect(boundPairs()).toContain(`durable_o1->${DISPATCHER}`);
    const both = projects.list;

    setProjects(both.filter((p) => p.path !== otherProjectPath));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).toEqual([`${DISPATCHER}->durable_lead`, `durable_lead->${DISPATCHER}`]);

    // Nothing left to change: a later write does not keep rebuilding for the removed project.
    setAgents(projectPath, [...configs.get(projectPath)!]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);

    setProjects(both);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(boundPairs()).toContain(`durable_o1->${DISPATCHER}`);
  });

  it('a project change that leaves the wires as they were does not rebuild', async () => {
    const { onChange, flush } = await watched();
    setProjects(projects.list.map((p) => (p.path === projectPath ? { ...p, displayName: 'Renamed' } : p)));
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  describe('reads only what a change can affect', () => {
    const readPaths = () => [
      ...vi.mocked(listDurable).mock.calls.map(([p]) => p),
      ...vi.mocked(resolveOrchestrationPolicies).mock.calls.map(([p]) => p),
    ];
    async function watchedAndCleared() {
      const watcher = await watched();
      vi.mocked(listDurable).mockClear();
      vi.mocked(resolveOrchestrationPolicies).mockClear();
      return watcher;
    }

    it('an agent write in one project reads only that project', async () => {
      const { onChange, flush } = await watchedAndCleared();
      setAgents(projectPath, [...configs.get(projectPath)!, agent('durable_new')]);
      await flush();
      expect(onChange).not.toHaveBeenCalled();
      expect(vi.mocked(listDurable).mock.calls.map(([p]) => p)).toEqual([projectPath]);
      expect(vi.mocked(resolveOrchestrationPolicies).mock.calls.map(([p]) => p)).toEqual([projectPath]);
    });

    it('a persona change reads only its project', async () => {
      const { flush } = await watchedAndCleared();
      await notifyPersonaChanged(projectPath, 'durable_quiet', undefined);
      await notifyProjectDefaultPersonaChanged(projectPath, undefined);
      await flush();
      expect(readPaths()).not.toContain(otherProjectPath);
      expect(readPaths()).toContain(projectPath);
    });

    it('a write to the Dispatcher\'s own folder reads nothing', async () => {
      const { onChange, flush } = await watchedAndCleared();
      for (const listener of configListeners) listener(dispatcher.path);
      await flush();
      expect(readPaths()).toEqual([]);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('a Dispatcher toggle reads every project', async () => {
      const { flush } = await watchedAndCleared();
      setDispatcher({ id: DISPATCHER });
      await flush();
      expect(new Set(vi.mocked(listDurable).mock.calls.map(([p]) => p))).toEqual(new Set([projectPath, otherProjectPath]));
    });

    it('a path no project is registered under reads every project', async () => {
      const { flush } = await watchedAndCleared();
      for (const listener of configListeners) listener(path.join(projectPath, 'elsewhere'));
      await flush();
      expect(new Set(vi.mocked(listDurable).mock.calls.map(([p]) => p))).toEqual(new Set([projectPath, otherProjectPath]));
    });
  });

  it('ignores a project it cannot read, and retries a rebuild that did not commit', async () => {
    const { onChange, flush } = await watched();
    configs.delete(projectPath);
    for (const listener of configListeners) listener(projectPath);
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    // A rebuild that never runs: the change is retried, then given up until the next change.
    onChange.mockImplementation(async () => ({ sources: [] }));
    setAgents(otherProjectPath, [agent('durable_o1', { orchestration: connected })]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onChange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onChange).toHaveBeenCalledTimes(5);
  });
});
