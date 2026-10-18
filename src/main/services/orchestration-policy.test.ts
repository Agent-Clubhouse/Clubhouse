import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import type { DurableAgentConfig, HelperCascadeResult } from '../../shared/types';

const PROJECT = path.join('projects', 'app');
const OTHER_PROJECT = path.join('projects', 'other');

const state = vi.hoisted(() => ({
  agents: new Map<string, Record<string, unknown>[]>(),
  personas: new Map<string, string>(),
  projectDefaults: {} as { persona?: string },
  permissionMode: 'skip-all' as 'auto' | 'skip-all',
  globalCap: 20,
  running: new Set<string>(),
}));

const mocks = vi.hoisted(() => ({
  resolveHelpersForDelete: vi.fn(),
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
}));

vi.mock('./agent-system', () => ({
  isAgentRunning: (id: string) => state.running.has(id),
  killAgent: mocks.killAgent,
}));

vi.mock('./free-agent-settings', () => ({
  getPermissionMode: () => state.permissionMode,
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

import {
  checkHelperLimitFor,
  getHelperSummary,
  getOrchestrationPolicy,
  resolveHelperLaunchSettings,
  setOrchestrationPolicy,
  syncOrchestrationGate,
  turnOffOrchestration,
} from './orchestration-policy';
import { isOrchestrationEnabled, _resetOrchestrationGateForTesting } from './clubhouse-mcp/orchestration-gate';
import * as agentConfig from './agent-config';

function agent(id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name: id, color: 'blue', createdAt: '2026-10-18T00:00:00Z', ...extra };
}

function setAgents(projectPath: string, list: DurableAgentConfig[]): void {
  state.agents.set(projectPath, list as unknown as Record<string, unknown>[]);
}

function persona(policy: Record<string, unknown>): string {
  return `---\norchestration: ${JSON.stringify(policy)}\n---\n\n# Persona`;
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
  state.permissionMode = 'skip-all';
  state.globalCap = 20;
  state.running.clear();
  mocks.projectList.mockResolvedValue([{ id: 'p1', name: 'app', path: PROJECT }]);
  mocks.killAgent.mockResolvedValue(undefined);
});

describe('getOrchestrationPolicy', () => {
  it('returns the defaults and leaves orchestration off', async () => {
    setAgents(PROJECT, [agent('orch')]);
    const policy = await getOrchestrationPolicy(PROJECT, 'orch');
    expect(policy).toMatchObject({ orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 5 });
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('takes defaults from the agent\'s persona front-matter and opens the gate', async () => {
    state.personas.set('orchestrator', persona({ orchestrate: true, control: 'ask-before-start', maxHelpers: 3 }));
    setAgents(PROJECT, [agent('orch', { persona: 'orchestrator' })]);
    const policy = await getOrchestrationPolicy(PROJECT, 'orch');
    expect(policy).toMatchObject({ orchestrate: true, control: 'ask-before-start', maxHelpers: 3 });
    expect(policy?.sources.control).toBe('persona');
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('uses the Orchestrator persona\'s limits for other agents but never its orchestrate', async () => {
    state.personas.set('orchestrator', persona({ orchestrate: true, maxHelpers: 2 }));
    setAgents(PROJECT, [agent('dev', { persona: 'developer' })]);
    const policy = await getOrchestrationPolicy(PROJECT, 'dev');
    expect(policy).toMatchObject({ orchestrate: false, maxHelpers: 2 });
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
    const policy = await getOrchestrationPolicy(PROJECT, 'orch');
    expect(policy).toMatchObject({ orchestrate: false, access: 'auto' });
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('keeps the gate closed for a disposed agent', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true }, disposedAt: '2026-10-18T00:00:00Z' })]);
    await getOrchestrationPolicy(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('returns null for an unknown agent', async () => {
    expect(await getOrchestrationPolicy(PROJECT, 'nope')).toBeNull();
  });
});

describe('syncOrchestrationGate', () => {
  it('opens the gate from the stored config', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    await syncOrchestrationGate(PROJECT, 'orch');
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('fails closed when the config can\'t be read', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    await syncOrchestrationGate(PROJECT, 'orch');
    vi.mocked(agentConfig.getDurableConfig).mockRejectedValueOnce(new Error('disk gone'));
    await expect(syncOrchestrationGate(PROJECT, 'orch')).resolves.toBeUndefined();
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });
});

describe('setOrchestrationPolicy', () => {
  it('persists the change and opens the gate', async () => {
    setAgents(PROJECT, [agent('orch')]);
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: true, control: 'ask-everything' });
    expect(result.ok).toBe(true);
    expect(find('orch').orchestration).toEqual({ orchestrate: true, control: 'ask-everything' });
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('closes the gate when turned off without helpers', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } })]);
    await getOrchestrationPolicy(PROJECT, 'orch');
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false });
    expect(result.ok).toBe(true);
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
    await getOrchestrationPolicy(PROJECT, 'orch');
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { orchestrate: false });
    expect(result).toMatchObject({ ok: false, needsHelperChoice: { helperIds: ['h1'] } });
    expect(find('orch').orchestration).toEqual({ orchestrate: true });
    expect(isOrchestrationEnabled('orch')).toBe(true);
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
  });

  it('changes other fields of an orchestrator with helpers freely', async () => {
    setAgents(PROJECT, [agent('orch', { orchestration: { orchestrate: true } }), agent('h1', { parentAgentId: 'orch' })]);
    const result = await setOrchestrationPolicy(PROJECT, 'orch', { control: 'ask-before-start' });
    expect(result.ok).toBe(true);
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

describe('getHelperSummary', () => {
  it('lists live direct helpers only', async () => {
    setAgents(PROJECT, [
      agent('orch'),
      agent('h1', { parentAgentId: 'orch' }),
      agent('h1a', { parentAgentId: 'h1' }),
      agent('gone', { parentAgentId: 'orch', disposedAt: '2026-10-18T00:00:00Z' }),
    ]);
    expect(await getHelperSummary(PROJECT, 'orch')).toEqual({ hasHelpers: true, helperIds: ['h1'] });
    expect(await getHelperSummary(PROJECT, 'h1a')).toEqual({ hasHelpers: false, helperIds: [] });
  });
});

describe('turnOffOrchestration', () => {
  beforeEach(() => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { orchestrate: true, maxHelpers: 3 } }),
      agent('h1', { parentAgentId: 'orch' }),
      agent('h2', { parentAgentId: 'orch' }),
    ]);
  });

  it('cancel changes nothing', async () => {
    await getOrchestrationPolicy(PROJECT, 'orch');
    const result = await turnOffOrchestration(PROJECT, 'orch', 'cancel');
    expect(result).toMatchObject({ ok: true, cancelled: true });
    expect(mocks.resolveHelpersForDelete).not.toHaveBeenCalled();
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('keep releases the direct helpers and turns orchestration off', async () => {
    mocks.resolveHelpersForDelete.mockImplementation(async (projectPath: string, agentId: string) => {
      for (const a of agentsOf(projectPath)) if (a.parentAgentId === agentId) delete a.parentAgentId;
      return { ok: true, message: 'Kept 2 helper(s)', helperIds: ['h1', 'h2'] } satisfies HelperCascadeResult;
    });
    await getOrchestrationPolicy(PROJECT, 'orch');
    const result = await turnOffOrchestration(PROJECT, 'orch', 'keep');
    expect(mocks.resolveHelpersForDelete).toHaveBeenCalledWith(PROJECT, 'orch', 'keep');
    expect(result).toMatchObject({ ok: true, helperIds: ['h1', 'h2'] });
    expect(find('h1').parentAgentId).toBeUndefined();
    expect(find('orch').orchestration).toEqual({ orchestrate: false, maxHelpers: 3 });
    expect(result.policy?.orchestrate).toBe(false);
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('dispose stops running helpers and disposes through the cascade checks', async () => {
    state.running.add('h2');
    mocks.resolveHelpersForDelete.mockResolvedValue({ ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'] });
    await getOrchestrationPolicy(PROJECT, 'orch');
    const result = await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(mocks.resolveHelpersForDelete).toHaveBeenNthCalledWith(1, PROJECT, 'orch', 'dispose', { dryRun: true, force: undefined });
    expect(mocks.resolveHelpersForDelete).toHaveBeenNthCalledWith(2, PROJECT, 'orch', 'dispose', { force: undefined });
    expect(mocks.killAgent).toHaveBeenCalledTimes(1);
    expect(mocks.killAgent).toHaveBeenCalledWith('h2', PROJECT, undefined, 'user', { waitForExit: true });
    expect(result.ok).toBe(true);
    expect(isOrchestrationEnabled('orch')).toBe(false);
  });

  it('dispose with work at risk changes nothing and stops nothing', async () => {
    state.running.add('h1');
    const blocked = { ok: false, message: 'h1 has work', blocked: [{ agentId: 'h1', name: 'h1', checks: { dirty: 2, unpushed: 0, unmerged: 0 } }] };
    mocks.resolveHelpersForDelete.mockResolvedValue(blocked);
    await getOrchestrationPolicy(PROJECT, 'orch');
    const result = await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(result).toEqual(blocked);
    expect(mocks.killAgent).not.toHaveBeenCalled();
    expect(mocks.resolveHelpersForDelete).toHaveBeenCalledTimes(1);
    expect(agentConfig.setOrchestrationConfig).not.toHaveBeenCalled();
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('a failed dispose leaves orchestration on', async () => {
    mocks.resolveHelpersForDelete
      .mockResolvedValueOnce({ ok: true, message: 'Would dispose', helperIds: ['h1', 'h2'] })
      .mockResolvedValueOnce({ ok: false, message: 'Disposed 1 of 2 helpers', helperIds: ['h1'], failed: [{ agentId: 'h2', name: 'h2', reason: 'EBUSY' }] });
    await getOrchestrationPolicy(PROJECT, 'orch');
    const result = await turnOffOrchestration(PROJECT, 'orch', 'dispose');
    expect(result.ok).toBe(false);
    expect(isOrchestrationEnabled('orch')).toBe(true);
  });

  it('passes force through', async () => {
    mocks.resolveHelpersForDelete.mockResolvedValue({ ok: true, message: 'Disposed', helperIds: [] });
    await turnOffOrchestration(PROJECT, 'orch', 'dispose', { force: true });
    expect(mocks.resolveHelpersForDelete).toHaveBeenLastCalledWith(PROJECT, 'orch', 'dispose', { force: true });
  });

  it('rejects an unknown choice', async () => {
    await expect(turnOffOrchestration(PROJECT, 'orch', 'maybe' as never)).rejects.toThrow(/Unknown choice/);
  });
});

describe('resolveHelperLaunchSettings', () => {
  it('gives bypass helpers to a bypass orchestrator with same', async () => {
    setAgents(PROJECT, [agent('orch', { freeAgentMode: true })]);
    expect(await resolveHelperLaunchSettings(PROJECT, 'orch')).toMatchObject({
      freeAgentMode: true, permissionMode: 'skip-all', level: 'bypass', clamped: false,
    });
  });

  it('follows the project free-agent permission mode', async () => {
    state.permissionMode = 'auto';
    setAgents(PROJECT, [agent('orch', { freeAgentMode: true })]);
    expect((await resolveHelperLaunchSettings(PROJECT, 'orch')).level).toBe('auto');
  });

  it('prefers the mode the orchestrator actually runs with', async () => {
    setAgents(PROJECT, [agent('orch', { freeAgentMode: true })]);
    expect((await resolveHelperLaunchSettings(PROJECT, 'orch', { orchestratorPermissionMode: 'auto' })).level).toBe('auto');
  });

  it('never exceeds a standard orchestrator, whatever the policy asks', async () => {
    for (const access of ['same', 'standard', 'auto', 'bypass'] as const) {
      setAgents(PROJECT, [agent('orch', { orchestration: { access } })]);
      const resolved = await resolveHelperLaunchSettings(PROJECT, 'orch');
      expect(resolved).toMatchObject({ freeAgentMode: false, level: 'standard' });
      expect(resolved.permissionMode).toBeUndefined();
    }
  });

  it('uses a fixed lower level', async () => {
    setAgents(PROJECT, [agent('orch', { freeAgentMode: true, orchestration: { access: 'standard' } })]);
    expect(await resolveHelperLaunchSettings(PROJECT, 'orch')).toMatchObject({ freeAgentMode: false, level: 'standard' });
  });

  it('throws for an unknown orchestrator', async () => {
    await expect(resolveHelperLaunchSettings(PROJECT, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('checkHelperLimitFor', () => {
  it('counts the orchestrator\'s live helpers against its limit', async () => {
    setAgents(PROJECT, [
      agent('orch', { orchestration: { maxHelpers: 2 } }),
      agent('h1', { parentAgentId: 'orch' }),
      agent('h2', { parentAgentId: 'orch' }),
      agent('gone', { parentAgentId: 'orch', disposedAt: '2026-10-18T00:00:00Z' }),
    ]);
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: false, reason: 'agent-limit', helperCount: 2, maxHelpers: 2 });
  });

  it('counts live helpers in every project against the global cap', async () => {
    state.globalCap = 3;
    mocks.projectList.mockResolvedValue([
      { id: 'p1', name: 'app', path: PROJECT },
      { id: 'p2', name: 'other', path: OTHER_PROJECT },
    ]);
    setAgents(PROJECT, [agent('orch'), agent('h1', { parentAgentId: 'orch' })]);
    setAgents(OTHER_PROJECT, [agent('o2'), agent('x1', { parentAgentId: 'o2' }), agent('x2', { parentAgentId: 'o2' })]);
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: false, reason: 'global-cap', totalHelperCount: 3, globalCap: 3 });
  });

  it('skips a project it can\'t read', async () => {
    mocks.projectList.mockResolvedValue([{ id: 'p2', name: 'other', path: OTHER_PROJECT }]);
    setAgents(PROJECT, [agent('orch'), agent('h1', { parentAgentId: 'orch' })]);
    vi.mocked(agentConfig.listDurable).mockImplementation(async (p: string) => {
      if (p === OTHER_PROJECT) throw new Error('unreadable');
      return agentsOf(p);
    });
    expect(await checkHelperLimitFor(PROJECT, 'orch')).toMatchObject({ ok: true, helperCount: 1, totalHelperCount: 1 });
  });

  it('uses the given project paths instead of the store', async () => {
    setAgents(PROJECT, [agent('orch')]);
    await checkHelperLimitFor(PROJECT, 'orch', { projectPaths: [] });
    expect(mocks.projectList).not.toHaveBeenCalled();
  });
});
