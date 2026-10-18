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
  projects: { list: [] as Array<{ id: string; name: string; path: string; displayName?: string }> },
  configListeners: new Set<(projectPath: string) => void>(),
  ptyWrite: vi.fn(),
  getBoard: vi.fn(),
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => projects.list) }));
vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (projectPath: string) => configs.get(projectPath) ?? []),
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
  it('reports a change when a helper is created, disposed or reparented, and ignores other writes', async () => {
    vi.useFakeTimers();
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings(); // records what is wired now
    const onChange = vi.fn();
    const stop = watchHelperWires(onChange);
    const flush = () => vi.advanceTimersByTimeAsync(100);

    // A write that leaves the wires alone (e.g. a session touch).
    setAgents(projectPath, configs.get(projectPath)!.map((a) => ({ ...a, lastSessionId: 'x' } as DurableAgentConfig)));
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    // A helper is created; a burst of writes reports once.
    const created = [...configs.get(projectPath)!, agent('durable_h3', { parentAgentId: 'durable_lead' })];
    setAgents(projectPath, created);
    setAgents(projectPath, created);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);

    // Disposed.
    setAgents(projectPath, created.map((a) => (a.id === 'durable_h3' ? { ...a, disposedAt: '2026-10-18T03:00:00.000Z' } : a)));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);

    // Reparented.
    setAgents(otherProjectPath, [agent('durable_o1'), agent('durable_o2')]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(3);

    stop();
    setAgents(otherProjectPath, [agent('durable_o1'), agent('durable_o2', { parentAgentId: 'durable_o1' })]);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('end to end: a disposed helper loses its wire after the config change', async () => {
    vi.useFakeTimers();
    registerPersistedBindingSource(helperWireBindingSource);
    await rebuildPersistedBindings();
    watchHelperWires(() => { void rebuildPersistedBindings(); });

    setAgents(projectPath, configs.get(projectPath)!.map((a) =>
      a.id === 'durable_h2' ? { ...a, disposedAt: '2026-10-18T02:00:00.000Z' } : a));
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(boundPairs()).not.toContain('durable_lead->durable_h2'));
    expect(boundPairs()).not.toContain('durable_h2->durable_lead');
    expect(boundPairs()).toContain('durable_lead->durable_h1');
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
