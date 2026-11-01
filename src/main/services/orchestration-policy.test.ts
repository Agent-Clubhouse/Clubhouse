import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import type { DurableAgentConfig, HelperCascadeResult } from '../../shared/types';

const PROJECT = path.join('projects', 'app');
const OTHER_PROJECT = path.join('projects', 'other');

const state = vi.hoisted(() => ({
  agents: new Map<string, Record<string, unknown>[]>(),
  personas: new Map<string, string>(),
  projectDefaults: {} as { persona?: string },
  globalCap: 20,
  running: new Set<string>(),
}));

const mocks = vi.hoisted(() => ({
  resolveHelpersForDelete: vi.fn(),
  getDisposeChecks: vi.fn(),
  disposeHelper: vi.fn(),
  killAgent: vi.fn(),
  projectList: vi.fn(),
}));

function agentsOf(projectPath: string): DurableAgentConfig[] {
  return (state.agents.get(projectPath) ?? []) as unknown as DurableAgentConfig[];
}

vi.mock('./agent-config', () => ({
  getDurableConfig: vi.fn(async (projectPath: string, agentId: string) =>
    agentsOf(projectPath).find((a) => a.id === agentId) ?? null),
  listDurable: vi.fn(async (projectPath: string) => agentsOf(projectPath)),
  listHelpers: vi.fn(async (projectPath: string, agentId: string, options: { recursive?: boolean } = {}) => {
    const live = agentsOf(projectPath).filter((a) => !a.disposedAt);
    if (!options.recursive) return live.filter((a) => a.parentAgentId === agentId);
    const out: DurableAgentConfig[] = [];
    const queue = [agentId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const a of live) if (a.parentAgentId === id) { out.push(a); queue.push(a.id); }
    }
    return out;
  }),
  setOrchestrationConfig: vi.fn(async (projectPath: string, agentId: string, config: unknown) => {
    const agent = agentsOf(projectPath).find((a) => a.id === agentId);
    if (!agent) throw new Error('Agent not found');
    if (config) agent.orchestration = config as DurableAgentConfig['orchestration'];
    else delete agent.orchestration;
  }),
  resolveHelpersForDelete: mocks.resolveHelpersForDelete,
  // dispose_helper (#2229), for the lock race below.
  getDisposeChecks: mocks.getDisposeChecks,
  getWorktreeStatus: vi.fn(async () => ({ isValid: false, branch: '', uncommittedFiles: [], unpushedCommits: [], hasRemote: true })),
  disposeHelper: mocks.disposeHelper,
  isSameProject: vi.fn(async (a: string, b: string) => path.resolve(a) === path.resolve(b)),
  onAgentConfigChanged: (listener: (projectPath: string) => void) => {
    mcp.configListeners.add(listener);
    return () => mcp.configListeners.delete(listener);
  },
}));

/**
 * The helper index (#2511) over every project in `state.agents`, home first:
 * a row in another project is a helper of the home agent when its
 * parentProjectPath names the home project.
 */
vi.mock('./helper-index', () => {
  const homeOf = (projectPath: string, row: DurableAgentConfig) => row.parentProjectPath ?? projectPath;
  const all = (homePath: string) => {
    const paths = [homePath, ...[...state.agents.keys()].filter((p) => p !== homePath)];
    return paths.flatMap((projectPath) => agentsOf(projectPath).map((config) => ({ projectPath, config })));
  };
  return {
    listHelpersEverywhere: vi.fn(async (homePath: string, orchestratorId: string, options: { includeDisposed?: boolean; recursive?: boolean } = {}) => {
      const rows = all(homePath);
      const childrenOf = (parentPath: string, parentId: string) => rows.filter(({ projectPath, config }) =>
        config.parentAgentId === parentId && homeOf(projectPath, config) === parentPath);
      if (!options.recursive) {
        return childrenOf(homePath, orchestratorId).filter(({ config }) => options.includeDisposed || !config.disposedAt);
      }
      const out: Array<{ projectPath: string; config: DurableAgentConfig }> = [];
      const queue = [{ projectPath: homePath, id: orchestratorId }];
      while (queue.length) {
        const parent = queue.shift()!;
        for (const row of childrenOf(parent.projectPath, parent.id)) {
          queue.push({ projectPath: row.projectPath, id: row.config.id });
          if (!row.config.disposedAt) out.push(row);
        }
      }
      return out;
    }),
  };
});

vi.mock('./clubhouse-mcp/tool-registry', () => ({ registerGlobalTool: vi.fn() }));
vi.mock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../ipc/window-handlers', () => ({ findMainWindow: () => undefined }));

vi.mock('./agent-system', () => ({
  isAgentRunning: (id: string) => state.running.has(id),
  killAgent: mocks.killAgent,
}));

const registry = vi.hoisted(() => new Map<string, { projectPath: string; orchestrator: string; runtime: string; launchAccess?: { freeAgentMode: boolean; permissionMode?: 'auto' | 'skip-all' } }>());
vi.mock('./agent-registry', () => ({
  agentRegistry: { get: (id: string) => registry.get(id), getAllRegistrations: () => new Map(registry) },
}));

vi.mock('./orchestration-settings', () => ({
  getGlobalHelperCap: () => state.globalCap,
}));

vi.mock('./project-store', () => ({
  list: mocks.projectList,
}));

vi.mock('./agent-settings-service', () => ({
  readProjectAgentDefaults: vi.fn(async () => state.projectDefaults),
}));

vi.mock('./materialization-service', () => ({
  resolvePersonaId: (agent: DurableAgentConfig, defaults: { persona?: string }) => agent.persona ?? defaults.persona,
  readLayeredPersonaRaw: vi.fn(async (_projectPath: string, personaId: string) => state.personas.get(personaId)),
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

/** App and project MCP settings, with isMcpEnabled's real precedence over them. */
const mcp = vi.hoisted(() => ({
  app: true,
  projects: new Map<string, boolean>(),
  listeners: new Set<() => void>(),
  configListeners: new Set<(projectPath: string) => void>(),
}));
vi.mock('./mcp-settings', () => ({
  isMcpEnabled: (projectPath?: string, agentOverride?: boolean) =>
    agentOverride ?? (projectPath ? mcp.projects.get(projectPath) : undefined) ?? mcp.app,
  onMcpEnablementChanged: (listener: () => void) => {
    mcp.listeners.add(listener);
    return () => mcp.listeners.delete(listener);
  },
}));

import {
  checkHelperLimitFor,
  getHelperSummary,
  getOrchestrationPolicy,
  isCrossProjectAllowed,
  reconcileAfterPersonaChange,
  resolveHelperLaunchSettings,
  resolveOrchestrationPolicies,
  setOrchestrationPolicy,
  syncOrchestrationGate,
  turnOffOrchestration,
  watchMcpForOrchestration,
  withAgentLock,
} from './orchestration-policy';
import { isCrossProjectEnabled, isOrchestrationEnabled, setOrchestrationEnabled, _resetOrchestrationGateForTesting } from './clubhouse-mcp/orchestration-gate';
import { notifyPersonaChanged, notifyProjectDefaultPersonaChanged } from './persona-change-hook';
import * as agentConfig from './agent-config';
import { disposeHelperTool } from './clubhouse-mcp/tools/helper-dispose-tools';

function agent(id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name: id, color: 'blue', createdAt: '2026-10-18T00:00:00Z', ...extra };
}

function setAgents(projectPath: string, list: DurableAgentConfig[]): void {
  state.agents.set(projectPath, list as unknown as Record<string, unknown>[]);
}

function persona(policy: Record<string, unknown>): string {
  return `---\norchestration: ${JSON.stringify(policy)}\n---\n\n# Persona`;
}

/** Register the agent as running in `projectPath`, as a spawn does. */
function live(id: string, launchAccess?: { freeAgentMode: boolean; permissionMode?: 'auto' | 'skip-all' }, projectPath = PROJECT, orchestrator = 'claude-code'): void {
  registry.set(id, { projectPath, orchestrator, runtime: 'pty', ...(launchAccess && { launchAccess }) });
}

function find(id: string, projectPath = PROJECT): DurableAgentConfig {
  return agentsOf(projectPath).find((a) => a.id === id)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetOrchestrationGateForTesting();
  state.agents.clear();
  state.personas.clear();
  state.projectDefaults = {};
  registry.clear();
  state.globalCap = 20;
  state.running.clear();
  mocks.projectList.mockResolvedValue([{ id: 'p1', name: 'app', path: PROJECT }]);
  mocks.killAgent.mockResolvedValue(undefined);
  mcp.app = true;
  mcp.projects.clear();
});

describe('getOrchestrationPolicy', () => {
  it('returns the defaults', async () => {
    setAgents(PROJECT, [agent('orch')]);
    expect(await getOrchestrationPolicy(PROJECT, 'orch')).toMatchObject({ orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 });
  });

  it('takes defaults from the agent\'s persona front-matter', async () => {
    state.personas.set('orchestrator', persona({ orchestrate: true, control: 'ask-before-start', maxHelpers: 3 }));
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator' })]);
    const policy = await getOrchestrationPolicy(PROJECT, 'orch');
    expect(policy).toMatchObject({ orchestrate: true, control: 'ask-before-start', maxHelpers: 3 });
    expect(policy?.sources.control).toBe('persona');
  });

  it('uses the Orchestrator persona\'s limits for other agents but never its orchestrate', async () => {
    state.personas.set('orchestrator', persona({ orchestrate: true, maxHelpers: 2 }));
    setAgents(PROJECT, [agent('dev', { persona: 'developer' })]);
    expect(await getOrchestrationPolicy(PROJECT, 'dev')).toMatchObject({ orchestrate: false, maxHelpers: 2 });
  });

  it('never connects other agents to the Dispatcher from the Orchestrator persona (#2534)', async () => {
    state.personas.set('orchestrator', persona({ orchestrate: true, connectToDispatcher: true, maxHelpers: 2 }));
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator' }), agent('dev', { persona: 'developer' })]);
    expect(await getOrchestrationPolicy(PROJECT, 'orch')).toMatchObject({ connectToDispatcher: true, sources: { connectToDispatcher: 'persona' } });
    expect(await getOrchestrationPolicy(PROJECT, 'dev')).toMatchObject({ connectToDispatcher: false, maxHelpers: 2, sources: { connectToDispatcher: 'default' } });
  });

  it('lets an agent\'s own persona connect it to the Dispatcher (#2534)', async () => {
    state.personas.set('lead', persona({ connectToDispatcher: true }));
    setAgents(PROJECT, [agent('orch', { persona: 'lead' })]);
    expect((await getOrchestrationPolicy(PROJECT, 'orch'))?.connectToDispatcher).toBe(true);
  });

  it('turns orchestration on for agents using the built-in Orchestrator persona, and only them (#2233)', async () => {
    const { getPersonaTemplate } = await import('../../renderer/features/personas');
    state.personas.set('orchestrator', getPersonaTemplate('orchestrator')!.content);
    state.personas.set('workhorse', getPersonaTemplate('workhorse')!.content);
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator' }), agent('helper', { persona: 'workhorse' })]);
    expect(await getOrchestrationPolicy(PROJECT, 'orch')).toMatchObject({ orchestrate: true, access: 'same', control: 'hands-off', maxHelpers: 5 });
    expect((await getOrchestrationPolicy(PROJECT, 'orch'))?.sources.orchestrate).toBe('persona');
    expect((await getOrchestrationPolicy(PROJECT, 'helper'))?.orchestrate).toBe(false);
  });

  it('follows the project default persona when the agent has none', async () => {
    state.projectDefaults = { persona: 'lead' };
    state.personas.set('lead', persona({ orchestrate: true }));
    setAgents(PROJECT, [agent('orch')]);
    expect((await getOrchestrationPolicy(PROJECT, 'orch'))?.orchestrate).toBe(true);
  });

  it('lets the agent\'s own fields win over its persona', async () => {
    state.personas.set('orchestrator', persona({ orchestrate: true, access: 'auto' }));
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator', orchestration: { orchestrate: false } })]);
    expect(await getOrchestrationPolicy(PROJECT, 'orch')).toMatchObject({ orchestrate: false, access: 'auto' });
  });

  it('never opens the gate, even when the config on disk says on', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch');
    await getOrchestrationPolicy(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('closes the gate when the policy on disk is now off', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: false } })]);
    live('orch');
    setOrchestrationEnabled('orch', true);
    await getOrchestrationPolicy(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('leaves the gate of an agent running in another project alone', async () => {
    setAgents(PROJECT, [agent('orch')]);
    live('orch', undefined, OTHER_PROJECT);
    setOrchestrationEnabled('orch', true);
    await getOrchestrationPolicy(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('returns null for an unknown agent', async () => {
    expect(await getOrchestrationPolicy(PROJECT, 'nope')).toBeNull();
  });
});

describe('resolveOrchestrationPolicies (mobile catalog)', () => {
  it('resolves each agent like getOrchestrationPolicy, reading each persona once, without touching the gate', async () => {
    const { readLayeredPersonaRaw } = await import('./materialization-service');
    state.projectDefaults = { persona: 'lead' };
    state.personas.set('lead', persona({ orchestrate: true, control: 'ask-before-start' }));
    state.personas.set('orchestrator', persona({ maxHelpers: 2 }));
    const agents = [agent('a'), agent('b', { orchestration: { control: 'ask-everything', maxHelpers: 7 } }), agent('c', { persona: 'dev' })];
    setAgents(PROJECT, agents);
    setOrchestrationEnabled('a', true);
    vi.mocked(readLayeredPersonaRaw).mockClear();
    const policies = await resolveOrchestrationPolicies(PROJECT, agents);
    // Two personas (lead, dev), each read with the Orchestrator persona's limits.
    expect(readLayeredPersonaRaw).toHaveBeenCalledTimes(4);
    for (const a of agents) expect(policies.get(a.id)).toEqual(await getOrchestrationPolicy(PROJECT, a.id));
    expect(policies.get('b')).toMatchObject({ orchestrate: true, control: 'ask-everything', maxHelpers: 7, sources: { orchestrate: 'persona', control: 'agent' } });
    expect(policies.get('c')).toMatchObject({ orchestrate: false, maxHelpers: 2, sources: { maxHelpers: 'persona' } });
    expect(isOrchestrationEnabled('a')).toBe(true);
  });
});

describe('syncOrchestrationGate (spawn)', () => {
  it('opens the gate for an agent running in this project', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('keeps it closed when the registry has the agent in another project', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch', undefined, OTHER_PROJECT);
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('keeps it closed for a disposed agent', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true }, disposedAt: '2026-10-18T00:00:00Z' })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('fails closed when the config can\'t be read', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    vi.mocked(agentConfig.getDurableConfig).mockRejectedValueOnce(new Error('disk gone'));
    await expect(syncOrchestrationGate(PROJECT, 'orch')).resolves.toBeUndefined();
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });
});

describe('setOrchestrationPolicy', () => {
  it('persists the change and opens the gate of a running agent', async () => {
    setAgents(PROJECT, [agent('orch')]);
    live('orch');
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: true, control: 'ask-everything' });
    expect(result.ok).toBe(true);
    expect(find('orch').orchestration).toEqual({ orchestrate: true, control: 'ask-everything' });
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('connects an agent through its own orchestrate, not through the Orchestrator persona (#2578)', async () => {
    state.personas.set('orchestrator', persona({ orchestrate: true }));
    setAgents(PROJECT, [
      agent('orch', { persona: 'orchestrator' }),
      agent('dev', { persona: 'developer' }),
      agent('off', { persona: 'orchestrator', orchestration: { connectToDispatcher: false } }),
      agent('helper', { persona: 'orchestrator', parentAgentId: 'orch' }),
    ]);
    expect(await getOrchestrationPolicy(PROJECT, 'orch')).toMatchObject({ orchestrate: true, connectToDispatcher: true, sources: { connectToDispatcher: 'default' } });
    expect((await getOrchestrationPolicy(PROJECT, 'dev'))?.connectToDispatcher).toBe(false);
    expect((await getOrchestrationPolicy(PROJECT, 'off'))?.connectToDispatcher).toBe(false);
    // A helper talks only to its parent.
    const all = await resolveOrchestrationPolicies(PROJECT, agentsOf(PROJECT));
    expect((await getOrchestrationPolicy(PROJECT, 'helper'))?.connectToDispatcher).toBe(false);
    expect(Object.fromEntries([...all].map(([id, p]) => [id, p.connectToDispatcher]))).toEqual({ orch: true, dev: false, off: false, helper: false });
  });

  it('never connects a helper, from its own setting or its persona, in either read (#2578)', async () => {
    state.personas.set('lead', persona({ connectToDispatcher: true }));
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true } }),
      agent('explicit', { parentAgentId: 'orch', orchestration: { connectToDispatcher: true } }),
      agent('from-persona', { parentAgentId: 'orch', persona: 'lead' }),
    ]);
    const off = { connectToDispatcher: false, sources: { connectToDispatcher: 'default' } };
    expect(await getOrchestrationPolicy(PROJECT, 'explicit')).toMatchObject(off);
    expect(await getOrchestrationPolicy(PROJECT, 'from-persona')).toMatchObject(off);
    const all = await resolveOrchestrationPolicies(PROJECT, agentsOf(PROJECT));
    expect(all.get('explicit')).toMatchObject(off);
    expect(all.get('from-persona')).toMatchObject(off);
  });

  it('a phone or IPC write of true on a helper still resolves false (#2578)', async () => {
    setAgents(PROJECT, [agent('orch'), agent('h', { parentAgentId: 'orch' })]);
    const result = await setOrchestrationPolicy(PROJECT, 'h', { connectToDispatcher: true });
    expect(result).toMatchObject({ ok: true, policy: { connectToDispatcher: false, sources: { connectToDispatcher: 'default' } } });
  });

  it('turning orchestrate off takes an unset connection with it, and leaves an explicit one (#2578)', async () => {
    setAgents(PROJECT, [
      agent('follows', { orchestration: { orchestrate: true } }),
      agent('explicit', { orchestration: { orchestrate: true, connectToDispatcher: true } }),
    ]);
    expect(await setOrchestrationPolicy(PROJECT, 'follows', { orchestrate: false })).toMatchObject({ ok: true, policy: { connectToDispatcher: false } });
    expect(await setOrchestrationPolicy(PROJECT, 'explicit', { orchestrate: false })).toMatchObject({ ok: true, policy: { connectToDispatcher: true } });
  });

  it('a connected plain agent gets no orchestration tools (#2578)', async () => {
    setAgents(PROJECT, [agent('plain')]);
    live('plain');
    const result = await setOrchestrationPolicy(PROJECT, 'plain', { connectToDispatcher: true });
    expect(result).toMatchObject({ ok: true, policy: { orchestrate: false, connectToDispatcher: true } });
    expect(isOrchestrationEnabled('plain')).toBe(false);
    await syncOrchestrationGate(PROJECT, 'plain');
    expect(isOrchestrationEnabled('plain')).toBe(false);
    expect(await checkHelperLimitFor(PROJECT, 'plain')).toMatchObject({ ok: false, reason: 'orchestration-off' });
  });

  it('saves connectToDispatcher and logs it (#2534)', async () => {
    const { appLog } = await import('./log-service');
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { connectToDispatcher: true });
    expect(result).toMatchObject({ ok: true, policy: { connectToDispatcher: true } });
    expect(find('orch').orchestration).toEqual({ orchestrate: true, connectToDispatcher: true });
    expect(appLog).toHaveBeenLastCalledWith('core:orchestration', 'info', 'Orchestration policy changed', {
      meta: expect.objectContaining({ agentId: 'orch', connectToDispatcher: true }),
    });
  });

  it('saves for an agent that isn\'t running without opening a gate', async () => {
    setAgents(PROJECT, [agent('orch')]);
    expect((await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: true })).ok).toBe(true);
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('closes the gate when turned off without helpers', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect((await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false })).ok).toBe(true);
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('a null field goes back to the persona value', async () => {
    state.personas.set('orchestrator', persona({ maxHelpers: 3 }));
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator', orchestration: { maxHelpers: 8 } })]);
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { maxHelpers: null });
    expect(result.policy?.maxHelpers).toBe(3);
    expect(find('orch').orchestration).toBeUndefined();
  });

  it('asks for a helper choice instead of turning off an agent with helpers', async () => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true } }),
      agent('h1', { parentAgentId: 'orch' }),
      agent('h2', { parentAgentId: 'orch', disposedAt: '2026-10-18T00:00:00Z' }),
    ]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false });
    expect(result).toMatchObject({ ok: false, needsHelperChoice: { helperIds: ['h1'], projects: [{ projectPath: PROJECT, helperIds: ['h1'] }] } });
    expect(find('orch').orchestration).toEqual({ orchestrate: true });
    expect(isOrchestrationEnabled('orch')).toBe(true);
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
  });

  it('asks for a helper choice when the only helpers are in another project', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    setAgents(OTHER_PROJECT, [agent('x1', { parentAgentId: 'orch', parentProjectPath: PROJECT })]);
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false });
    expect(result).toMatchObject({
      ok: false,
      needsHelperChoice: { helperIds: ['x1'], projects: [{ projectPath: OTHER_PROJECT, helperIds: ['x1'] }] },
    });
  });

  it('applies concurrent patches one after another, losing none', async () => {
    setAgents(PROJECT, [agent('orch')]);
    // Every read yields to the event loop, so unlocked patches would interleave.
    const real = vi.mocked(agentConfig.getDurableConfig).getMockImplementation()!;
    vi.mocked(agentConfig.getDurableConfig).mockImplementation(async (p, id) => {
      await new Promise((r) => setTimeout(r, 5));
      return real(p, id);
    });
    const results = await Promise.all([
      setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: true }),
      setOrchestrationPolicy(PROJECT, 'orch', { control: 'ask-everything' }),
      setOrchestrationPolicy(PROJECT, 'orch', { maxHelpers: 2 }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(find('orch').orchestration).toEqual({ orchestrate: true, control: 'ask-everything', maxHelpers: 2 });
  });

  it('rejects an invalid patch without writing', async () => {
    setAgents(PROJECT, [agent('orch')]);
    await expect(setOrchestrationPolicy(PROJECT, 'orch', { access: 'root' })).rejects.toThrow(/access/);
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
  });

  it('refuses to turn on orchestration for a disposed agent', async () => {
    setAgents(PROJECT, [agent('orch', { disposedAt: '2026-10-18T00:00:00Z' })]);
    expect((await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: true })).ok).toBe(false);
  });

  it('reports an unknown agent', async () => {
    expect(await setOrchestrationPolicy(PROJECT, 'nope', { orchestrate: true })).toMatchObject({ ok: false, message: 'Agent not found' });
  });
});

describe('persona change re-sync', () => {
  beforeEach(() => {
    state.personas.set('orchestrator', persona({ orchestrate: true }));
  });

  it('closes the gate when the new persona turns orchestration off', async () => {
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator' })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(true);
    find('orch').persona = 'developer';
    await notifyPersonaChanged(PROJECT, 'orch', 'orchestrator');
    expect(isOrchestrationEnabled('orch')).toBe(false);
    expect(find('orch').orchestration).toBeUndefined();
  });

  it('keeps orchestration on, pinned on the agent, while it has helpers', async () => {
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator' }), agent('h1', { parentAgentId: 'orch' })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    find('orch').persona = 'developer';
    await reconcileAfterPersonaChange(PROJECT, 'orch', 'orchestrator');
    expect(find('orch').orchestration).toEqual({ orchestrate: true });
    expect(isOrchestrationEnabled('orch')).toBe(true);
    expect((await getOrchestrationPolicy(PROJECT, 'orch'))?.orchestrate).toBe(true);
  });

  it('handles an agent that had no persona of its own, via the project default', async () => {
    state.projectDefaults = { persona: 'orchestrator' };
    setAgents(PROJECT, [agent('orch', { persona: 'developer' })]);
    live('orch');
    setOrchestrationEnabled('orch', true);
    // It used the project default (orchestrator) before choosing developer.
    await notifyPersonaChanged(PROJECT, 'orch', undefined);
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('re-checks agents on the project default persona when it changes', async () => {
    state.projectDefaults = { persona: 'developer' };
    setAgents(PROJECT, [
      agent('follower'),
      agent('keeper'),
      agent('h1', { parentAgentId: 'keeper' }),
      agent('own', { persona: 'orchestrator' }),
    ]);
    for (const id of ['follower', 'keeper', 'own']) {
      live(id);
      setOrchestrationEnabled(id, true);
    }
    await notifyProjectDefaultPersonaChanged(PROJECT, 'orchestrator');
    expect(isOrchestrationEnabled('follower')).toBe(false);
    // Has helpers: kept on, pinned.
    expect(isOrchestrationEnabled('keeper')).toBe(true);
    expect(find('keeper').orchestration).toEqual({ orchestrate: true });
    // Has its own persona: not affected.
    expect(isOrchestrationEnabled('own')).toBe(true);
  });

  it('never opens the gate when the new persona turns orchestration on', async () => {
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator' })]);
    live('orch');
    await reconcileAfterPersonaChange(PROJECT, 'orch', 'developer');
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });
});

describe('getHelperSummary', () => {
  it('lists live direct helpers only', async () => {
    setAgents(PROJECT, [
      agent('orch'),
      agent('h1', { parentAgentId: 'orch' }),
      agent('h1a', { parentAgentId: 'h1' }),
      agent('gone', { parentAgentId: 'orch', disposedAt: '2026-10-18T00:00:00Z' }),
    ]);
    expect(await getHelperSummary(PROJECT, 'orch')).toEqual({ hasHelpers: true, helperIds: ['h1'], projects: [{ projectPath: PROJECT, helperIds: ['h1'] }] });
    expect(await getHelperSummary(PROJECT, 'h1a')).toEqual({ hasHelpers: false, helperIds: [], projects: [] });
  });

  it('includes helpers in other projects, grouped by project, home first', async () => {
    setAgents(PROJECT, [agent('orch'), agent('h1', { parentAgentId: 'orch' })]);
    setAgents(OTHER_PROJECT, [
      agent('x1', { parentAgentId: 'orch', parentProjectPath: PROJECT }),
      agent('x2', { parentAgentId: 'orch', parentProjectPath: PROJECT }),
      // Same id, but a parent in its own project: not ours.
      agent('x3', { parentAgentId: 'orch' }),
    ]);
    expect(await getHelperSummary(PROJECT, 'orch')).toEqual({
      hasHelpers: true,
      helperIds: ['h1', 'x1', 'x2'],
      projects: [{ projectPath: PROJECT, helperIds: ['h1'] }, { projectPath: OTHER_PROJECT, helperIds: ['x1', 'x2'] }],
    });
  });
});

describe('turnOffOrchestration', () => {
  function releaseHelpers(projectPath: string, agentId: string): void {
    for (const a of agentsOf(projectPath)) if (a.parentAgentId === agentId) delete a.parentAgentId;
  }

  beforeEach(async () => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true, maxHelpers: 3 } }),
      agent('h1', { parentAgentId: 'orch' }),
      agent('h2', { parentAgentId: 'orch' }),
    ]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
  });

  it('cancel changes nothing', async () => {
    const result = await turnOffOrchestration(PROJECT, 'orch', 'cancel');
    expect(result).toMatchObject({ ok: true, cancelled: true });
    expect(mocks.resolveHelpersForDelete).not.toHaveBeenCalled();
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('keep releases the direct helpers and turns orchestration off', async () => {
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      releaseHelpers(projectPath, agentId);
      return { ok: true, message: 'Kept 2 helper(s)', helperIds: ['h1', 'h2'] } satisfies HelperCascadeResult;
    });
    const result = await turnOffOrchestration(PROJECT, 'orch', 'keep');
    expect(mocks.resolveHelpersForDelete).toHaveBeenCalledWith(PROJECT, 'orch', 'keep');
    expect(result).toMatchObject({ ok: true, helperIds: ['h1', 'h2'] });
    expect(find('h1').parentAgentId).toBeUndefined();
    expect(find('orch').orchestration).toEqual({ orchestrate: false, maxHelpers: 3 });
    expect(result.policy?.orchestrate).toBe(false);
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('keeps the gate closed while the cascade runs', async () => {
    const gateDuring: boolean[] = [];
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string, _choice: string, opts: { dryRun?: boolean } = {}) => {
      gateDuring.push(isOrchestrationEnabled('orch'));
      if (!opts.dryRun) releaseHelpers(projectPath, agentId);
      return { ok: true, message: 'Disposed', helperIds: ['h1', 'h2'] };
    });
    state.running.add('h1');
    mocks.killAgent.mockImplementation(async () => { gateDuring.push(isOrchestrationEnabled('orch')); });
    await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(gateDuring).toEqual([false, false, false]);
  });

  it('dispose stops running helpers and disposes through the cascade checks', async () => {
    state.running.add('h2');
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string, _c: string, opts: { dryRun?: boolean } = {}) => {
      if (!opts.dryRun) releaseHelpers(projectPath, agentId);
      return { ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'] };
    });
    const result = await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(mocks.resolveHelpersForDelete).toHaveBeenNthCalledWith(1, PROJECT, 'orch', 'dispose', { dryRun: true, force: undefined });
    expect(mocks.resolveHelpersForDelete).toHaveBeenNthCalledWith(2, PROJECT, 'orch', 'dispose', { force: undefined });
    expect(mocks.killAgent).toHaveBeenCalledTimes(1);
    expect(mocks.killAgent).toHaveBeenCalledWith('h2', PROJECT, undefined, 'user', { waitForExit: true });
    expect(result.ok).toBe(true);
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('dispose with work at risk changes nothing and reopens the gate', async () => {
    state.running.add('h1');
    const blocked = { ok: false, message: 'h1 has work', blocked: [{ agentId: 'h1', name: 'h1', checks: { dirty: 2, unpushed: 0, unmerged: 0 } }] };
    mocks.resolveHelpersForDelete.mockResolvedValue(blocked);
    const result = await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(result).toMatchObject(blocked);
    expect(mocks.killAgent).not.toHaveBeenCalled();
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('a failed or throwing cascade leaves orchestration on', async () => {
    mocks.resolveHelpersForDelete
      .mockResolvedValueOnce({ ok: true, message: 'Would dispose', helperIds: ['h1', 'h2'] })
      .mockResolvedValueOnce({ ok: false, message: 'Disposed 1 of 2 helpers', helperIds: ['h1'], failed: [{ agentId: 'h2', name: 'h2', reason: 'EBUSY' }] });
    expect((await turnOffOrchestration(PROJECT, 'orch', 'dispose')).ok).toBe(false);
    expect(isOrchestrationEnabled('orch')).toBe(true);

    mocks.resolveHelpersForDelete.mockRejectedValueOnce(new Error('disk gone'));
    await expect(turnOffOrchestration(PROJECT, 'orch', 'keep')).rejects.toThrow('disk gone');
    expect(isOrchestrationEnabled('orch')).toBe(true);
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
  });

  it('a spawn sync during the cascade can\'t reopen the gate', async () => {
    let syncDone: Promise<void> | undefined;
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      // The orchestrator respawns mid-turn-off.
      syncDone = syncOrchestrationGate(PROJECT, 'orch');
      await new Promise((r) => setTimeout(r, 10));
      expect(isOrchestrationEnabled('orch')).toBe(false);
      releaseHelpers(projectPath, agentId);
      return { ok: true, message: 'Kept', helperIds: ['h1', 'h2'] };
    });
    await turnOffOrchestration(PROJECT, 'orch', 'keep');
    await syncDone;
    expect(isOrchestrationEnabled('orch')).toBe(false);
    expect(find('orch').orchestration?.orchestrate).toBe(false);
  });

  it('does not reopen the gate after a failure when the agent is no longer running here', async () => {
    mocks.resolveHelpersForDelete.mockImplementation(async () => {
      registry.delete('orch');
      return { ok: false, message: 'blocked', blocked: [] };
    });
    await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('settles a helper that appeared during the cascade with the same choice', async () => {
    let calls = 0;
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      calls++;
      releaseHelpers(projectPath, agentId);
      // A start already in flight lands its helper during the first pass.
      if (calls === 1) agentsOf(projectPath).push(agent('late', { parentAgentId: 'orch' }));
      return { ok: true, message: 'Kept', helperIds: calls === 1 ? ['h1', 'h2'] : ['late'] };
    });
    const result = await turnOffOrchestration(PROJECT, 'orch', 'keep');
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true, helperIds: ['h1', 'h2', 'late'] });
    expect(find('late').parentAgentId).toBeUndefined();
  });

  it('does not write orchestrate: false for an agent already off', async () => {
    find('orch').orchestration = { maxHelpers: 3 };
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      releaseHelpers(projectPath, agentId);
      return { ok: true, message: 'Kept', helperIds: ['h1', 'h2'] };
    });
    expect((await turnOffOrchestration(PROJECT, 'orch', 'keep')).ok).toBe(true);
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
    expect(find('orch').orchestration).toEqual({ maxHelpers: 3 });
  });

  it('runs after a policy change in flight, not alongside it', async () => {
    const order: string[] = [];
    const realSet = vi.mocked(agentConfig.setOrchestrationConfig).getMockImplementation()!;
    vi.mocked(agentConfig.setOrchestrationConfig).mockImplementation(async (...args) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(`set:${JSON.stringify(args[2])}`);
      return realSet(...args);
    });
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      order.push('cascade');
      releaseHelpers(projectPath, agentId);
      return { ok: true, message: 'Kept', helperIds: [] };
    });
    await Promise.all([
      setOrchestrationPolicy(PROJECT, 'orch', { control: 'ask-everything' }),
      turnOffOrchestration(PROJECT, 'orch', 'keep'),
    ]);
    expect(order[0]).toContain('ask-everything');
    expect(order[1]).toBe('cascade');
    expect(find('orch').orchestration).toEqual({ orchestrate: false, maxHelpers: 3, control: 'ask-everything' });
  });

  it('a forced turn-off stops at a helper that couldn\'t be checked', async () => {
    state.running.add('h1');
    const unchecked = { ok: false, message: "h1 couldn't be checked (couldn't check, EIO), so it can't be disposed, even with force", blocked: [{ agentId: 'h1', name: 'h1', checks: { dirty: 0, unpushed: 0, unmerged: null, error: "couldn't check, EIO" } }] };
    mocks.resolveHelpersForDelete.mockResolvedValue(unchecked);
    const result = await turnOffOrchestration(PROJECT, 'orch', 'dispose', { force: true });
    expect(result).toMatchObject({ ok: false, blocked: unchecked.blocked });
    expect(mocks.resolveHelpersForDelete).toHaveBeenCalledWith(PROJECT, 'orch', 'dispose', { dryRun: true, force: true });
    expect(mocks.killAgent).not.toHaveBeenCalled();
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('passes force through', async () => {
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      releaseHelpers(projectPath, agentId);
      return { ok: true, message: 'Disposed', helperIds: [] };
    });
    await turnOffOrchestration(PROJECT, 'orch', 'dispose', { force: true });
    expect(mocks.resolveHelpersForDelete).toHaveBeenLastCalledWith(PROJECT, 'orch', 'dispose', { force: true });
  });

  it('rejects an unknown choice', async () => {
    await expect(turnOffOrchestration(PROJECT, 'orch', 'maybe' as never)).rejects.toThrow(/Unknown choice/);
  });
});

describe('cross-project helpers (#2512)', () => {
  it('opens the crossProject gate only when orchestration and cross-project helpers are both on', async () => {
    setAgents(PROJECT, [agent('orch')]);
    live('orch');
    await setOrchestrationPolicy(PROJECT, 'orch', { crossProjectHelpers: true });
    expect(isOrchestrationEnabled('orch')).toBe(false);
    expect(isCrossProjectEnabled('orch')).toBe(false);

    await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: true });
    expect(isOrchestrationEnabled('orch')).toBe(true);
    expect(isCrossProjectEnabled('orch')).toBe(true);
    expect(await isCrossProjectAllowed(PROJECT, 'orch')).toBe(true);

    await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false });
    expect(isCrossProjectEnabled('orch')).toBe(false);
    expect(await isCrossProjectAllowed(PROJECT, 'orch')).toBe(false);
  });

  it('opens it at spawn from the saved policy or persona front-matter', async () => {
    state.personas.set('xp', persona({ orchestrate: true, crossProjectHelpers: true }));
    setAgents(PROJECT, [agent('orch', { persona: 'xp' }), agent('plain', { orchestration: { orchestrate: true } })]);
    live('orch');
    live('plain');
    await syncOrchestrationGate(PROJECT, 'orch');
    await syncOrchestrationGate(PROJECT, 'plain');
    expect(isCrossProjectEnabled('orch')).toBe(true);
    expect(isOrchestrationEnabled('plain')).toBe(true);
    expect(isCrossProjectEnabled('plain')).toBe(false);
  });

  it('turning only cross-project helpers off closes that gate and keeps orchestration', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true, crossProjectHelpers: true } })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { crossProjectHelpers: false });
    expect(result.ok).toBe(true);
    expect(result.crossProjectHelpersKept).toBeUndefined();
    expect(isOrchestrationEnabled('orch')).toBe(true);
    expect(isCrossProjectEnabled('orch')).toBe(false);
  });

  it('turning cross-project helpers off settles nothing and reports the helpers that keep running', async () => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true, crossProjectHelpers: true } }),
      agent('h1', { parentAgentId: 'orch' }),
    ]);
    setAgents(OTHER_PROJECT, [
      agent('x1', { parentAgentId: 'orch', parentProjectPath: PROJECT }),
      agent('x2', { parentAgentId: 'orch', parentProjectPath: PROJECT }),
    ]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { crossProjectHelpers: false });
    expect(result).toMatchObject({ ok: true, crossProjectHelpersKept: 2 });
    expect(mocks.resolveHelpersForDelete).not.toHaveBeenCalled();
    expect(find('x1', OTHER_PROJECT).parentAgentId).toBe('orch');
  });

  it('a read closes the crossProject gate when the setting is now off on disk, never opens it', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true, crossProjectHelpers: true } })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    find('orch').orchestration = { orchestrate: true };
    await getOrchestrationPolicy(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(true);
    expect(isCrossProjectEnabled('orch')).toBe(false);
    find('orch').orchestration = { orchestrate: true, crossProjectHelpers: true };
    await getOrchestrationPolicy(PROJECT, 'orch');
    expect(isCrossProjectEnabled('orch')).toBe(false);
  });

  it('isCrossProjectAllowed is false for an unknown agent or a closed gate', async () => {
    expect(await isCrossProjectAllowed(PROJECT, 'nobody')).toBe(false);
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true, crossProjectHelpers: true } })]);
    expect(await isCrossProjectAllowed(PROJECT, 'orch')).toBe(false);
  });

  it('turn-off dispose stops each running helper in its own project', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } }), agent('h1', { parentAgentId: 'orch' })]);
    setAgents(OTHER_PROJECT, [agent('x1', { parentAgentId: 'orch', parentProjectPath: PROJECT })]);
    state.running.add('h1');
    state.running.add('x1');
    mocks.resolveHelpersForDelete.mockImplementation(async (_p: string, _id: string, _c: string, opts: { dryRun?: boolean } = {}) => {
      if (!opts.dryRun) {
        delete find('h1').parentAgentId;
        delete find('x1', OTHER_PROJECT).parentAgentId;
      }
      return { ok: true, message: 'Disposed', helperIds: ['h1', 'x1'] };
    });
    const result = await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(result).toMatchObject({ ok: true, helperIds: ['h1', 'x1'] });
    expect(mocks.killAgent).toHaveBeenCalledWith('h1', PROJECT, undefined, 'user', { waitForExit: true });
    expect(mocks.killAgent).toHaveBeenCalledWith('x1', OTHER_PROJECT, undefined, 'user', { waitForExit: true });
  });

  it('turn-off keep settles a helper that appeared in another project meanwhile', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } }), agent('h1', { parentAgentId: 'orch' })]);
    setAgents(OTHER_PROJECT, []);
    let calls = 0;
    mocks.resolveHelpersForDelete.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        delete find('h1').parentAgentId;
        agentsOf(OTHER_PROJECT).push(agent('late', { parentAgentId: 'orch', parentProjectPath: PROJECT }));
        return { ok: true, message: 'Kept', helperIds: ['h1'] };
      }
      delete find('late', OTHER_PROJECT).parentAgentId;
      return { ok: true, message: 'Kept', helperIds: ['late'] };
    });
    const result = await turnOffOrchestration(PROJECT, 'orch', 'keep');
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true, helperIds: ['h1', 'late'] });
  });

  it('the helper limit counts helpers in other projects', async () => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true, maxHelpers: 2 } }),
      agent('h1', { parentAgentId: 'orch' }),
    ]);
    setAgents(OTHER_PROJECT, [agent('x1', { parentAgentId: 'orch', parentProjectPath: PROJECT })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: false, reason: 'agent-limit', helperCount: 2 });
  });
});

describe('withAgentLock', () => {
  it('keys on the agent id alone, so two project paths for one agent share the lock', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const first = withAgentLock(PROJECT, 'orch', async () => { order.push('first start'); await held; order.push('first end'); });
    const second = withAgentLock(OTHER_PROJECT, 'orch', async () => { order.push('second'); });
    const other = withAgentLock(PROJECT, 'someone-else', async () => { order.push('other agent'); });
    await other;
    expect(order).toEqual(['first start', 'other agent']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'other agent', 'first end', 'second']);
  });
});

describe('resolveHelperLaunchSettings', () => {
  it('gives bypass helpers to a running bypass orchestrator with same', async () => {
    setAgents(PROJECT, [agent('orch', { freeAgentMode: true })]);
    live('orch', { freeAgentMode: true, permissionMode: 'skip-all' });
    expect(await resolveHelperLaunchSettings(PROJECT, 'orch')).toMatchObject({
      freeAgentMode: true, permissionMode: 'skip-all', level: 'bypass', clamped: false, helperProvider: 'claude-code',
    });
  });

  it('follows the live level, not the saved Free Agent Mode', async () => {
    setAgents(PROJECT, [agent('orch', { freeAgentMode: true })]);
    // Lowered to auto in chat since it started.
    live('orch', { freeAgentMode: true, permissionMode: 'auto' });
    expect((await resolveHelperLaunchSettings(PROJECT, 'orch')).level).toBe('auto');
  });

  it('clamps to standard when the orchestrator isn\'t running, runs elsewhere, or its mode is unknown', async () => {
    setAgents(PROJECT, [agent('orch', { freeAgentMode: true })]);
    expect(await resolveHelperLaunchSettings(PROJECT, 'orch')).toMatchObject({ freeAgentMode: false, permissionMode: 'auto', level: 'standard' });
    live('orch', { freeAgentMode: true, permissionMode: 'skip-all' }, OTHER_PROJECT);
    expect((await resolveHelperLaunchSettings(PROJECT, 'orch')).level).toBe('standard');
    live('orch', { freeAgentMode: true });
    expect((await resolveHelperLaunchSettings(PROJECT, 'orch')).level).toBe('standard');
    live('orch');
    expect((await resolveHelperLaunchSettings(PROJECT, 'orch')).level).toBe('standard');
  });

  it('never exceeds a standard orchestrator, whatever the policy asks', async () => {
    for (const access of ['same', 'standard', 'auto', 'bypass'] as const) {
      setAgents(PROJECT, [agent('orch', { orchestration: { access } })]);
      live('orch', { freeAgentMode: false, permissionMode: 'skip-all' });
      expect(await resolveHelperLaunchSettings(PROJECT, 'orch')).toMatchObject({ freeAgentMode: false, permissionMode: 'auto', level: 'standard' });
    }
  });

  it('ranks for the helper\'s provider', async () => {
    setAgents(PROJECT, [agent('orch')]);
    live('orch', { freeAgentMode: true, permissionMode: 'auto' });
    expect((await resolveHelperLaunchSettings(PROJECT, 'orch')).level).toBe('auto');
    expect(await resolveHelperLaunchSettings(PROJECT, 'orch', { helperProvider: 'copilot-cli' })).toMatchObject({ level: 'standard', clamped: true });
  });

  it('uses a fixed lower level', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { access: 'standard' } })]);
    live('orch', { freeAgentMode: true, permissionMode: 'skip-all' });
    expect(await resolveHelperLaunchSettings(PROJECT, 'orch')).toMatchObject({ freeAgentMode: false, level: 'standard' });
  });

  it('throws for an unknown orchestrator', async () => {
    await expect(resolveHelperLaunchSettings(PROJECT, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('checkHelperLimitFor', () => {
  async function orchestrating(id: string, extra: Partial<DurableAgentConfig> = {}): Promise<DurableAgentConfig> {
    return agent(id, { ...extra, orchestration: { orchestrate: true, ...extra.orchestration } });
  }

  it('refuses when orchestration is off', async () => {
    setAgents(PROJECT, [agent('orch')]);
    live('orch');
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: false, reason: 'orchestration-off', message: 'Orchestration is turned off for this agent.' });
  });

  it('refuses when the policy is on but the gate is closed (not running)', async () => {
    setAgents(PROJECT, [await orchestrating('orch')]);
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: false, reason: 'orchestration-off' });
  });

  it('counts the orchestrator\'s live helpers against its limit', async () => {
    setAgents(PROJECT, [
      await orchestrating('orch', { orchestration: { maxHelpers: 2 } }),
      agent('h1', { parentAgentId: 'orch' }),
      agent('h2', { parentAgentId: 'orch' }),
      agent('gone', { parentAgentId: 'orch', disposedAt: '2026-10-18T00:00:00Z' }),
    ]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: false, reason: 'agent-limit', helperCount: 2, maxHelpers: 2 });
  });

  it('counts live helpers in every project, each once, against the global cap', async () => {
    state.globalCap = 4;
    mocks.projectList.mockResolvedValue([
      { id: 'p1', name: 'app', path: PROJECT },
      { id: 'p1b', name: 'app again', path: path.join(PROJECT, '.') },
      { id: 'p2', name: 'other', path: OTHER_PROJECT },
    ]);
    setAgents(PROJECT, [await orchestrating('orch'), agent('h1', { parentAgentId: 'orch' })]);
    setAgents(path.join(PROJECT, '.'), agentsOf(PROJECT));
    setAgents(OTHER_PROJECT, [agent('o2'), agent('x1', { parentAgentId: 'o2' }), agent('x2', { parentAgentId: 'o2' })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: true, totalHelperCount: 3, globalCap: 4 });
    state.globalCap = 3;
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: false, reason: 'global-cap', totalHelperCount: 3 });
  });

  it('skips a project it can\'t read', async () => {
    mocks.projectList.mockResolvedValue([{ id: 'p2', name: 'other', path: OTHER_PROJECT }]);
    setAgents(PROJECT, [await orchestrating('orch'), agent('h1', { parentAgentId: 'orch' })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    vi.mocked(agentConfig.listDurable).mockImplementation(async (p: string) => {
      if (p === OTHER_PROJECT) throw new Error('unreadable');
      return agentsOf(p);
    });
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: true, helperCount: 1, totalHelperCount: 1 });
  });

  it('uses the given project paths instead of the store', async () => {
    setAgents(PROJECT, [await orchestrating('orch')]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    await checkHelperLimitFor(PROJECT, 'orch', { projectPaths: [] });
    expect(mocks.projectList).not.toHaveBeenCalled();
  });
});

describe('dispose_helper and turn-off share the orchestrator lock (#2229)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  const clean = { dirty: 0, unpushed: 0, unmerged: 0 };

  beforeEach(async () => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true } }),
      agent('h1', { parentAgentId: 'orch' }),
    ]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      for (const a of agentsOf(projectPath)) if (a.parentAgentId === agentId && !a.disposedAt) delete a.parentAgentId;
      return { ok: true, message: 'Kept', helperIds: [] } satisfies HelperCascadeResult;
    });
    // Like agent-config's disposeHelper: refuses a helper that changed parent.
    mocks.disposeHelper.mockImplementation(async (projectPath: string, id: string, opts: { expectedParentId?: string } = {}) => {
      const row = agentsOf(projectPath).find((a) => a.id === id)!;
      if (opts.expectedParentId !== undefined && row.parentAgentId !== opts.expectedParentId) {
        return { ok: false, message: `${id} is no longer a helper of this agent` };
      }
      row.disposedAt = '2026-10-18T03:00:00Z';
      return { ok: true, message: 'Disposed', checks: clean };
    });
  });

  it('a turn-off "keep" that arrives mid-dispose waits until the dispose is done', async () => {
    const checks = deferred<typeof clean>();
    mocks.getDisposeChecks.mockReturnValue(checks.promise);

    const dispose = disposeHelperTool('orch', { helper: 'h1' });
    await vi.waitFor(() => expect(mocks.getDisposeChecks).toHaveBeenCalled());
    const turnOff = turnOffOrchestration(PROJECT, 'orch', 'keep');
    await new Promise((r) => setTimeout(r, 10));
    // The keep can't release h1 while its dispose holds the lock.
    expect(mocks.resolveHelpersForDelete).not.toHaveBeenCalled();
    expect(find('h1').parentAgentId).toBe('orch');

    checks.resolve(clean);
    const result = await dispose;
    expect(JSON.parse(result.content[0].text!)).toMatchObject({ status: 'disposed' });
    expect(mocks.disposeHelper).toHaveBeenCalledWith(PROJECT, 'h1', { force: false, expectedParentId: 'orch' });
    expect(await turnOff).toMatchObject({ ok: true });
    expect(find('h1')).toMatchObject({ parentAgentId: 'orch', disposedAt: expect.any(String) });
  });

  it('a dispose that arrives during a turn-off "keep" finds the helper released and refuses', async () => {
    mocks.getDisposeChecks.mockResolvedValue(clean);
    const release = deferred<void>();
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      await release.promise;
      for (const a of agentsOf(projectPath)) if (a.parentAgentId === agentId) delete a.parentAgentId;
      return { ok: true, message: 'Kept', helperIds: ['h1'] } satisfies HelperCascadeResult;
    });

    const turnOff = turnOffOrchestration(PROJECT, 'orch', 'keep');
    await vi.waitFor(() => expect(mocks.resolveHelpersForDelete).toHaveBeenCalled());
    const dispose = disposeHelperTool('orch', { helper: 'h1', force: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.getDisposeChecks).not.toHaveBeenCalled();

    release.resolve();
    await turnOff;
    const result = await dispose;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not one of your helpers/);
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
    expect(mocks.killAgent).not.toHaveBeenCalled();
    expect(find('h1').disposedAt).toBeUndefined();
  });
});

describe('no Clubhouse MCP, no orchestration (#2589)', () => {
  const on = { orchestrate: true, crossProjectHelpers: true, connectToDispatcher: true };

  /** MCP off at each level, for the same agent: each returns a way to put it back. */
  const levels: Array<[string, () => () => void]> = [
    ['app', () => { mcp.app = false; return () => { mcp.app = true; }; }],
    ['project', () => { mcp.projects.set(PROJECT, false); return () => { mcp.projects.delete(PROJECT); }; }],
    ['agent', () => { find('orch').mcpOverride = false; return () => { delete find('orch').mcpOverride; }; }],
  ];

  describe.each(levels)('off at %s level', (_level, turnOff) => {
    beforeEach(() => { setAgents(PROJECT, [agent('orch', { orchestration: { ...on } })]); });

    it('resolves off in reads and listings, keeping the saved values', async () => {
      const restore = turnOff();
      const off = { orchestrate: false, crossProjectHelpers: false, connectToDispatcher: false, mcpOff: on };
      expect(await getOrchestrationPolicy(PROJECT, 'orch')).toMatchObject(off);
      expect((await resolveOrchestrationPolicies(PROJECT, agentsOf(PROJECT))).get('orch')).toMatchObject(off);
      expect(find('orch').orchestration).toEqual(on);
      restore();
      const back = await getOrchestrationPolicy(PROJECT, 'orch');
      expect(back).toMatchObject(on);
      expect(back).not.toHaveProperty('mcpOff');
    });

    it('refuses turning a switch on and saves nothing', async () => {
      setAgents(PROJECT, [agent('orch')]);
      turnOff();
      for (const patch of [{ orchestrate: true }, { crossProjectHelpers: true }, { connectToDispatcher: true }]) {
        const result = await setOrchestrationPolicy(PROJECT, 'orch', patch);
        expect(result).toMatchObject({ ok: false, mcpRequired: true, message: expect.stringContaining('Clubhouse MCP') });
      }
      expect(find('orch').orchestration).toBeUndefined();
    });

    it('does not open the gate at spawn', async () => {
      turnOff();
      live('orch');
      await syncOrchestrationGate(PROJECT, 'orch');
      expect(isOrchestrationEnabled('orch')).toBe(false);
    });

    it('closes a running agent\'s gate live and reopens it when MCP is back', async () => {
      const stop = watchMcpForOrchestration();
      live('orch');
      await syncOrchestrationGate(PROJECT, 'orch');
      expect(isCrossProjectEnabled('orch')).toBe(true);

      const restore = turnOff();
      for (const listener of mcp.listeners) listener();
      for (const listener of mcp.configListeners) listener(PROJECT);
      await vi.waitFor(() => expect(isOrchestrationEnabled('orch')).toBe(false));

      restore();
      for (const listener of mcp.listeners) listener();
      for (const listener of mcp.configListeners) listener(PROJECT);
      await vi.waitFor(() => expect(isOrchestrationEnabled('orch')).toBe(true));
      expect(isCrossProjectEnabled('orch')).toBe(true);
      stop();
    });
  });

  it('reopens a gate a policy read closed first', async () => {
    const stop = watchMcpForOrchestration();
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    mcp.app = false;
    await getOrchestrationPolicy(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(false);
    mcp.app = true;
    for (const listener of mcp.listeners) listener();
    await vi.waitFor(() => expect(isOrchestrationEnabled('orch')).toBe(true));
    stop();
  });

  it('never opens a gate that was not open, whatever agents.json says now', async () => {
    const stop = watchMcpForOrchestration();
    setAgents(PROJECT, [agent('orch')]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    mcp.app = false;
    for (const listener of mcp.listeners) listener();
    // An edit while MCP is off, then MCP comes back.
    find('orch').orchestration = { orchestrate: true };
    mcp.app = true;
    for (const listener of mcp.listeners) listener();
    for (const listener of mcp.configListeners) listener(PROJECT);
    await withAgentLock(PROJECT, 'orch', async () => undefined);
    expect(isOrchestrationEnabled('orch')).toBe(false);
    stop();
  });

  it('keeps the gate shut when orchestration was turned off while MCP was off', async () => {
    const stop = watchMcpForOrchestration();
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    mcp.app = false;
    for (const listener of mcp.listeners) listener();
    await vi.waitFor(() => expect(isOrchestrationEnabled('orch')).toBe(false));
    expect(await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false })).toMatchObject({ ok: true });
    mcp.app = true;
    for (const listener of mcp.listeners) listener();
    await withAgentLock(PROJECT, 'orch', async () => undefined);
    expect(isOrchestrationEnabled('orch')).toBe(false);
    stop();
  });

  it('leaves helpers alone when MCP goes off, and they are still its helpers', async () => {
    const stop = watchMcpForOrchestration();
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true } }),
      agent('h1', { parentAgentId: 'orch' }),
    ]);
    live('orch');
    live('h1');
    state.running.add('h1');
    await syncOrchestrationGate(PROJECT, 'orch');
    mcp.app = false;
    for (const listener of mcp.listeners) listener();
    await vi.waitFor(() => expect(isOrchestrationEnabled('orch')).toBe(false));
    expect(mocks.killAgent).not.toHaveBeenCalled();
    expect(mocks.resolveHelpersForDelete).not.toHaveBeenCalled();
    expect(find('h1').parentAgentId).toBe('orch');
    expect((await getHelperSummary(PROJECT, 'orch')).helperIds).toEqual(['h1']);
    stop();
  });

  it('still asks about helpers when saved orchestration goes off with MCP off', async () => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true } }),
      agent('h1', { parentAgentId: 'orch' }),
    ]);
    mcp.app = false;
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false });
    expect(result).toMatchObject({ ok: false, needsHelperChoice: { helperIds: ['h1'] } });
    expect(find('orch').orchestration).toEqual({ orchestrate: true });
  });

  it('lets a turn-off with a helper choice write the saved value with MCP off', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    mocks.resolveHelpersForDelete.mockResolvedValue({ ok: true, message: 'Done', helperIds: [] });
    mcp.app = false;
    expect(await turnOffOrchestration(PROJECT, 'orch', 'keep')).toMatchObject({ ok: true });
    expect(find('orch').orchestration).toEqual({ orchestrate: false });
  });

  it('still pins orchestration when a persona change would drop it with MCP off', async () => {
    state.personas.set('lead', persona({ orchestrate: true }));
    state.personas.set('dev', persona({}));
    setAgents(PROJECT, [agent('orch', { persona: 'dev' }), agent('h1', { parentAgentId: 'orch' })]);
    mcp.app = false;
    await reconcileAfterPersonaChange(PROJECT, 'orch', 'lead');
    expect(find('orch').orchestration).toEqual({ orchestrate: true });
  });

  it('does not pin when a persona change keeps saved orchestration on with MCP off', async () => {
    state.personas.set('lead', persona({ orchestrate: true }));
    setAgents(PROJECT, [agent('orch', { persona: 'lead' }), agent('h1', { parentAgentId: 'orch' })]);
    mcp.app = false;
    await reconcileAfterPersonaChange(PROJECT, 'orch', 'lead');
    expect(find('orch').orchestration).toBeUndefined();
  });

  it('allows the other fields with MCP off, without opening anything', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    live('orch');
    mcp.app = false;
    expect(await setOrchestrationPolicy(PROJECT, 'orch', { maxHelpers: 2 })).toMatchObject({ ok: true, policy: { maxHelpers: 2, orchestrate: false } });
    expect(isOrchestrationEnabled('orch')).toBe(false);
    expect(find('orch').orchestration).toEqual({ orchestrate: true, maxHelpers: 2 });
  });

  it('an agent turned on stays on when its project and the app are off', async () => {
    setAgents(PROJECT, [agent('orch', { mcpOverride: true, orchestration: { orchestrate: true } })]);
    mcp.app = false;
    mcp.projects.set(PROJECT, false);
    live('orch');
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });
});
