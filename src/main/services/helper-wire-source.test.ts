/**
 * Orchestrator ↔ helper wires (#2225): derived from the agent config's
 * `parentAgentId`, rebuilt in main at startup alongside the canvas wires, and
 * kept in step with agents.json.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../shared/types';

const { configs, projects, configListeners, ptyWrite, getBoard } = vi.hoisted(() => ({
  configs: new Map<string, DurableAgentConfig[]>(),
  projects: {
    list: [] as Array<{ id: string; name: string; path: string; displayName?: string }>,
    listeners: new Set<() => void>(),
  },
  configListeners: new Set<(projectPath: string) => void>(),
  ptyWrite: vi.fn(),
  getBoard: vi.fn(),
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
  listDurable: vi.fn(async (projectPath: string) => configs.get(projectPath) ?? []),
  projectKey: vi.fn(async (projectPath: string) => path.resolve(projectPath)),
  onAgentConfigChanged: vi.fn((listener: (projectPath: string) => void) => {
    configListeners.add(listener);
    return () => configListeners.delete(listener);
  }),
}));
// Anything that would announce a member or start polling goes through these.
vi.mock('./pty-manager', () => ({ write: ptyWrite, isRunning: vi.fn(() => true) }));
vi.mock('./group-project-bulletin', () => ({
  getBulletinBoard: getBoard,
  ensureInboxChannel: vi.fn(),
  ensureProjectChannels: vi.fn(),
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  clearBindingRemovedByUser,
  keepHeldBinding,
  markBindingRemovedByUser,
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  _resetPersistedBindingSourcesForTesting,
  type PersistedBinding,
} from './persisted-bindings';
import {
  bindingsFromHelperAgents,
  helperWireBindingSource,
  watchHelperWires,
  _resetHelperWireSourceForTesting,
} from './helper-wire-source';
import { initGroupProjectLifecycle, _resetLifecycleForTesting } from './group-project-lifecycle';

const projectPath = path.join(os.tmpdir(), 'clubhouse-helper-wires', 'wardfall');
const otherProjectPath = path.join(os.tmpdir(), 'clubhouse-helper-wires', 'other');

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id,
  name: id.replace('durable_', ''),
  color: 'emerald',
  createdAt: '2026-10-18T00:00:00.000Z',
  ...extra,
} as DurableAgentConfig);

const key = (b: { agentId: string; targetId: string }) => `${b.agentId}->${b.targetId}`;
const boundPairs = () => bindingManager.getAllBindings().map(key).sort();

function setAgents(p: string, agents: DurableAgentConfig[]): void {
  configs.set(p, agents);
  for (const listener of configListeners) listener(p);
}

beforeEach(() => {
  configs.clear();
  configListeners.clear();
  projects.listeners.clear();
  ptyWrite.mockClear();
  getBoard.mockClear();
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
  _resetHelperWireSourceForTesting();
  _resetLifecycleForTesting();
  projects.list = [
    { id: 'proj_w', name: 'wardfall', displayName: 'Wardfall', path: projectPath },
    { id: 'proj_o', name: 'other', path: otherProjectPath },
  ];
  configs.set(projectPath, [
    agent('durable_lead'),
    agent('durable_h1', { parentAgentId: 'durable_lead', disposable: true }),
    agent('durable_h2', { parentAgentId: 'durable_lead' }),
    agent('durable_solo'),
  ]);
  configs.set(otherProjectPath, [
    agent('durable_o1'),
    agent('durable_o2', { parentAgentId: 'durable_o1' }),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bindingsFromHelperAgents', () => {
  it('wires each live parent and helper both ways, like a bidirectional canvas agent wire', () => {
    const out = bindingsFromHelperAgents(configs.get(projectPath)!, 'Wardfall');
    expect(out).toEqual([
      { agentId: 'durable_lead', targetId: 'durable_h1', targetKind: 'agent', label: 'h1', agentName: 'lead', targetName: 'h1', projectName: 'Wardfall' },
      { agentId: 'durable_h1', targetId: 'durable_lead', targetKind: 'agent', label: 'lead', agentName: 'h1', targetName: 'lead', projectName: 'Wardfall' },
      { agentId: 'durable_lead', targetId: 'durable_h2', targetKind: 'agent', label: 'h2', agentName: 'lead', targetName: 'h2', projectName: 'Wardfall' },
      { agentId: 'durable_h2', targetId: 'durable_lead', targetKind: 'agent', label: 'lead', agentName: 'h2', targetName: 'lead', projectName: 'Wardfall' },
    ]);
  });

  it('skips disposed helpers, disposed parents and parents that are gone', () => {
    const out = bindingsFromHelperAgents([
      agent('durable_p'),
      agent('durable_gone_parent', { parentAgentId: 'durable_missing' }),
      agent('durable_disposed', { parentAgentId: 'durable_p', disposedAt: '2026-10-18T01:00:00.000Z' }),
      agent('durable_dp', { disposedAt: '2026-10-18T01:00:00.000Z' }),
      agent('durable_orphaned', { parentAgentId: 'durable_dp' }),
      agent('durable_self', { parentAgentId: 'durable_self' }),
    ]);
    expect(out).toEqual([]);
  });
});

describe('helper wire rebuild', () => {
  it('rebuilds helper wires from the agent config at startup, with no canvas visited', async () => {
    registerPersistedBindingSource(helperWireBindingSource);
    const result = await rebuildPersistedBindings();

    expect(result.sources).toEqual([
      { id: 'helper-wires', collected: 6, created: 6, existing: 0, removed: 0, invalid: 0, pruned: 0 },
    ]);
    expect(boundPairs()).toEqual([
      'durable_h1->durable_lead',
      'durable_h2->durable_lead',
      'durable_lead->durable_h1',
      'durable_lead->durable_h2',
      'durable_o1->durable_o2',
      'durable_o2->durable_o1',
    ].sort());
    const fromLead = bindingManager.getBindingsForAgent('durable_lead');
    expect(fromLead.map((b) => b.projectName)).toEqual(['Wardfall', 'Wardfall']);
    expect(bindingManager.getBindingsForAgent('durable_o2')[0].projectName).toBe('other');
  });

  it('is idempotent: rebuilding twice gives the same bindings and changes nothing', async () => {
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();
    const before = bindingManager.getAllBindings().map((b) => ({ ...b }));
    const changes = vi.fn();
    bindingManager.onChange(changes);

    const second = await rebuildPersistedBindings();
    expect(second.sources[0]).toMatchObject({ created: 0, existing: 6, pruned: 0 });
    expect(bindingManager.getAllBindings()).toEqual(before);
    expect(changes).not.toHaveBeenCalled();
  });

  it('does not duplicate a pair that a canvas wire also has, in either order', async () => {
    // A bidirectional canvas wire between the lead and h1, as the canvas persists it.
    const canvasWires: PersistedBinding[] = [
      { agentId: 'durable_lead', targetId: 'durable_h1', targetKind: 'agent', label: 'h1 card', agentName: 'lead card', targetName: 'h1 card' },
      { agentId: 'durable_h1', targetId: 'durable_lead', targetKind: 'agent', label: 'lead card', agentName: 'h1 card', targetName: 'lead card' },
    ];
    registerPersistedBindingSource({ id: 'canvas-wires', collect: async () => canvasWires });
    registerPersistedBindingSource(helperWireBindingSource);

    const result = await rebuildPersistedBindings();
    expect(result.sources[1]).toMatchObject({ id: 'helper-wires', created: 4, existing: 2 });
    expect(bindingManager.getBindingsForAgent('durable_lead').filter((b) => b.targetId === 'durable_h1')).toHaveLength(1);
    expect(bindingManager.getAllBindings()).toHaveLength(6);

    // The canvas opens later and binds its wires: nothing is created twice.
    expect(canvasWires.map((b) => bindingManager.bind(b.agentId, b))).toEqual([false, false]);
    expect(bindingManager.getAllBindings()).toHaveLength(6);
  });

  it('removes a disposed helper\'s wires on the next rebuild', async () => {
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    configs.set(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h1' ? { ...a, disposedAt: '2026-10-18T02:00:00.000Z' } : a));
    const result = await rebuildPersistedBindings();

    expect(result.sources[0]).toMatchObject({ collected: 4, pruned: 2 });
    expect(boundPairs()).not.toContain('durable_lead->durable_h1');
    expect(boundPairs()).not.toContain('durable_h1->durable_lead');
    expect(boundPairs()).toContain('durable_lead->durable_h2');
  });

  it('removes a deleted or reparented helper\'s wires and wires the new parent', async () => {
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    configs.set(projectPath, [
      agent('durable_lead'),
      agent('durable_h2', { parentAgentId: 'durable_solo' }),
      agent('durable_solo'),
    ]);
    await rebuildPersistedBindings();

    expect(boundPairs()).toEqual([
      'durable_h2->durable_solo',
      'durable_o1->durable_o2',
      'durable_o2->durable_o1',
      'durable_solo->durable_h2',
    ]);
  });

  it('keeps a disposed helper\'s pair while a canvas still has the wire, or the user drew it', async () => {
    const canvasWires: PersistedBinding[] = [];
    registerPersistedBindingSource({ id: 'canvas-wires', collect: async () => canvasWires });
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    // The user draws lead -> h1 on a canvas; it is saved with the canvas.
    clearBindingRemovedByUser('durable_lead', 'durable_h1');
    bindingManager.bind('durable_lead', { targetId: 'durable_h1', targetKind: 'agent', label: 'h1' });
    canvasWires.push({ agentId: 'durable_h1', targetId: 'durable_lead', targetKind: 'agent', label: 'lead' });

    configs.set(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h1' ? { ...a, disposedAt: '2026-10-18T02:00:00.000Z' } : a));
    const result = await rebuildPersistedBindings();

    expect(result.sources[1]).toMatchObject({ id: 'helper-wires', pruned: 0 });
    expect(boundPairs()).toContain('durable_lead->durable_h1');
    expect(boundPairs()).toContain('durable_h1->durable_lead');
  });

  it('removes nothing in a run where a source failed', async () => {
    let fail = false;
    registerPersistedBindingSource({ id: 'canvas-wires', collect: async () => { if (fail) throw new Error('torn'); return []; } });
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    fail = true;
    configs.set(projectPath, []);
    const result = await rebuildPersistedBindings();
    expect(result.sources[1]).toMatchObject({ pruned: 0 });
    expect(boundPairs()).toContain('durable_lead->durable_h1');

    fail = false;
    expect((await rebuildPersistedBindings()).sources[1]).toMatchObject({ pruned: 4 });
    expect(boundPairs()).toEqual(['durable_o1->durable_o2', 'durable_o2->durable_o1']);
  });

  it('posts no bulletins and starts no polling', async () => {
    initGroupProjectLifecycle();
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();
    configs.set(projectPath, [agent('durable_lead')]);
    await rebuildPersistedBindings();
    await new Promise((r) => setTimeout(r, 50));

    expect(getBoard).not.toHaveBeenCalled();
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});

describe('watchHelperWires', () => {
  const rebuild = () => rebuildPersistedBindings();
  const dispose = (p: string, id: string) =>
    configs.get(p)!.map((a) => (a.id === id ? { ...a, disposedAt: '2026-10-18T03:00:00.000Z' } : a));

  it('rebuilds when a helper is created, disposed or reparented, and ignores other writes', async () => {
    vi.useFakeTimers();
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings(); // commits what is wired now
    const onChange = vi.fn(rebuild);
    const stop = watchHelperWires(onChange);
    const flush = () => vi.advanceTimersByTimeAsync(100);

    // A write that leaves the wires alone (e.g. a session touch).
    setAgents(projectPath, configs.get(projectPath)!.map((a) => ({ ...a, lastSessionId: 'x' } as DurableAgentConfig)));
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    // A helper is created; a burst of writes rebuilds once.
    const created = [...configs.get(projectPath)!, agent('durable_h3', { parentAgentId: 'durable_lead' })];
    setAgents(projectPath, created);
    setAgents(projectPath, created);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).toContain('durable_lead->durable_h3');

    // Disposed.
    setAgents(projectPath, dispose(projectPath, 'durable_h3'));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(boundPairs()).not.toContain('durable_lead->durable_h3');

    // Reparented away (o2 becomes a top-level agent).
    setAgents(otherProjectPath, [agent('durable_o1'), agent('durable_o2')]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(boundPairs()).not.toContain('durable_o1->durable_o2');

    stop();
    setAgents(otherProjectPath, [agent('durable_o1'), agent('durable_o2', { parentAgentId: 'durable_o1' })]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('rebuilds when a project with helper wires is removed, with no config write', async () => {
    vi.useFakeTimers();
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();
    expect(boundPairs()).toContain('durable_o1->durable_o2');
    const onChange = vi.fn(rebuild);
    const stop = watchHelperWires(onChange);
    const flush = () => vi.advanceTimersByTimeAsync(100);

    projects.list = projects.list.filter((p) => p.path !== otherProjectPath);
    for (const listener of projects.listeners) listener();
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).not.toContain('durable_o1->durable_o2');
    expect(boundPairs()).toContain('durable_lead->durable_h1');

    // Committed: the removed project doesn't keep asking for a rebuild.
    setAgents(projectPath, [...configs.get(projectPath)!]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps a change pending until a rebuild commits it, and retries', async () => {
    vi.useFakeTimers();
    let canvasFails = false;
    registerPersistedBindingSource({ id: 'canvas-wires', collect: async () => { if (canvasFails) throw new Error('torn'); return []; } });
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();
    const onChange = vi.fn(rebuild);
    watchHelperWires(onChange);

    // The rebuild after the dispose fails elsewhere, so nothing is pruned yet.
    canvasFails = true;
    setAgents(projectPath, dispose(projectPath, 'durable_h1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).toContain('durable_lead->durable_h1');

    // The retry after the store recovers prunes it, with no further config write.
    canvasFails = false;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(boundPairs()).not.toContain('durable_lead->durable_h1');

    // Committed: nothing more runs.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('rebuilds on the next write after a startup rebuild that was incomplete', async () => {
    vi.useFakeTimers();
    let canvasFails = true;
    registerPersistedBindingSource({ id: 'canvas-wires', collect: async () => { if (canvasFails) throw new Error('torn'); return []; } });
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings(); // helper wires created, nothing committed
    canvasFails = false;
    const onChange = vi.fn(rebuild);
    watchHelperWires(onChange);

    // The disposal leaves the signature where an incomplete run can't vouch for it.
    setAgents(projectPath, dispose(projectPath, 'durable_h1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs()).not.toContain('durable_lead->durable_h1');
  });

  it('end to end: an agents.json change reaches the rebuild through onAgentConfigChanged', async () => {
    vi.useFakeTimers();
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();
    watchHelperWires(rebuild);
    expect(configListeners.size).toBe(1);

    setAgents(projectPath, dispose(projectPath, 'durable_h2'));
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(boundPairs()).not.toContain('durable_lead->durable_h2'));
    expect(boundPairs()).not.toContain('durable_h2->durable_lead');
    expect(boundPairs()).toContain('durable_lead->durable_h1');
  });
});

describe('a helper whose orchestrator is in another project (#2513)', () => {
  /** The lead in Wardfall gets a helper in the other project. */
  const withFarHelper = (extra: Partial<DurableAgentConfig> = {}) => [
    ...configs.get(otherProjectPath)!,
    agent('durable_far', { parentAgentId: 'durable_lead', parentProjectPath: projectPath, ...extra }),
  ];

  it('wires the orchestrator and the helper both ways, each labelled with its target\'s project', async () => {
    configs.set(otherProjectPath, withFarHelper());
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    expect(boundPairs()).toContain('durable_lead->durable_far');
    expect(boundPairs()).toContain('durable_far->durable_lead');
    const toFar = bindingManager.getBindingsForAgent('durable_lead').find((b) => b.targetId === 'durable_far');
    const toLead = bindingManager.getBindingsForAgent('durable_far').find((b) => b.targetId === 'durable_lead');
    expect(toFar).toMatchObject({ agentName: 'lead', targetName: 'far', projectName: 'other' });
    expect(toLead).toMatchObject({ agentName: 'far', targetName: 'lead', projectName: 'Wardfall' });
  });

  it('does not wire a parent link to a project that is not registered, or to a same-id agent in the helper\'s project', async () => {
    configs.set(otherProjectPath, [
      ...configs.get(otherProjectPath)!,
      agent('durable_lost', { parentAgentId: 'durable_lead', parentProjectPath: path.join(os.tmpdir(), 'clubhouse-helper-wires', 'gone') }),
      agent('durable_twin', { parentAgentId: 'durable_o1', parentProjectPath: projectPath }),
    ]);
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    expect(boundPairs().filter((p) => p.includes('durable_lost') || p.includes('durable_twin'))).toEqual([]);
  });

  it('rebuilds when the orchestrator\'s project changes, though the helper\'s project did not', async () => {
    vi.useFakeTimers();
    configs.set(otherProjectPath, withFarHelper());
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();
    const onChange = vi.fn(() => rebuildPersistedBindings());
    watchHelperWires(onChange);

    // The orchestrator is deleted from Wardfall; the helper's row in the other project is untouched.
    setAgents(projectPath, configs.get(projectPath)!.filter((a) => a.id !== 'durable_lead'));
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(boundPairs().filter((p) => p.includes('durable_far'))).toEqual([]);
  });

  it('keeps the wires while the orchestrator\'s project cannot be read', async () => {
    configs.set(otherProjectPath, withFarHelper());
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    const { listDurable } = await import('./agent-config');
    vi.mocked(listDurable).mockImplementation(async (p: string) => {
      if (p === projectPath) throw new Error('EACCES');
      return configs.get(p) ?? [];
    });
    try {
      await rebuildPersistedBindings();
      expect(boundPairs()).toContain('durable_lead->durable_far');
      expect(boundPairs()).toContain('durable_far->durable_lead');
    } finally {
      vi.mocked(listDurable).mockImplementation(async (p: string) => configs.get(p) ?? []);
    }
  });
});

describe('a project whose agents cannot be read', () => {
  it('skips that project and keeps its wires, while other projects still update', async () => {
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    const { listDurable } = await import('./agent-config');
    vi.mocked(listDurable).mockImplementation(async (p: string) => {
      if (p === projectPath) throw new Error('EACCES');
      return configs.get(p) ?? [];
    });
    configs.set(otherProjectPath, [agent('durable_o1'), agent('durable_o2')]);
    try {
      const result = await rebuildPersistedBindings();
      expect(result.sources[0]).toMatchObject({ collected: 0, pruned: 2 });
      expect(result.sources[0].error).toBeUndefined();
      // Wardfall's wires stay; the other project's reparented helper loses its own.
      expect(boundPairs()).toEqual([
        'durable_h1->durable_lead',
        'durable_h2->durable_lead',
        'durable_lead->durable_h1',
        'durable_lead->durable_h2',
      ]);
      // Still held while unverified: closing a card keeps them.
      expect(keepHeldBinding('durable_lead', 'durable_h1')).toBe(true);
    } finally {
      vi.mocked(listDurable).mockImplementation(async (p: string) => configs.get(p) ?? []);
    }
  });
});

describe('canvas cleanup and zone wires', () => {
  it('keeps a helper wire when its card or canvas tab is closed, and hands it to the helper source', async () => {
    const canvasWires: PersistedBinding[] = [
      { agentId: 'durable_lead', targetId: 'durable_h1', targetKind: 'agent', label: 'h1' },
    ];
    registerPersistedBindingSource({ id: 'canvas-wires', collect: async () => canvasWires });
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings(); // lead -> h1 came from the canvas: not the helper source's

    // The card closes: canvas cleanup asks; main keeps it for the helper.
    expect(keepHeldBinding('durable_lead', 'durable_h1')).toBe(true);
    canvasWires.length = 0;
    // A pair no helper lists is cleaned up as usual.
    expect(keepHeldBinding('durable_lead', 'durable_solo')).toBe(false);

    // Now the helper's, so disposing the helper removes it.
    configs.set(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h1' ? { ...a, disposedAt: '2026-10-18T02:00:00.000Z' } : a));
    await rebuildPersistedBindings();
    expect(boundPairs()).not.toContain('durable_lead->durable_h1');
    expect(keepHeldBinding('durable_lead', 'durable_h1')).toBe(false);
  });

  it('does not report a pair as kept unless main holds it and the user has not removed it', async () => {
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();

    // Gone from main (e.g. agent exited): nothing to keep.
    bindingManager.unbind('durable_lead', 'durable_h1');
    expect(keepHeldBinding('durable_lead', 'durable_h1')).toBe(false);

    // The user deleted the wire this session.
    bindingManager.unbind('durable_lead', 'durable_h2');
    markBindingRemovedByUser('durable_lead', 'durable_h2');
    bindingManager.bind('durable_lead', { targetId: 'durable_h2', targetKind: 'agent', label: 'h2' });
    expect(keepHeldBinding('durable_lead', 'durable_h2')).toBe(false);

    expect(keepHeldBinding('durable_h1', 'durable_lead')).toBe(true);
  });

  it('a zone that binds a helper pair keeps it after the helper is disposed', async () => {
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings(); // the helper source created lead <-> h1

    // A zone wire expands to lead -> h1 and h1 -> lead. The pairs are already
    // bound, but the zone reconcile still sends BIND for every pair it newly
    // wants (diffZoneBindings), and BIND releases the helper source's claim.
    for (const [a, t] of [['durable_lead', 'durable_h1'], ['durable_h1', 'durable_lead']]) {
      clearBindingRemovedByUser(a, t);
      expect(bindingManager.bind(a, { targetId: t, targetKind: 'agent', label: t })).toBe(false);
    }

    configs.set(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h1' ? { ...a, disposedAt: '2026-10-18T02:00:00.000Z' } : a));
    const result = await rebuildPersistedBindings();
    expect(result.sources[0]).toMatchObject({ pruned: 0 });
    expect(boundPairs()).toContain('durable_lead->durable_h1');
    expect(boundPairs()).toContain('durable_h1->durable_lead');
  });
});

describe('rebuildPersistedBindings while one is running', () => {
  it('runs once more afterwards, so a change made mid-run is not missed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    registerPersistedBindingSource({ id: 'slow', collect: async () => { calls++; if (calls === 1) await gate; return []; } });
    const first = rebuildPersistedBindings();
    const second = rebuildPersistedBindings();
    const third = rebuildPersistedBindings();
    expect(second).toBe(third);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });
});
