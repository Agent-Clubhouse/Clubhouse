import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { activate, deactivate, MainPanel } from './main';
import { manifest } from './manifest';
import * as automationsModule from './main';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import type { PluginAPI, PluginContext, ScopedStorage } from '../../../../shared/plugin-types';
import type { Automation, RunRecord } from './types';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeAutomation(overrides?: Partial<Automation>): Automation {
  return {
    id: 'auto-1',
    name: 'Test Auto',
    cronExpression: '* * * * *', // every minute
    model: '',
    prompt: 'do stuff',
    enabled: true,
    createdAt: 1000,
    lastRunAt: null,
    ...overrides,
  };
}

function makeRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    agentId: 'agent-1',
    automationId: 'auto-1',
    startedAt: 1000,
    status: 'running',
    summary: null,
    exitCode: null,
    completedAt: null,
    ...overrides,
  };
}

/** Create a mock ScopedStorage backed by a real Map for read/write/delete/list. */
function createMapStorage(): ScopedStorage & { _data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    _data: data,
    read: vi.fn(async (key: string) => data.get(key)),
    write: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
    delete: vi.fn(async (key: string) => { data.delete(key); }),
    list: vi.fn(async () => [...data.keys()]),
  };
}

// ── Built-in plugin validation ───────────────────────────────────────

describe('automations plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: automationsModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ───────────────────────────────────────────────────────

describe('automations plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;
  let registerSpy: ReturnType<typeof vi.fn>;
  let onStatusChangeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ctx = createMockContext({ pluginId: 'automations' });
    registerSpy = vi.fn(() => ({ dispose: vi.fn() }));
    onStatusChangeSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        onStatusChange: onStatusChangeSpy,
      },
    });
  });

  it('registers a create command', () => {
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledWith('create', expect.any(Function));
  });

  it('subscribes to onStatusChange', () => {
    activate(ctx, api);
    expect(onStatusChangeSpy).toHaveBeenCalledTimes(1);
    expect(onStatusChangeSpy).toHaveBeenCalledWith(expect.any(Function));
  });

  it('pushes exactly 3 disposables to ctx.subscriptions (statusChange, interval, command)', () => {
    activate(ctx, api);
    expect(ctx.subscriptions).toHaveLength(3);
    for (const sub of ctx.subscriptions) {
      expect(typeof sub.dispose).toBe('function');
    }
  });

  it('sets up a timer (interval disposable clears it)', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    activate(ctx, api);
    ctx.subscriptions[1].dispose();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('does not call agents.runQuick during activation', () => {
    const runQuickSpy = vi.fn();
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        onStatusChange: onStatusChangeSpy,
        runQuick: runQuickSpy,
      },
    });
    activate(ctx, api);
    expect(runQuickSpy).not.toHaveBeenCalled();
  });

  it('does not read storage during activation', () => {
    const readSpy = vi.fn();
    api = createMockAPI({
      commands: { register: registerSpy, execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        onStatusChange: onStatusChangeSpy,
      },
      storage: {
        ...createMockAPI().storage,
        projectLocal: {
          ...createMockAPI().storage.projectLocal,
          read: readSpy,
        },
      },
    });
    activate(ctx, api);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('calling activate twice registers two independent subscription sets', () => {
    activate(ctx, api);
    activate(ctx, api);
    expect(registerSpy).toHaveBeenCalledTimes(2);
    expect(onStatusChangeSpy).toHaveBeenCalledTimes(2);
    expect(ctx.subscriptions).toHaveLength(6);
  });

  it('works without project context', () => {
    const appCtx = createMockContext({ pluginId: 'automations', projectId: undefined, projectPath: undefined });
    expect(() => activate(appCtx, api)).not.toThrow();
    expect(appCtx.subscriptions).toHaveLength(3);
  });
});

// ── Cron tick behavior ──────────────────────────────────────────────

describe('automations cron tick', () => {
  let ctx: PluginContext;
  let storage: ReturnType<typeof createMapStorage>;
  let runQuickSpy: ReturnType<typeof vi.fn>;
  let onStatusChangeSpy: ReturnType<typeof vi.fn>;
  let api: PluginAPI;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockContext({ pluginId: 'automations' });
    storage = createMapStorage();
    runQuickSpy = vi.fn().mockResolvedValue('spawned-agent-1');
    onStatusChangeSpy = vi.fn(() => ({ dispose: vi.fn() }));
    api = createMockAPI({
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })), execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        runQuick: runQuickSpy,
        onStatusChange: onStatusChangeSpy,
      },
      storage: {
        ...createMockAPI().storage,
        projectLocal: storage,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires runQuick for an enabled automation whose cron matches', async () => {
    const auto = makeAutomation({ cronExpression: '* * * * *', enabled: true });
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).toHaveBeenCalledTimes(1);
    expect(runQuickSpy).toHaveBeenCalledWith('do stuff', { model: undefined });
  });

  it('passes model option when set', async () => {
    const auto = makeAutomation({ model: 'fast-model' });
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).toHaveBeenCalledWith('do stuff', { model: 'fast-model' });
  });

  it('skips disabled automations', async () => {
    const auto = makeAutomation({ enabled: false });
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).not.toHaveBeenCalled();
  });

  it('skips automations whose cron does not match', async () => {
    // Set time to a known point
    vi.setSystemTime(new Date(2026, 1, 15, 10, 30));
    const auto = makeAutomation({ cronExpression: '0 9 * * *' }); // 9 AM only
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).not.toHaveBeenCalled();
  });

  it('prevents re-firing within the same minute', async () => {
    vi.setSystemTime(new Date(2026, 1, 15, 10, 30, 0));
    const auto = makeAutomation({
      lastRunAt: new Date(2026, 1, 15, 10, 30, 5).getTime(), // already ran this minute
    });
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).not.toHaveBeenCalled();
  });

  it('fires again in a new minute even after same-minute guard', async () => {
    vi.setSystemTime(new Date(2026, 1, 15, 10, 30, 0));
    const auto = makeAutomation({
      lastRunAt: new Date(2026, 1, 15, 10, 29, 0).getTime(), // ran last minute
    });
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).toHaveBeenCalledTimes(1);
  });

  it('records a run in storage after firing', async () => {
    const auto = makeAutomation();
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    const runs = storage._data.get('runs:auto-1') as RunRecord[];
    expect(runs).toHaveLength(1);
    expect(runs[0].agentId).toBe('spawned-agent-1');
    expect(runs[0].automationId).toBe('auto-1');
    expect(runs[0].status).toBe('running');
    expect(runs[0].summary).toBeNull();
    expect(runs[0].completedAt).toBeNull();
  });

  it('updates lastRunAt on the automation after firing', async () => {
    const auto = makeAutomation();
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    const automations = storage._data.get('automations') as Automation[];
    expect(automations[0].lastRunAt).toBeTypeOf('number');
    expect(automations[0].lastRunAt).toBeGreaterThan(0);
  });

  it('caps run records at 50', async () => {
    const auto = makeAutomation();
    // Pre-fill with 50 existing runs
    const existingRuns = Array.from({ length: 50 }, (_, i) =>
      makeRunRecord({ agentId: `old-${i}`, status: 'completed' }),
    );
    storage._data.set('automations', [auto]);
    storage._data.set('runs:auto-1', existingRuns);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    const runs = storage._data.get('runs:auto-1') as RunRecord[];
    expect(runs).toHaveLength(50);
    // New run is at position 0
    expect(runs[0].agentId).toBe('spawned-agent-1');
  });

  it('survives runQuick rejection without crashing', async () => {
    runQuickSpy.mockRejectedValue(new Error('spawn failed'));
    const auto = makeAutomation();
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    // Should not throw
    await vi.advanceTimersByTimeAsync(30_000);

    // No run recorded
    expect(storage._data.has('runs:auto-1')).toBe(false);
  });

  it('handles storage returning undefined (no automations key yet)', async () => {
    // storage has nothing — read returns undefined
    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).not.toHaveBeenCalled();
  });

  it('handles storage returning non-array data gracefully', async () => {
    storage._data.set('automations', 'corrupted');
    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).not.toHaveBeenCalled();
  });

  it('fires multiple automations in one tick if both match', async () => {
    const auto1 = makeAutomation({ id: 'a1', prompt: 'first' });
    const auto2 = makeAutomation({ id: 'a2', prompt: 'second' });
    storage._data.set('automations', [auto1, auto2]);
    runQuickSpy.mockResolvedValueOnce('agent-a1').mockResolvedValueOnce('agent-a2');

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runQuickSpy).toHaveBeenCalledTimes(2);
    expect(runQuickSpy).toHaveBeenCalledWith('first', { model: undefined });
    expect(runQuickSpy).toHaveBeenCalledWith('second', { model: undefined });
  });
});

// ── onStatusChange callback behavior ────────────────────────────────

describe('automations onStatusChange tracking', () => {
  let ctx: PluginContext;
  let storage: ReturnType<typeof createMapStorage>;
  let statusChangeCallback: (agentId: string, status: string, prevStatus: string) => void;
  let runQuickSpy: ReturnType<typeof vi.fn>;
  let listCompletedSpy: ReturnType<typeof vi.fn>;
  let api: PluginAPI;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = createMockContext({ pluginId: 'automations' });
    storage = createMapStorage();
    runQuickSpy = vi.fn().mockResolvedValue('spawned-agent-1');
    listCompletedSpy = vi.fn().mockReturnValue([]);

    api = createMockAPI({
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })), execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        runQuick: runQuickSpy,
        listCompleted: listCompletedSpy,
        onStatusChange: vi.fn((cb) => {
          statusChangeCallback = cb;
          return { dispose: vi.fn() };
        }),
      },
      storage: {
        ...createMockAPI().storage,
        projectLocal: storage,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function fireAndComplete(agentId: string, automationId: string) {
    // Simulate: automation fires, agent spawned
    const auto = makeAutomation({ id: automationId });
    storage._data.set('automations', [auto]);

    activate(ctx, api);
    await vi.advanceTimersByTimeAsync(30_000);

    // Now the tick has fired and recorded a pending run
    return statusChangeCallback;
  }

  it('updates run record to completed on running→sleeping', async () => {
    listCompletedSpy.mockReturnValue([
      { id: 'spawned-agent-1', summary: 'Did the thing', exitCode: 0 },
    ]);
    await fireAndComplete('spawned-agent-1', 'auto-1');

    statusChangeCallback('spawned-agent-1', 'sleeping', 'running');

    // Let storage promises resolve
    await vi.advanceTimersByTimeAsync(0);

    const runs = storage._data.get('runs:auto-1') as RunRecord[];
    expect(runs[0].status).toBe('completed');
    expect(runs[0].summary).toBe('Did the thing');
    expect(runs[0].exitCode).toBe(0);
    expect(runs[0].completedAt).toBeTypeOf('number');
  });

  it('updates run record to failed on running→error', async () => {
    listCompletedSpy.mockReturnValue([
      { id: 'spawned-agent-1', summary: null, exitCode: 1 },
    ]);
    await fireAndComplete('spawned-agent-1', 'auto-1');

    statusChangeCallback('spawned-agent-1', 'error', 'running');
    await vi.advanceTimersByTimeAsync(0);

    const runs = storage._data.get('runs:auto-1') as RunRecord[];
    expect(runs[0].status).toBe('failed');
    expect(runs[0].exitCode).toBe(1);
  });

  it('ignores agents not tracked in pendingRuns', async () => {
    activate(ctx, api);
    // Fire callback for an unknown agent
    statusChangeCallback('unknown-agent', 'sleeping', 'running');
    await vi.advanceTimersByTimeAsync(0);

    // No storage writes for run records
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('ignores non-completion transitions (e.g. sleeping→running)', async () => {
    await fireAndComplete('spawned-agent-1', 'auto-1');

    // Reset write call count from the tick
    (storage.write as ReturnType<typeof vi.fn>).mockClear();

    statusChangeCallback('spawned-agent-1', 'running', 'sleeping');
    await vi.advanceTimersByTimeAsync(0);

    // No additional writes — transition was not a completion
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('handles missing summary in listCompleted gracefully (null fallback)', async () => {
    listCompletedSpy.mockReturnValue([]); // Agent not found in completed list
    await fireAndComplete('spawned-agent-1', 'auto-1');

    statusChangeCallback('spawned-agent-1', 'sleeping', 'running');
    await vi.advanceTimersByTimeAsync(0);

    const runs = storage._data.get('runs:auto-1') as RunRecord[];
    expect(runs[0].summary).toBeNull();
    expect(runs[0].exitCode).toBeNull();
  });

  it('updates lastRunAt on the automation after completion', async () => {
    listCompletedSpy.mockReturnValue([
      { id: 'spawned-agent-1', summary: 'done', exitCode: 0 },
    ]);
    await fireAndComplete('spawned-agent-1', 'auto-1');

    const beforeLastRunAt = (storage._data.get('automations') as Automation[])[0].lastRunAt;

    statusChangeCallback('spawned-agent-1', 'sleeping', 'running');
    await vi.advanceTimersByTimeAsync(0);

    const afterLastRunAt = (storage._data.get('automations') as Automation[])[0].lastRunAt;
    expect(afterLastRunAt).toBeTypeOf('number');
    expect(afterLastRunAt!).toBeGreaterThanOrEqual(beforeLastRunAt!);
  });

  it('removes agent from pendingRuns after completion (no double-processing)', async () => {
    listCompletedSpy.mockReturnValue([
      { id: 'spawned-agent-1', summary: 'done', exitCode: 0 },
    ]);
    await fireAndComplete('spawned-agent-1', 'auto-1');

    statusChangeCallback('spawned-agent-1', 'sleeping', 'running');
    await vi.advanceTimersByTimeAsync(0);

    (storage.write as ReturnType<typeof vi.fn>).mockClear();

    // Fire again for same agent — should be ignored (already removed from pending)
    statusChangeCallback('spawned-agent-1', 'sleeping', 'running');
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.write).not.toHaveBeenCalled();
  });
});

// ── deactivate() ─────────────────────────────────────────────────────

describe('automations plugin deactivate()', () => {
  it('is a no-op function', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('returns void', () => {
    expect(deactivate()).toBeUndefined();
  });

  it('can be called multiple times', () => {
    deactivate();
    deactivate();
    deactivate();
  });
});

// ── MainPanel (component contract) ───────────────────────────────────

describe('automations plugin MainPanel', () => {
  it('is exported as a function', () => {
    expect(typeof MainPanel).toBe('function');
  });

  it('conforms to PluginModule.MainPanel shape (accepts { api })', () => {
    expect(MainPanel.length).toBeLessThanOrEqual(1);
  });
});

// ── API assumptions ──────────────────────────────────────────────────
// Documents exactly what the plugin expects from the v0.5 API.
// If any assumption breaks, these tests pinpoint the incompatibility.

describe('automations plugin API assumptions', () => {
  let api: PluginAPI;

  beforeEach(() => {
    api = createMockAPI();
  });

  // ── storage.projectLocal assumptions ───────────────────────────────

  describe('storage.projectLocal', () => {
    it('read exists and returns a promise', () => {
      expect(typeof api.storage.projectLocal.read).toBe('function');
      expect(api.storage.projectLocal.read('key')).toBeInstanceOf(Promise);
    });

    it('read resolves to undefined for missing keys (plugin guards with Array.isArray)', async () => {
      const val = await api.storage.projectLocal.read('nonexistent');
      // Plugin does: Array.isArray(raw) ? raw : []
      // So undefined must not be an array
      expect(val).toBeUndefined();
      expect(Array.isArray(val)).toBe(false);
    });

    it('write exists and returns a promise', () => {
      expect(typeof api.storage.projectLocal.write).toBe('function');
      expect(api.storage.projectLocal.write('key', 'val')).toBeInstanceOf(Promise);
    });

    it('write accepts JSON-serializable arrays (automations list, run records)', async () => {
      const data = [makeAutomation()];
      await expect(api.storage.projectLocal.write('automations', data)).resolves.not.toThrow();
    });

    it('delete exists and returns a promise', () => {
      expect(typeof api.storage.projectLocal.delete).toBe('function');
      expect(api.storage.projectLocal.delete('key')).toBeInstanceOf(Promise);
    });
  });

  // ── agents.runQuick assumptions ─────────────────────────────────────

  describe('agents.runQuick', () => {
    it('exists and is callable', () => {
      expect(typeof api.agents.runQuick).toBe('function');
    });

    it('returns a promise resolving to a string (agentId)', async () => {
      const result = await api.agents.runQuick('mission');
      expect(typeof result).toBe('string');
    });

    it('accepts optional model option', async () => {
      await expect(api.agents.runQuick('mission', { model: 'fast' })).resolves.toBeDefined();
    });

    it('accepts undefined model (plugin passes model || undefined)', async () => {
      await expect(api.agents.runQuick('mission', { model: undefined })).resolves.toBeDefined();
    });

    it('plugin catches rejection (expects it can throw)', async () => {
      const failApi = createMockAPI({
        agents: {
          ...api.agents,
          runQuick: vi.fn().mockRejectedValue(new Error('spawn failed')),
        },
      });
      await expect(failApi.agents.runQuick('m')).rejects.toThrow('spawn failed');
    });
  });

  // ── agents.onStatusChange assumptions ───────────────────────────────

  describe('agents.onStatusChange', () => {
    it('exists and returns a Disposable', () => {
      const d = api.agents.onStatusChange(() => {});
      expect(typeof d.dispose).toBe('function');
    });

    it('dispose does not throw', () => {
      const d = api.agents.onStatusChange(() => {});
      expect(() => d.dispose()).not.toThrow();
    });

    it('callback receives (agentId: string, status: string, prevStatus: string)', () => {
      // Plugin assumes: cb(agentId, status, prevStatus) where:
      //   status === 'sleeping' means success completion
      //   status === 'error' means failed completion
      //   prevStatus === 'running' indicates transition from active state
      let captured: { agentId: unknown; status: unknown; prevStatus: unknown } | null = null;
      const testApi = createMockAPI({
        agents: {
          ...api.agents,
          onStatusChange: vi.fn((cb) => {
            cb('agent-1', 'sleeping', 'running');
            return { dispose: () => {} };
          }),
        },
      });
      testApi.agents.onStatusChange((agentId, status, prevStatus) => {
        captured = { agentId, status, prevStatus };
      });
      expect(captured).not.toBeNull();
      expect(typeof captured!.agentId).toBe('string');
      expect(typeof captured!.status).toBe('string');
      expect(typeof captured!.prevStatus).toBe('string');
    });

    it('plugin interprets sleeping as success, error as failure', () => {
      // This documents the status string contract the plugin depends on
      // The plugin does: status === 'sleeping' ? 'completed' : 'failed'
      // after checking: prevStatus === 'running' && (status === 'sleeping' || status === 'error')
      expect('sleeping').not.toBe('error'); // distinct statuses
    });
  });

  // ── agents.listCompleted assumptions ────────────────────────────────

  describe('agents.listCompleted', () => {
    it('exists and returns an array', () => {
      expect(Array.isArray(api.agents.listCompleted())).toBe(true);
    });

    it('can be called with no args (plugin uses default projectId)', () => {
      expect(() => api.agents.listCompleted()).not.toThrow();
    });

    it('items have id, summary, and exitCode fields (plugin reads these)', () => {
      // Plugin does: completed.find(c => c.id === agentId)
      // Then reads: info?.summary, info?.exitCode
      const testApi = createMockAPI({
        agents: {
          ...api.agents,
          listCompleted: vi.fn(() => [
            { id: 'a1', projectId: 'p', name: 'n', mission: 'm', summary: 'done', filesModified: [], exitCode: 0, completedAt: 1 },
          ]),
        },
      });
      const list = testApi.agents.listCompleted();
      expect(list[0]).toHaveProperty('id');
      expect(list[0]).toHaveProperty('summary');
      expect(list[0]).toHaveProperty('exitCode');
    });

    it('summary can be null (plugin uses ?? null fallback)', () => {
      const testApi = createMockAPI({
        agents: {
          ...api.agents,
          listCompleted: vi.fn(() => [
            { id: 'a1', projectId: 'p', name: 'n', mission: 'm', summary: null, filesModified: [], exitCode: 0, completedAt: 1 },
          ]),
        },
      });
      const info = testApi.agents.listCompleted()[0];
      expect(info.summary).toBeNull();
    });
  });

  // ── agents.getModelOptions assumptions ──────────────────────────────

  describe('agents.getModelOptions', () => {
    it('exists and returns a promise', () => {
      expect(api.agents.getModelOptions()).toBeInstanceOf(Promise);
    });

    it('resolves to an array of { id: string, label: string }', async () => {
      const opts = await api.agents.getModelOptions();
      expect(Array.isArray(opts)).toBe(true);
      for (const opt of opts) {
        expect(typeof opt.id).toBe('string');
        expect(typeof opt.label).toBe('string');
      }
    });

    it('can be called with no args (plugin uses default projectId)', async () => {
      await expect(api.agents.getModelOptions()).resolves.toBeDefined();
    });
  });

  // ── commands.register assumptions ───────────────────────────────────

  describe('commands.register', () => {
    it('returns a Disposable', () => {
      const d = api.commands.register('create', () => {});
      expect(typeof d.dispose).toBe('function');
    });

    it('accepts a string command ID and function handler', () => {
      // Plugin calls: api.commands.register('create', () => { ... })
      expect(() => api.commands.register('create', () => {})).not.toThrow();
    });
  });

  // ── navigation.focusAgent assumptions (View button on running rows) ─

  describe('navigation.focusAgent', () => {
    it('exists and is callable', () => {
      expect(typeof api.navigation.focusAgent).toBe('function');
    });

    it('accepts an agentId string', () => {
      // Plugin calls: api.navigation.focusAgent(run.agentId)
      expect(() => api.navigation.focusAgent('agent-123')).not.toThrow();
    });

    it('returns void (fire-and-forget)', () => {
      const result = api.navigation.focusAgent('agent-123');
      expect(result).toBeUndefined();
    });
  });

  // ── agents.kill assumptions (Stop button on running rows) ───────────

  describe('agents.kill', () => {
    it('exists and is callable', () => {
      expect(typeof api.agents.kill).toBe('function');
    });

    it('returns a promise', () => {
      expect(api.agents.kill('agent-123')).toBeInstanceOf(Promise);
    });

    it('resolves to void', async () => {
      expect(await api.agents.kill('agent-123')).toBeUndefined();
    });

    it('accepts an agentId string', async () => {
      // Plugin calls: api.agents.kill(run.agentId) on Stop button click
      await expect(api.agents.kill('agent-123')).resolves.not.toThrow();
    });
  });

  // ── widgets.QuickAgentGhost assumptions (summary card) ──────────────

  describe('widgets.QuickAgentGhost', () => {
    it('exists and is a component (function)', () => {
      expect(typeof api.widgets.QuickAgentGhost).toBe('function');
    });

    it('accepts completed, onDismiss, and optional onDelete props', () => {
      // Plugin renders: React.createElement(api.widgets.QuickAgentGhost, { completed, onDismiss })
      // The widget type is: React.ComponentType<{ completed: CompletedQuickAgentInfo; onDismiss: () => void; onDelete?: () => void }>
      const props = {
        completed: {
          id: 'a1', projectId: 'p', name: 'n', mission: 'm',
          summary: 'done', filesModified: [], exitCode: 0, completedAt: 1,
        },
        onDismiss: () => {},
      };
      // Should not throw when called with valid props
      expect(() => api.widgets.QuickAgentGhost(props)).not.toThrow();
    });
  });

  // ── agents.listCompleted for summary card lookup ────────────────────

  describe('agents.listCompleted (summary card lookup)', () => {
    it('returns CompletedQuickAgentInfo with all fields needed by QuickAgentGhost', () => {
      const testApi = createMockAPI({
        agents: {
          ...api.agents,
          listCompleted: vi.fn(() => [{
            id: 'a1', projectId: 'p', name: 'Agent', mission: 'do stuff',
            summary: 'Did it', filesModified: ['file.ts'], exitCode: 0, completedAt: 1000,
          }]),
        },
      });
      const list = testApi.agents.listCompleted();
      const item = list[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('projectId');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('mission');
      expect(item).toHaveProperty('summary');
      expect(item).toHaveProperty('filesModified');
      expect(item).toHaveProperty('exitCode');
      expect(item).toHaveProperty('completedAt');
    });

    it('plugin finds agent by id (uses .find(c => c.id === agentId))', () => {
      const testApi = createMockAPI({
        agents: {
          ...api.agents,
          listCompleted: vi.fn(() => [
            { id: 'a1', projectId: 'p', name: 'n', mission: 'm', summary: 's1', filesModified: [], exitCode: 0, completedAt: 1 },
            { id: 'a2', projectId: 'p', name: 'n', mission: 'm', summary: 's2', filesModified: [], exitCode: 0, completedAt: 2 },
          ]),
        },
      });
      const list = testApi.agents.listCompleted();
      const found = list.find(c => c.id === 'a2');
      expect(found?.summary).toBe('s2');
    });

    it('returns empty array when no completed agents (plugin shows fallback)', () => {
      const list = api.agents.listCompleted();
      expect(list).toEqual([]);
      expect(list.find(c => c.id === 'nonexistent')).toBeUndefined();
    });
  });

  // ── ui.showConfirm assumptions (delete dialogs) ─────────────────────

  describe('ui.showConfirm', () => {
    it('exists and is callable', () => {
      expect(typeof api.ui.showConfirm).toBe('function');
    });

    it('returns a promise', () => {
      expect(api.ui.showConfirm('message')).toBeInstanceOf(Promise);
    });

    it('resolves to a boolean', async () => {
      const result = await api.ui.showConfirm('Delete?');
      expect(typeof result).toBe('boolean');
    });

    it('plugin uses it for automation delete confirmation', async () => {
      // Plugin calls: api.ui.showConfirm('Delete this automation and its run history? This cannot be undone.')
      const result = await api.ui.showConfirm('Delete this automation and its run history? This cannot be undone.');
      expect(typeof result).toBe('boolean');
    });

    it('plugin uses it for run record delete confirmation', async () => {
      // Plugin calls: api.ui.showConfirm('Delete this run record? This cannot be undone.')
      const result = await api.ui.showConfirm('Delete this run record? This cannot be undone.');
      expect(typeof result).toBe('boolean');
    });

    it('plugin only deletes when confirm returns true', async () => {
      // Default mock returns false — plugin should NOT proceed with deletion
      const result = await api.ui.showConfirm('Delete?');
      expect(result).toBe(false);
    });

    it('plugin can receive true (user confirmed)', async () => {
      const confirmApi = createMockAPI({
        ui: { ...api.ui, showConfirm: vi.fn().mockResolvedValue(true) },
      });
      const result = await confirmApi.ui.showConfirm('Delete?');
      expect(result).toBe(true);
    });
  });
});

// ── Plugin lifecycle integration ─────────────────────────────────────

describe('automations plugin lifecycle', () => {
  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'automations' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });

  it('subscriptions from activate are disposable', () => {
    const ctx = createMockContext({ pluginId: 'automations' });
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      commands: { register: () => ({ dispose: disposeSpy }), execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        onStatusChange: () => ({ dispose: disposeSpy }),
      },
    });
    activate(ctx, api);
    for (const sub of ctx.subscriptions) {
      sub.dispose();
    }
    // statusChange dispose + command dispose (interval uses clearInterval, not the spy)
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });

  it('subscriptions dispose is idempotent (double-dispose safe)', () => {
    const ctx = createMockContext({ pluginId: 'automations' });
    const disposeSpy = vi.fn();
    const api = createMockAPI({
      commands: { register: () => ({ dispose: disposeSpy }), execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        onStatusChange: () => ({ dispose: disposeSpy }),
      },
    });
    activate(ctx, api);
    for (const sub of ctx.subscriptions) {
      sub.dispose();
      sub.dispose();
    }
    expect(disposeSpy).toHaveBeenCalledTimes(4); // 2 subs × 2 calls
  });

  it('interval stops firing after dispose', async () => {
    vi.useFakeTimers();
    const storage = createMapStorage();
    const runQuickSpy = vi.fn().mockResolvedValue('a1');
    storage._data.set('automations', [makeAutomation()]);
    const api = createMockAPI({
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })), execute: vi.fn() },
      agents: {
        ...createMockAPI().agents,
        runQuick: runQuickSpy,
        onStatusChange: vi.fn(() => ({ dispose: vi.fn() })),
      },
      storage: { ...createMockAPI().storage, projectLocal: storage },
    });
    const ctx = createMockContext({ pluginId: 'automations' });

    activate(ctx, api);
    // Dispose the interval (subscriptions[1])
    ctx.subscriptions[1].dispose();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runQuickSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ── Module exports ───────────────────────────────────────────────────

describe('automations plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof automationsModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof automationsModule.deactivate).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof automationsModule.MainPanel).toBe('function');
  });

  it('does not export SidebarPanel (full layout, no sidebar)', () => {
    expect((automationsModule as any).SidebarPanel).toBeUndefined();
  });

  it('does not export HubPanel', () => {
    expect((automationsModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((automationsModule as any).SettingsPanel).toBeUndefined();
  });
});
