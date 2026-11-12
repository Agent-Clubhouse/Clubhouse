import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

const state = vi.hoisted(() => ({
  agents: new Map<string, DurableAgentConfig>(), running: new Set<string>(),
  runtimes: new Map<string, { kind: 'chat'; getState(): string }>(),
}));
const spawnAgent = vi.hoisted(() => vi.fn(async ({ agentId }: { agentId: string }) => { state.running.add(agentId); }));
const killAgent = vi.hoisted(() => vi.fn(async (agentId: string) => { state.running.delete(agentId); }));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../project-store', () => ({ peekProjects: async () => [], projectRegistryMutationState: () => ({ generation: 0, pending: false }) }));
vi.mock('../agent-config', () => ({
  agentConfigGeneration: () => 0,
  getDurableConfig: async (_p: string, id: string) => state.agents.get(id) ?? null,
  peekDurableConfigs: async () => [...state.agents.values()],
  setManagedSetup: async () => undefined,
}));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: (id: string) => state.running.has(id) ? state.runtimes.get(id) : undefined }));
vi.mock('../pty-manager', () => ({ getLastActivity: () => null, processIdentity: () => undefined }));
const deliver = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('./delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery')>()),
  deliverManagedSetup: deliver,
}));
const queueExcludes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./git-excludes', () => ({ queueManagedExcludes: queueExcludes }));
vi.mock('../agent-system', () => ({
  resolveOrchestrator: async (_p: string, cli?: string) => ({ id: cli ?? 'claude-code' }),
  isAgentRunning: (id: string) => state.running.has(id),
  killAgent,
  spawnAgent,
}));

import { deliverForSpawn, forgetDelivery, recordMcpStartProblems, restartManagedAgent, statusFor } from './index';
import type { OrchestratorProvider } from '../../orchestrators/types';
import { agentRegistry } from '../agent-registry';

function add(id: string, managed: boolean): void {
  state.runtimes.set(id, { kind: 'chat', getState: () => 'idle' });
  agentRegistry.register(id, { projectPath: '/p', orchestrator: 'claude-code', runtime: 'chat' });
  state.agents.set(id, {
    id, name: id, color: 'indigo', createdAt: '', worktreePath: `/w/${id}`,
    ...(managed && { managed: { version: 1, blocks: [], skills: [], mcps: [] } }),
  });
}

let receiptRoot: string;

beforeEach(async () => {
  state.agents.clear();
  state.running.clear();
  state.runtimes.clear();
  spawnAgent.mockClear();
  killAgent.mockClear();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createAssetCatalogStore } = await import('../asset-catalog/store');
  const { createManagedStateStore } = await import('./state-store');
  const { createManagedAgentsService } = await import('./service');
  const { _setManagedAgentsForTesting } = await import('./index');
  const { _resetSettingsAuditForTesting } = await import('../settings-audit');
  receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-restart-'));
  _resetSettingsAuditForTesting(false);
  _setManagedAgentsForTesting(createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(receiptRoot, 'catalog') }),
    state: createManagedStateStore(path.join(receiptRoot, 'managed')),
    listProjects: async () => [],
    listAgents: async () => [],
    getAgent: async (_p, id) => state.agents.get(id) ?? null,
    setManagedSetup: async () => undefined,
    isRunning: (id) => state.running.has(id),
  }));
});

afterEach(async () => {
  for (const id of state.agents.keys()) agentRegistry.untrack(id);
  (await import('./index'))._setManagedAgentsForTesting(null);
  (await import('node:fs')).rmSync(receiptRoot, { recursive: true, force: true });
});

describe('restartManagedAgent', () => {
  it('refuses an agent that isn\'t managed, even when it is running', async () => {
    add('plain', false);
    state.running.add('plain');
    await expect(restartManagedAgent('/p', 'plain')).rejects.toMatchObject({ code: 'not_managed' });
    expect(killAgent).not.toHaveBeenCalled();
  });

  it('never starts a sleeping agent', async () => {
    add('sleepy', true);
    await expect(restartManagedAgent('/p', 'sleepy')).rejects.toThrow(/isn't running/);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it('stops and starts a running managed agent', async () => {
    add('worker', true);
    state.running.add('worker');
    await restartManagedAgent('/p', 'worker', { fresh: true });
    expect(killAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'worker', resume: false }));
  });

  it('does not replace the original runtime identity while waiting for its turn', async () => {
    add('waiting', true);
    state.running.add('waiting');
    let entered!: () => void;
    const atWait = new Promise<void>((resolve) => { entered = resolve; });
    state.runtimes.set('waiting', { kind: 'chat', getState: () => { entered(); return 'running'; } });
    vi.useFakeTimers();
    try {
      const restart = restartManagedAgent('/p', 'waiting', { whenTurnEnds: true });
      const observed = restart.then(() => undefined, (error: unknown) => error);
      await Promise.race([atWait, observed.then(() => { throw new Error('Restart ended before waiting for its turn'); })]);
      state.runtimes.set('waiting', { kind: 'chat', getState: () => 'idle' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await observed).toMatchObject({ message: expect.stringContaining('Managed restart failed') });
      expect(killAgent).not.toHaveBeenCalled();
      expect(spawnAgent).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('restart outcome (#2819)', () => {
  it('says when there was no conversation to resume', async () => {
    add('fresh-one', true);
    state.running.add('fresh-one');
    expect(await restartManagedAgent('/p', 'fresh-one')).toEqual({ resumed: false, noSession: true });
  });

  it('resumes when there is a session, and asking for fresh is not a surprise', async () => {
    add('resumer', true);
    state.agents.get('resumer')!.lastSessionId = 's1';
    state.running.add('resumer');
    expect(await restartManagedAgent('/p', 'resumer')).toEqual({ resumed: true });
    expect(await restartManagedAgent('/p', 'resumer', { fresh: true })).toEqual({ resumed: false });
  });
});

describe('delivery failure status (#2819)', () => {
  const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', localSettingsFile: 'settings.local.json' } } as unknown as OrchestratorProvider;

  it('reports a failed delivery as waiting with the reason until a delivery succeeds', async () => {
    add('broken', true);
    state.running.add('broken');
    deliver.mockRejectedValueOnce(new Error('disk full'));
    await expect(deliverForSpawn('/p', state.agents.get('broken')!, provider)).rejects.toThrow('disk full');
    expect(await statusFor('/p', 'broken')).toMatchObject({
      waiting: true, deliveryFailed: 'disk full', changes: ["Setup couldn't be written: disk full"],
    });
    deliver.mockResolvedValueOnce(null);
    await deliverForSpawn('/p', state.agents.get('broken')!, provider);
    expect(await statusFor('/p', 'broken')).toMatchObject({ waiting: false });
    expect((await statusFor('/p', 'broken')).deliveryFailed).toBeUndefined();
  });
});

describe('a retired built-in swapped for its copy while the agent runs (D99)', () => {
  it('shows no changes waiting: the copy delivers the same text', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createAssetCatalogStore, installBuiltinAsset } = await import('../asset-catalog/store');
    const { createManagedStateStore } = await import('./state-store');
    const { createManagedAgentsService } = await import('./service');
    const { _setManagedAgentsForTesting, followRemappedSetup } = await import('./index');
    const { _resetSettingsAuditForTesting, withSettingsSurface } = await import('../settings-audit');
    const { builtinParts, BUILTIN_BLOCK_IDS } = await import('./builtins');
    const { CLUBHOUSE_MCP_PART_ID } = await import('../../../shared/managed-agents-types');
    const actual = await vi.importActual<typeof import('./delivery')>('./delivery');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-retired-running-'));
    _resetSettingsAuditForTesting(false);
    const catalog = createAssetCatalogStore({ dir: path.join(root, 'catalog') });
    // As an earlier version left it: the retired built-ins installed too.
    await withSettingsSurface('system', undefined, async () => {
      for (const p of builtinParts()) await installBuiltinAsset(catalog, { assetId: p.id, kind: p.kind, name: p.name, builtinId: p.id, expectedRevision: 0, payload: p.payload });
    });
    const svc = createManagedAgentsService({
      catalog,
      state: createManagedStateStore(path.join(root, 'managed')),
      listProjects: async () => [{ path: '/p', name: 'p' }],
      listAgents: async () => [...state.agents.values()],
      getAgent: async (_p, id) => state.agents.get(id) ?? null,
      setManagedSetup: async (_p, id, setup) => { const a = state.agents.get(id)!; if (setup) a.managed = setup; else delete a.managed; },
      isRunning: (id) => state.running.has(id),
      onSetupRemapped: (_p, a, before, after) => followRemappedSetup(a, before, after),
    });
    _setManagedAgentsForTesting(svc);
    try {
      const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json' }, writeInstructions: async () => {} } as unknown as OrchestratorProvider;
      const worktreePath = path.join(root, 'wt');
      fs.mkdirSync(worktreePath);
      state.agents.set('pm', { id: 'pm', name: 'pm', color: 'indigo', createdAt: '', worktreePath, managed: { version: 1, blocks: [BUILTIN_BLOCK_IDS.projectManager], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] } });
      state.running.add('pm');
      deliver.mockImplementationOnce(actual.deliverManagedSetup as never);
      await deliverForSpawn('/p', state.agents.get('pm')!, provider);
      expect(await statusFor('/p', 'pm')).toMatchObject({ waiting: false });
      await svc.ensureBuiltins();
      expect(state.agents.get('pm')!.managed!.blocks[0]).not.toBe(BUILTIN_BLOCK_IDS.projectManager);
      expect(await statusFor('/p', 'pm')).toMatchObject({ waiting: false, changes: [] });
    } finally {
      _setManagedAgentsForTesting(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
    // Installs every built-in twice on a real catalog: slow on a loaded machine.
  }, 20_000);
});

describe('a setup saved before the Clubhouse MCP part was required (D69)', () => {
  const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json' }, writeInstructions: async () => {} } as unknown as OrchestratorProvider;

  it('shows no changes waiting after a start, before or after its first save adds the part', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createAssetCatalogStore } = await import('../asset-catalog/store');
    const { createManagedStateStore } = await import('./state-store');
    const { createManagedAgentsService } = await import('./service');
    const { _setManagedAgentsForTesting } = await import('./index');
    const { _resetSettingsAuditForTesting } = await import('../settings-audit');
    const { CLUBHOUSE_MCP_PART_ID } = await import('../../../shared/managed-agents-types');
    const actual = await vi.importActual<typeof import('./delivery')>('./delivery');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-old-setup-'));
    _resetSettingsAuditForTesting(false);
    const svc = createManagedAgentsService({
      catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
      state: createManagedStateStore(path.join(root, 'managed')),
      listProjects: async () => [],
      listAgents: async () => [],
      getAgent: async (_p, id) => state.agents.get(id) ?? null,
      setManagedSetup: async () => undefined,
      isRunning: (id) => state.running.has(id),
    });
    await svc.ensureBuiltins();
    _setManagedAgentsForTesting(svc);
    try {
      const worktreePath = path.join(root, 'wt');
      fs.mkdirSync(worktreePath);
      state.agents.set('old', { id: 'old', name: 'old', color: 'indigo', createdAt: '', worktreePath, managed: { version: 1, blocks: [], skills: [], mcps: [] } });
      state.running.add('old');
      deliver.mockImplementationOnce(actual.deliverManagedSetup as never);
      await deliverForSpawn('/p', state.agents.get('old')!, provider);
      expect(await statusFor('/p', 'old')).toMatchObject({ waiting: false, changes: [] });
      // The first save writes the part in; the session still has what it needs.
      state.agents.get('old')!.managed = { version: 1, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] };
      expect(await statusFor('/p', 'old')).toMatchObject({ waiting: false, changes: [] });
    } finally {
      _setManagedAgentsForTesting(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the managed exclude block (D16, D97)', () => {
  it('refreshes the project\'s blocks after every delivery', async () => {
    add('excl', true);
    queueExcludes.mockClear();
    const provider = { id: 'claude-code', conventions: {} } as unknown as OrchestratorProvider;
    await deliverForSpawn('/p', state.agents.get('excl')!, provider);
    expect(queueExcludes).toHaveBeenCalledWith('/p');
  });
});

describe('MCP start problems in the status (#2896, D95)', () => {
  it('reports what a running session\'s servers lack, by name, and forgets it when the agent stops', async () => {
    add('mcp-user', true);
    state.running.add('mcp-user');
    recordMcpStartProblems('mcp-user', [{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }]);
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toEqual([{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }]);
    state.running.delete('mcp-user');
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toBeUndefined();
    state.running.add('mcp-user');
    recordMcpStartProblems('mcp-user', []);
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toBeUndefined();
    recordMcpStartProblems('mcp-user', [{ server: 'jira', missingEnv: ['JIRA_URL'] }]);
    forgetDelivery('mcp-user');
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toBeUndefined();
  });
});

describe('the setup-changed bar shows only for what a restart delivers (#3197)', () => {
  const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json' }, writeInstructions: async () => {} } as unknown as OrchestratorProvider;
  let root: string;
  let svc: import('./service').ManagedAgentsService;
  let rules: { id: string; revision: number };
  const user = async <T>(fn: () => Promise<T>): Promise<T> => (await import('../settings-audit')).withSettingsSurface('ui', undefined, fn);

  beforeEach(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createAssetCatalogStore } = await import('../asset-catalog/store');
    const { createManagedStateStore } = await import('./state-store');
    const { createManagedAgentsService } = await import('./service');
    const { _setManagedAgentsForTesting } = await import('./index');
    const { _resetSettingsAuditForTesting } = await import('../settings-audit');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-bar-'));
    _resetSettingsAuditForTesting(false);
    svc = createManagedAgentsService({
      catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
      state: createManagedStateStore(path.join(root, 'managed')),
      listProjects: async () => [],
      listAgents: async () => [],
      getAgent: async (_p, id) => state.agents.get(id) ?? null,
      setManagedSetup: async () => undefined,
      isRunning: (id) => state.running.has(id),
    });
    _setManagedAgentsForTesting(svc);
    rules = await user(() => svc.createPart({ name: 'Rules', content: { kind: 'block', content: 'Work on @@StandbyBranch.' } }));
    const worktreePath = path.join(root, 'wt');
    fs.mkdirSync(worktreePath);
    state.agents.set('orch', {
      id: 'orch', name: 'orch', color: 'indigo', createdAt: '', worktreePath, orchestrator: 'claude-code', model: 'opus',
      orchestration: { orchestrate: true, maxHelpers: 3 },
      managed: { version: 1, blocks: [rules.id], skills: [], mcps: [] },
    });
    state.running.add('orch');
    const actual = await vi.importActual<typeof import('./delivery')>('./delivery');
    deliver.mockImplementationOnce(actual.deliverManagedSetup as never);
    await deliverForSpawn('/p', state.agents.get('orch')!, provider);
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: false, changes: [] });
  });

  afterEach(async () => {
    const fs = await import('node:fs');
    (await import('./index'))._setManagedAgentsForTesting(null);
    forgetDelivery('orch');
    fs.rmSync(root, { recursive: true, force: true });
  });

  const orch = () => state.agents.get('orch')!;

  it('shows nothing for orchestration changes: the session reads them live', async () => {
    orch().orchestration = { orchestrate: true, maxHelpers: 8, control: 'ask-everything', access: 'standard', crossProjectHelpers: true, connectToDispatcher: true, autoHelpers: false };
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: false, changes: [] });
    orch().orchestration = { orchestrate: false };
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: false, changes: [] });
  });

  it('shows an instruction block edit', async () => {
    await user(() => svc.updatePart({ id: rules.id, expectedRevision: rules.revision, content: { kind: 'block', content: 'Work carefully.' } }));
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: true, changes: ['Rules was edited'] });
  });

  it('shows a CLI change', async () => {
    orch().orchestrator = 'codex-cli';
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: true, cliChanged: true, changes: ['The CLI changed'] });
  });

  it('names the launch setting that changed', async () => {
    orch().model = 'sonnet';
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: true, changes: ['The model changed'] });
    orch().model = 'opus';
    orch().effort = 'high';
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: true, changes: ['The effort changed'] });
    delete orch().effort;
    orch().access = 'full_access';
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: true, changes: ['Access changed'] });
    // Ask first and unset start the same way.
    orch().access = 'ask';
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: false });
    orch().freeAgentMode = true;
    expect(await statusFor('/p', 'orch')).toMatchObject({ waiting: true, changes: ['Access changed'] });
  });

  it('shows orchestration as it is now in "Running now", and the launch settings as started', async () => {
    const { runningSnapshotFor } = await import('./index');
    orch().model = 'sonnet';
    orch().orchestration = { orchestrate: true, maxHelpers: 8 };
    const snapshot = await runningSnapshotFor('/p', 'orch');
    expect(snapshot?.settings.find((r) => r.key === 'model')?.value).toBe('opus');
    expect(snapshot?.settings.find((r) => r.key === 'helpers')?.value).toMatch(/^Up to 8 at once/);
  });
});
