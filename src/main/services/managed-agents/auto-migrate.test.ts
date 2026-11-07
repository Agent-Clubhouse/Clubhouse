import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedAgentSetup } from '../../../shared/managed-agents-types';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

const h = vi.hoisted(() => ({
  /** Agents by project path. */
  projects: new Map<string, Map<string, DurableAgentConfig>>(),
  service: null as unknown,
  stateDir: '',
  flag: true,
  /** Projects with Clubhouse Mode on. */
  clubhouseMode: new Set<string>(),
  dispatcherPath: '',
  running: new Set<string>(),
  busy: new Set<string>(),
  personaPolicy: {} as Record<string, Record<string, unknown>>,
  /** What a project or user orchestrator.md gives an agent with no persona. */
  projectLayer: {} as Record<string, unknown>,
  policyCalls: [] as string[],
}));

const agentsOf = (projectPath: string) => {
  let agents = h.projects.get(projectPath);
  if (!agents) { agents = new Map(); h.projects.set(projectPath, agents); }
  return agents;
};
const find = (id: string) => [...h.projects.values()].map((a) => a.get(id)).find(Boolean);

vi.mock('../agent-config', () => ({
  getDurableConfig: async (p: string, id: string) => {
    const a = h.projects.get(p)?.get(id);
    return a ? structuredClone(a) : null;
  },
  peekDurableConfigs: async (p: string) => [...(h.projects.get(p)?.values() ?? [])].map((a) => structuredClone(a)),
  // As agent-config's writer does.
  setManagedMigration: vi.fn(async (p: string, id: string, change: Record<string, unknown>) => {
    const a = h.projects.get(p)?.get(id);
    if (!a) return;
    if ('layerCarriedAt' in change) a.personaLayerCarriedAt = change.layerCarriedAt as string;
    else if ('migrated' in change) { a.managedMigration = change.migrated as never; delete a.managedMigrationFailure; }
    else if ('failed' in change) a.managedMigrationFailure = change.failed as never;
    else if (a.managedMigration) a.managedMigration = { ...a.managedMigration, dismissed: true };
  }),
  updateDurableConfig: vi.fn(),
  createDurable: vi.fn(),
  deleteUnregister: vi.fn(),
}));
vi.mock('../project-store', () => ({
  peekProjects: async () => [...h.projects.keys()].filter((p) => p !== h.dispatcherPath && !p.startsWith('remote')).map((p) => ({ id: p, name: p, path: p })),
}));
vi.mock('../experimental-settings', () => ({ getSettings: () => ({ managedAgents: h.flag }) }));
vi.mock('../clubhouse-mode-settings', () => ({ isClubhouseModeEnabled: (p: string) => h.clubhouseMode.has(p) }));
vi.mock('../dispatcher/dispatcher-paths', () => ({ isDispatcherPath: (p: string) => p === h.dispatcherPath }));
vi.mock('../agent-transition', () => ({ agentTransitionBusy: (id: string) => h.busy.has(id) }));
/** A stand-in for the persona layer, as agents.test has it; orchestration-policy.test covers the real carry. */
vi.mock('../orchestration-policy', () => ({
  setOrchestrationPolicy: vi.fn(async () => ({ ok: true })),
  carryPersonaOrchestration: vi.fn(async (_p: string, id: string, why = 'managed') => {
    h.policyCalls.push(why === 'plain' ? 'carry-plain' : 'carry');
    const a = find(id)!;
    const layer = (a.persona ? h.personaPolicy[a.persona] : h.projectLayer) || {};
    const carried = Object.fromEntries(Object.entries(layer).filter(([k]) => (a.orchestration as Record<string, unknown> | undefined)?.[k] === undefined));
    const before = a.orchestration && { ...a.orchestration };
    if (Object.keys(carried).length > 0) a.orchestration = { ...before, ...carried };
    return { previousPersona: a.persona, before, carried: Object.keys(carried).length > 0 ? carried : undefined };
  }),
  restorePersonaOrchestration: vi.fn(async (_p: string, id: string, carry: { before?: DurableAgentConfig['orchestration'] }) => {
    h.policyCalls.push('restore');
    const a = find(id)!;
    if (carry.before) a.orchestration = carry.before; else delete a.orchestration;
  }),
  reconcileAfterPersonaChange: vi.fn(async () => { h.policyCalls.push('reconcile'); }),
}));
vi.mock('../materialization-service', () => ({
  materializedInstructions: vi.fn(async () => 'What Clubhouse Mode writes.'),
  materializedDefaults: vi.fn(async () => ({ skills: [], mcpJson: null, resolveText: (t: string) => t })),
}));
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => h.running.has(id),
  resolveOrchestrator: async () => ({
    id: 'claude-code',
    conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', settingsFormat: 'json' },
    readInstructions: async () => 'Ship small PRs.',
  }),
}));
vi.mock('./index', () => ({
  managedAgents: () => h.service,
  ensureBuiltinsOnce: async () => (h.service as { ensureBuiltins(): Promise<void> }).ensureBuiltins(),
}));
vi.mock('../git-exclude-manager', () => ({ addExclusions: vi.fn(async () => {}) }));
vi.mock('./legacy-settings', () => ({ migrateLegacySettings: vi.fn(async () => ({ mcp: false, sourceControl: false })) }));
vi.mock('./state-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state-store')>()),
  managedStateDir: () => h.stateDir,
}));

import { appLog } from '../log-service';
import { createAssetCatalogStore } from '../asset-catalog/store';
import { _resetSettingsAuditForTesting, withSettingsSurface } from '../settings-audit';
import { createManagedStateStore } from './state-store';
import { createManagedAgentsService, ManagedError, type ManagedAgentsService } from './service';
import * as agentConfig from '../agent-config';
import * as legacySettings from './legacy-settings';
import {
  _resetAutoMigrateForTesting,
  autoMigrateFrom,
  backupLocation,
  legacyConfiguredFrom,
  migrateAtSpawn,
  runStartupMigration,
} from './auto-migrate';

let root: string;
let service: ManagedAgentsService;

function agent(projectPath: string, id: string, over: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  const wt = path.join(root, projectPath, '.clubhouse', 'agents', id);
  fs.mkdirSync(wt, { recursive: true });
  const config: DurableAgentConfig = { id, name: id, color: 'indigo', createdAt: '2026-11-07T00:00:00.000Z', worktreePath: wt, ...over };
  agentsOf(projectPath).set(id, config);
  return structuredClone(config);
}
const get = (projectPath: string, id: string) => h.projects.get(projectPath)!.get(id)!;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-auto-'));
  _resetSettingsAuditForTesting(false);
  _resetAutoMigrateForTesting();
  vi.mocked(appLog).mockClear();
  vi.mocked(agentConfig.setManagedMigration).mockClear();
  vi.mocked(legacySettings.migrateLegacySettings).mockClear();
  h.stateDir = path.join(root, 'managed');
  h.flag = true;
  h.projects.clear();
  h.clubhouseMode = new Set();
  h.dispatcherPath = 'dispatcher';
  h.running = new Set();
  h.busy = new Set();
  h.personaPolicy = {};
  h.projectLayer = {};
  h.policyCalls = [];
  service = createManagedAgentsService({
    catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
    state: createManagedStateStore(h.stateDir),
    listProjects: async () => [...h.projects.keys()].map((p) => ({ path: p, name: p })),
    listAgents: async (p) => [...(h.projects.get(p)?.values() ?? [])],
    getAgent: async (p, id) => h.projects.get(p)?.get(id) ?? null,
    // As agent-config's setManagedSetup does.
    setManagedSetup: async (p, id, setup: ManagedAgentSetup | null) => {
      const a = h.projects.get(p)!.get(id)!;
      h.policyCalls.push('save');
      if (setup) {
        a.managed = setup;
        a.mcpOverride = setup.mcps.includes(CLUBHOUSE_MCP_PART_ID);
        delete a.clubhouseFeatures;
        delete a.persona;
        delete a.managedMigrationFailure;
      } else delete a.managed;
    },
    isRunning: () => false,
  });
  h.service = service;
});

const parts = async (kind: 'block' | 'skill' | 'mcp') => (await withSettingsSurface('ui', undefined, () => service.listParts(kind))).filter((p) => !p.builtin);

describe('which agents are legacy-configured (D59)', () => {
  it('Clubhouse Mode on and not turned off for it, or a persona; plain and managed agents are not', () => {
    h.clubhouseMode.add('alpha');
    expect(legacyConfiguredFrom('alpha', agent('alpha', 'ada'))).toBe('clubhouse-mode');
    expect(legacyConfiguredFrom('alpha', agent('alpha', 'bea', { persona: 'qa' }))).toBe('clubhouse-mode');
    expect(legacyConfiguredFrom('alpha', agent('alpha', 'cal', { clubhouseModeOverride: true }))).toBeNull();
    expect(legacyConfiguredFrom('alpha', agent('alpha', 'dot', { clubhouseModeOverride: true, persona: 'qa' }))).toBe('persona');
    expect(legacyConfiguredFrom('beta', agent('beta', 'eve'))).toBeNull();
    expect(legacyConfiguredFrom('beta', agent('beta', 'fay', { persona: 'qa', managed: { version: 1, blocks: [], skills: [], mcps: [] } }))).toBeNull();
  });

  it('never the Dispatcher, a helper, a disposed agent, one being created, one in the project folder, or one switched before', () => {
    const p = 'beta';
    expect(autoMigrateFrom(p, agent(p, 'ada', { persona: 'qa' }))).toBe('persona');
    expect(autoMigrateFrom('dispatcher', agent('dispatcher', 'disp', { persona: 'qa' }))).toBeNull();
    expect(autoMigrateFrom(p, agent(p, 'hal', { persona: 'qa', parentAgentId: 'ada' }))).toBeNull();
    expect(autoMigrateFrom(p, agent(p, 'ivy', { persona: 'qa', disposedAt: '2026-11-07T01:00:00.000Z' } as never))).toBeNull();
    expect(autoMigrateFrom(p, agent(p, 'jo', { persona: 'qa', creation: { state: 'creating' } as never }))).toBeNull();
    expect(autoMigrateFrom(p, agent(p, 'kit', { persona: 'qa', worktreePath: undefined }))).toBeNull();
    expect(autoMigrateFrom(p, agent(p, 'lu', { persona: 'qa', managedMigration: { at: 'x', from: 'persona', backup: 'b' } }))).toBeNull();
  });

  it('names the backup from the home folder', () => {
    const home = path.dirname(h.stateDir);
    expect(backupLocation('ada', home)).toBe(path.join('~', 'managed', 'before-managed', 'ada'));
    expect(backupLocation('ada', path.join(root, 'elsewhere'))).toBe(path.join(h.stateDir, 'before-managed', 'ada'));
  });
});

describe('the switch at spawn (D59)', () => {
  it('switches a Clubhouse Mode agent with Keep and marks it, and the next spawn has nothing to do', async () => {
    h.clubhouseMode.add('alpha');
    const ada = agent('alpha', 'ada');

    const managed = await migrateAtSpawn('alpha', ada);

    expect(managed?.managed).toBeDefined();
    // Keep: what Clubhouse Mode would write becomes its block, and the bridge stays.
    const block = await withSettingsSurface('ui', undefined, () => service.getPart(managed!.managed!.blocks[0]));
    expect(block.content).toEqual({ kind: 'block', content: 'What Clubhouse Mode writes.' });
    expect(managed!.managed!.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    expect(get('alpha', 'ada').managedMigration).toEqual({ at: expect.any(String), from: 'clubhouse-mode', backup: backupLocation('ada') });
    // The earlier instructions are kept where the notice says.
    expect(fs.readFileSync(path.join(h.stateDir, 'before-managed', 'ada', 'CLAUDE.md'), 'utf-8')).toBe('Ship small PRs.');

    vi.mocked(agentConfig.setManagedMigration).mockClear();
    expect(await migrateAtSpawn('alpha', managed!)).toBeNull();
    expect(agentConfig.setManagedMigration).not.toHaveBeenCalled();
    expect(await parts('block')).toHaveLength(1);
  });

  it('switches a persona agent and keeps the orchestration its persona gave it', async () => {
    h.personaPolicy = { orchestrator: { orchestrate: true } };
    const ada = agent('beta', 'ada', { persona: 'orchestrator' });

    const managed = await migrateAtSpawn('beta', ada);

    expect(managed?.managed).toBeDefined();
    expect(get('beta', 'ada').persona).toBeUndefined();
    expect(get('beta', 'ada').orchestration).toEqual({ orchestrate: true });
    expect(h.policyCalls).toEqual(['carry', 'save', 'reconcile']);
    expect(get('beta', 'ada').managedMigration?.from).toBe('persona');
  });

  it('a failed switch starts it as it is once, logs codes only, records why, and is not tried again until a restart', async () => {
    h.clubhouseMode.add('alpha');
    const ada = agent('alpha', 'ada');
    const saveSetup = vi.spyOn(service, 'saveSetup').mockRejectedValue(new ManagedError('invalid', 'Two skills use the folder name ship.'));

    expect(await migrateAtSpawn('alpha', ada)).toBeNull();
    expect(get('alpha', 'ada').managed).toBeUndefined();
    // What the failed switch made is gone.
    expect(await parts('block')).toEqual([]);
    expect(get('alpha', 'ada').managedMigrationFailure).toEqual({ at: expect.any(String), code: 'invalid', message: 'Two skills use the folder name ship.' });
    const warn = vi.mocked(appLog).mock.calls.find((c) => c[2].startsWith('Automatic switch to managed failed'))!;
    expect(warn[3]).toEqual({ meta: { agentId: 'ada', from: 'clubhouse-mode', code: 'invalid' } });

    // The next spawn this run doesn't try again.
    saveSetup.mockClear();
    expect(await migrateAtSpawn('alpha', structuredClone(get('alpha', 'ada')))).toBeNull();
    expect(saveSetup).not.toHaveBeenCalled();

    // After an app restart it is tried again, and a success clears the failure.
    _resetAutoMigrateForTesting();
    saveSetup.mockRestore();
    const managed = await migrateAtSpawn('alpha', structuredClone(get('alpha', 'ada')));
    expect(managed?.managed).toBeDefined();
    expect(get('alpha', 'ada').managedMigrationFailure).toBeUndefined();
  });

  it('a switch by hand clears the recorded failure', async () => {
    h.clubhouseMode.add('alpha');
    const ada = agent('alpha', 'ada');
    const saveSetup = vi.spyOn(service, 'saveSetup').mockRejectedValueOnce(new Error('EACCES: /secret/path'));
    expect(await migrateAtSpawn('alpha', ada)).toBeNull();
    // Not a ManagedError: a plain reason, and the log has no message or path.
    expect(get('alpha', 'ada').managedMigrationFailure).toMatchObject({ code: 'failed', message: 'Something went wrong while switching it.' });
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('/secret/path');
    saveSetup.mockRestore();
    const { convertToManaged } = await import('./agents');
    await withSettingsSurface('ui', undefined, () => convertToManaged('alpha', 'ada', { keep: true }));
    expect(get('alpha', 'ada').managedMigrationFailure).toBeUndefined();
  });

  it('leaves plain agents, agents in projects not on this machine, and any agent with the flag off', async () => {
    expect(await migrateAtSpawn('beta', agent('beta', 'plain'))).toBeNull();
    expect(await migrateAtSpawn('remote-1', agent('remote-1', 'far', { persona: 'qa' }))).toBeNull();
    h.flag = false;
    h.clubhouseMode.add('alpha');
    expect(await migrateAtSpawn('alpha', agent('alpha', 'ada', { persona: 'qa' }))).toBeNull();
    expect(get('alpha', 'ada').managed).toBeUndefined();
    expect(get('alpha', 'ada').persona).toBe('qa');
    expect(agentConfig.setManagedMigration).not.toHaveBeenCalled();
    expect(await parts('block')).toEqual([]);
  });
});

describe('the startup pass (D59)', () => {
  function seed() {
    h.clubhouseMode.add('alpha');
    agent('alpha', 'sleepy');
    agent('alpha', 'busy-one');
    agent('alpha', 'waking');
    agent('alpha', 'helper', { parentAgentId: 'sleepy' });
    agent('alpha', 'gone', { disposedAt: '2026-11-07T01:00:00.000Z' } as never);
    agent('alpha', 'new', { creation: { state: 'creating' } as never });
    agent('alpha', 'stopped', { managedMigration: { at: 'x', from: 'clubhouse-mode', backup: 'b' } });
    agent('beta', 'plain');
    agent('beta', 'persona', { persona: 'qa' });
    agent('dispatcher', 'disp', { persona: 'orchestrator' });
    agent('remote-1', 'far', { persona: 'qa' });
    h.running.add('busy-one');
    h.busy.add('waking');
  }

  it('switches sleeping legacy agents in local projects, one at a time, and leaves the rest', async () => {
    seed();
    const order: string[] = [];
    const saveSetup = service.saveSetup.bind(service);
    let inFlight = 0;
    vi.spyOn(service, 'saveSetup').mockImplementation(async (p, id, setup) => {
      inFlight++;
      expect(inFlight).toBe(1);
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
      try { return await saveSetup(p, id, setup); } finally { inFlight--; }
    });

    const result = await runStartupMigration();

    expect(order).toEqual(['sleepy', 'persona']);
    expect(result).toEqual({ switched: 2, failed: 0, deferred: 2, carried: 1 });
    expect(legacySettings.migrateLegacySettings).toHaveBeenCalledTimes(1);
    for (const [p, id] of [['alpha', 'busy-one'], ['alpha', 'waking'], ['alpha', 'helper'], ['alpha', 'gone'], ['alpha', 'new'], ['alpha', 'stopped'], ['beta', 'plain'], ['dispatcher', 'disp'], ['remote-1', 'far']]) {
      expect(get(p, id).managed, id).toBeUndefined();
    }
    expect(get('alpha', 'sleepy').managedMigration?.from).toBe('clubhouse-mode');
    expect(get('beta', 'persona').managedMigration?.from).toBe('persona');
  });

  it('runs once, and switches nothing twice even if run again', async () => {
    seed();
    const first = await runStartupMigration();
    expect(await runStartupMigration()).toBe(first);
    const save = vi.spyOn(service, 'saveSetup');
    _resetAutoMigrateForTesting();
    // A later app start: the switched agents are managed and marked, the running one has since slept.
    h.running.clear();
    h.busy.clear();
    const again = await runStartupMigration();
    expect(again).toEqual({ switched: 2, failed: 0, deferred: 0, carried: 0 });
    expect(save.mock.calls.map((c) => c[1])).toEqual(['busy-one', 'waking']);
    _resetAutoMigrateForTesting();
    save.mockClear();
    expect(await runStartupMigration()).toEqual({ switched: 0, failed: 0, deferred: 0, carried: 0 });
    expect(save).not.toHaveBeenCalled();
  });

  it('a spawn while the pass switches that agent waits for it and starts as managed', async () => {
    h.clubhouseMode.add('alpha');
    const sleepy = agent('alpha', 'sleepy');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const saveSetup = service.saveSetup.bind(service);
    const spy = vi.spyOn(service, 'saveSetup').mockImplementation(async (p, id, setup) => { await gate; return saveSetup(p, id, setup); });

    const pass = runStartupMigration();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const spawn = migrateAtSpawn('alpha', sleepy);
    release();
    const [result, managed] = await Promise.all([pass, spawn]);
    expect(result.switched).toBe(1);
    expect(managed?.managed).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the persona layer\'s orchestration on plain agents as their own fields, once (D62)', async () => {
    h.projectLayer = { maxHelpers: 3, helperAccess: 'standard' };
    agent('beta', 'plain');
    agent('beta', 'own', { orchestration: { maxHelpers: 5 } });
    agent('beta', 'project-folder', { worktreePath: undefined });
    agent('beta', 'kid', { parentAgentId: 'plain' });
    agent('dispatcher', 'disp');
    h.running.add('plain');

    const result = await runStartupMigration();

    expect(result.carried).toBe(3);
    // A running plain agent too: its policy resolves the same either way.
    expect(get('beta', 'plain').orchestration).toEqual({ maxHelpers: 3, helperAccess: 'standard' });
    // Only what the layer decided: its own value stays.
    expect(get('beta', 'own').orchestration).toEqual({ maxHelpers: 5, helperAccess: 'standard' });
    expect(get('beta', 'project-folder').orchestration).toEqual({ maxHelpers: 3, helperAccess: 'standard' });
    expect(get('beta', 'kid').orchestration).toBeUndefined();
    expect(get('dispatcher', 'disp').orchestration).toBeUndefined();
    for (const id of ['plain', 'own', 'project-folder']) expect(get('beta', id).personaLayerCarriedAt).toEqual(expect.any(String));
    expect(get('beta', 'plain').managed).toBeUndefined();

    // Not again, even if the layer changes.
    _resetAutoMigrateForTesting();
    h.policyCalls = [];
    h.projectLayer = { maxHelpers: 9 };
    expect((await runStartupMigration()).carried).toBe(0);
    expect(h.policyCalls).toEqual([]);
    expect(get('beta', 'plain').orchestration).toEqual({ maxHelpers: 3, helperAccess: 'standard' });
  });

  it('does nothing with the flag off', async () => {
    seed();
    h.projectLayer = { maxHelpers: 3 };
    h.flag = false;
    expect(await runStartupMigration()).toEqual({ switched: 0, failed: 0, deferred: 0, carried: 0 });
    expect(get('alpha', 'sleepy').managed).toBeUndefined();
    expect(get('beta', 'plain').orchestration).toBeUndefined();
    expect(agentConfig.setManagedMigration).not.toHaveBeenCalled();
    expect(legacySettings.migrateLegacySettings).not.toHaveBeenCalled();
  });
});
