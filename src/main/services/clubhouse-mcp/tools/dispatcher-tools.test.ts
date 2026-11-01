import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';

// ── Mocks: no CLI, git or disk is touched ──────────────────────────────────

const PROJECT_A = path.join(path.sep, 'tmp', 'alpha');
const PROJECT_B = path.join(path.sep, 'tmp', 'beta');
const DISPATCHER_DIR = path.join(path.sep, 'tmp', 'clubhouse', 'dispatcher');

/** Agents by project path. */
const agentsIn = new Map<string, DurableAgentConfig[]>();
/** Resolved policies by agent id; a missing id has no policy. */
const policies = new Map<string, Record<string, unknown>>();
const projects: Array<{ id: string; name: string; path: string; displayName?: string }> = [];
const running = new Set<string>();
const connections = new Map<string, { connectedAt: number; toolCount: number | null }>();
const branches = new Map<string, string>();
const dispatcherState = vi.hoisted(() => ({ enabled: true, agentId: 'dispatcher' as string | null }));
const dispatcherListeners = vi.hoisted(() => new Set<() => void>());

function findAgent(projectPath: string, id: string): DurableAgentConfig | null {
  return agentsIn.get(projectPath)?.find((a) => a.id === id) ?? null;
}

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => 'test-user-data' } }));
vi.mock('../../agent-config', () => ({
  listDurable: vi.fn(async (projectPath: string) => [...(agentsIn.get(projectPath) ?? [])]),
  getDurableConfig: vi.fn(async (projectPath: string, id: string) => findAgent(projectPath, id)),
  isSameProject: vi.fn(async (a: string, b: string) => path.resolve(a) === path.resolve(b)),
  onAgentConfigChanged: vi.fn(() => () => {}),
}));
vi.mock('../../agent-creation', () => ({ startDurableCreation: vi.fn(), personaInjection: vi.fn(() => ({})) }));
vi.mock('../../helper-index', () => ({
  // A helper is in the project it is listed in; its parent is in its parentProjectPath, else there.
  listHelpersEverywhere: vi.fn(async (home: string, id: string) => {
    const result: Array<{ projectPath: string; config: DurableAgentConfig }> = [];
    for (const [projectPath, agents] of agentsIn) {
      for (const config of agents) {
        if (config.parentAgentId === id && (config.parentProjectPath ?? projectPath) === home) result.push({ projectPath, config });
      }
    }
    return result;
  }),
  findParent: vi.fn(async () => null),
}));
vi.mock('../../project-store', () => ({ list: async () => [...projects] }));
vi.mock('../../materialization-service', () => ({ listAvailablePersonas: vi.fn(async () => []) }));
vi.mock('../../agent-system', () => ({
  spawnAgent: vi.fn(),
  killAgent: vi.fn(),
  isAgentRunning: (id: string) => running.has(id),
  isAgentStopping: () => false,
  waitForAgentStopped: vi.fn(),
}));
vi.mock('../../agent-runtime', () => ({
  getAgentRuntime: (id: string) => (running.has(id) ? { kind: 'chat', getState: () => (id.startsWith('busy') ? 'running' : 'idle') } : undefined),
}));
vi.mock('../../git-service', () => ({
  getGitInfo: vi.fn(async (dir: string) => ({ hasGit: true, branch: branches.get(dir) ?? 'main', ahead: 0, behind: 0, status: [], log: [] })),
  findGitCommonDir: async (dir: string) => (dir === DISPATCHER_DIR ? null : path.join(dir, '.git')),
  getDefaultBranch: async () => 'main',
}));
vi.mock('../../persona-application', () => ({ applyPersonaToAgent: vi.fn() }));
vi.mock('../../orchestration-policy', () => ({
  isCrossProjectAllowed: vi.fn(async () => false),
  checkHelperLimitFor: vi.fn(),
  getOrchestrationPolicy: vi.fn(async (_projectPath: string, id: string) => policies.get(id) ?? null),
  resolveOrchestrationPolicies: vi.fn(async (_projectPath: string, agents: DurableAgentConfig[]) =>
    new Map(agents.flatMap((a) => (policies.has(a.id) ? [[a.id, policies.get(a.id)]] : [])))),
  resolveHelperLaunchSettings: vi.fn(),
}));
vi.mock('../../../orchestrators', () => ({
  getProvider: (id: string) => ({ id }),
  getAllProviders: () => [{ id: 'claude-code' }],
}));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../bridge-server', () => ({ getAgentConnection: (id: string) => connections.get(id) ?? null }));
vi.mock('../../dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => dispatcherState.enabled }));
vi.mock('../../dispatcher/dispatcher-paths', () => ({
  isDispatcherPath: (p: string) => path.resolve(p) === path.resolve(DISPATCHER_DIR),
}));
vi.mock('../../dispatcher/dispatcher-service', () => ({
  isDispatcherAgentId: (id: string | null | undefined) => !!id && id === dispatcherState.agentId,
  onDispatcherChanged: (listener: () => void) => {
    dispatcherListeners.add(listener);
    return () => { dispatcherListeners.delete(listener); };
  },
}));

import { registerDispatcherTools } from './dispatcher-tools';
import { registerHelperTools, _resetHelperToolsForTesting } from './helper-tools';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { onOrchestrationGateChange, setOrchestrationEnabled, _resetOrchestrationGateForTesting } from '../orchestration-gate';
import { isDispatcherAgent, syncDispatcherGate, _resetDispatcherGateForTesting } from '../dispatcher-gate';
import * as agentConfig from '../../agent-config';
import { getOrchestrationPolicy, resolveOrchestrationPolicies } from '../../orchestration-policy';
import { resolveOrchestrationPolicy } from '../../../../shared/orchestration-policy';

// ── Fixtures ───────────────────────────────────────────────────────────────

const HELPER_TOOLS = ['start_helper', 'list_helpers', 'sleep_helper', 'wake_helper'];

function addAgent(projectPath: string, config: Partial<DurableAgentConfig> & { id: string }): DurableAgentConfig {
  const full: DurableAgentConfig = {
    name: config.id,
    color: 'indigo',
    createdAt: '2026-10-31T10:00:00.000Z',
    orchestrator: 'claude-code',
    ...config,
  };
  agentsIn.set(projectPath, [...(agentsIn.get(projectPath) ?? []), full]);
  return full;
}

function policy(fields: Record<string, unknown>): Record<string, unknown> {
  return { orchestrate: true, access: 'same', control: 'hands-off', maxHelpers: 5, crossProjectHelpers: false, ...fields };
}

/** A running agent the MCP knows. */
function runAgent(id: string, projectPath: string): void {
  running.add(id);
  agentRegistry.register(id, { projectPath, orchestrator: 'claude-code', runtime: 'chat' });
}

async function runDispatcher(): Promise<void> {
  addAgent(DISPATCHER_DIR, { id: 'dispatcher', name: 'Dispatcher', persona: 'dispatcher' });
  runAgent('dispatcher', DISPATCHER_DIR);
  await syncDispatcherGate(DISPATCHER_DIR, 'dispatcher');
}

function names(agentId: string): string[] {
  return getScopedToolList(agentId).map((t) => t.name);
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const id of agentRegistry.getAllRegistrations().keys()) agentRegistry.untrack(id);
  _resetForTesting();
  _resetHelperToolsForTesting();
  _resetOrchestrationGateForTesting();
  _resetDispatcherGateForTesting();
  agentsIn.clear();
  policies.clear();
  projects.length = 0;
  running.clear();
  connections.clear();
  branches.clear();
  dispatcherState.enabled = true;
  dispatcherState.agentId = 'dispatcher';
  dispatcherListeners.clear();
  projects.push({ id: 'proj_a', name: 'alpha', path: PROJECT_A }, { id: 'proj_b', name: 'beta', displayName: 'Beta', path: PROJECT_B });
  registerHelperTools();
  registerDispatcherTools();
});

// ── Gate ───────────────────────────────────────────────────────────────────

describe('dispatcher gate', () => {
  it('opens at spawn only for the Dispatcher in its own folder', async () => {
    await runDispatcher();
    expect(isDispatcherAgent('dispatcher')).toBe(true);
    expect(names('dispatcher')).toEqual(expect.arrayContaining(['list_agents', 'list_projects']));

    // The same id outside the folder, or another agent in it, gets nothing.
    await syncDispatcherGate(PROJECT_A, 'dispatcher');
    expect(isDispatcherAgent('dispatcher')).toBe(false);
    await syncDispatcherGate(DISPATCHER_DIR, 'someone-else');
    expect(isDispatcherAgent('someone-else')).toBe(false);
  });

  it('never gives the Dispatcher start_helper and the other helper tools', async () => {
    await runDispatcher();
    // Even if its orchestration gate were opened somehow.
    setOrchestrationEnabled('dispatcher', true, { crossProject: true });
    const listed = names('dispatcher');
    for (const tool of HELPER_TOOLS) expect(listed).not.toContain(tool);
    for (const tool of HELPER_TOOLS) expect((await callTool('dispatcher', tool, { name: 'x', task: 'y', helper: 'x' })).isError).toBe(true);
  });

  it('orchestrators never get list_agents', async () => {
    addAgent(PROJECT_A, { id: 'orch' });
    runAgent('orch', PROJECT_A);
    setOrchestrationEnabled('orch', true, { crossProject: true });
    expect(names('orch')).not.toContain('list_agents');
    expect(names('orch')).toEqual(expect.arrayContaining([...HELPER_TOOLS, 'list_projects']));
    const refused = await callTool('orch', 'list_agents', {});
    expect(refused).toMatchObject({ isError: true, content: [{ text: 'Only the Dispatcher can use this tool.' }] });
  });

  it('closes when the Dispatcher is turned off, and refreshes the tool list', async () => {
    await runDispatcher();
    expect(names('dispatcher')).toContain('list_agents');
    const listener = vi.fn();
    const off = onOrchestrationGateChange(listener);
    dispatcherState.enabled = false;
    for (const l of dispatcherListeners) l();
    off();
    expect(listener).toHaveBeenCalledWith('dispatcher');
    expect(names('dispatcher')).not.toContain('list_agents');
  });

  it('closes when the Dispatcher is untracked', async () => {
    await runDispatcher();
    agentRegistry.untrack('dispatcher');
    expect(isDispatcherAgent('dispatcher')).toBe(false);
  });
});

// ── list_agents ─────────────────────────────────────────────────────

describe('list_agents', () => {
  it('lists connected agents across projects with status, connection, branch and helpers', async () => {
    await runDispatcher();
    addAgent(PROJECT_A, { id: 'lead-a', name: 'Lead A' });
    addAgent(PROJECT_B, { id: 'busy-b', name: 'Lead B', worktreePath: path.join(PROJECT_B, 'wt') });
    addAgent(PROJECT_A, { id: 'h1', name: 'Helper 1', parentAgentId: 'lead-a' });
    // A helper of lead-a in the other project.
    addAgent(PROJECT_B, { id: 'h2', name: 'Helper 2', parentAgentId: 'lead-a', parentProjectPath: PROJECT_A });
    policies.set('lead-a', policy({ connectToDispatcher: true }));
    policies.set('busy-b', policy({ connectToDispatcher: true }));
    runAgent('lead-a', PROJECT_A);
    connections.set('lead-a', { connectedAt: 1, toolCount: 10 });
    runAgent('busy-b', PROJECT_B);
    runAgent('h1', PROJECT_A);
    branches.set(PROJECT_A, 'feature/a');
    branches.set(path.join(PROJECT_B, 'wt'), 'feature/b');

    const result = await callTool('dispatcher', 'list_agents', {});
    expect(result.isError).toBeFalsy();
    expect(parse(result).agents).toEqual([
      {
        id: 'lead-a',
        name: 'Lead A',
        project: { name: 'alpha', path: PROJECT_A },
        status: 'idle',
        orchestrates: true,
        connected: true,
        branch: 'feature/a',
        helpers: {
          count: 2,
          helpers: [
            { id: 'h1', name: 'Helper 1', project: 'alpha', status: 'idle' },
            { id: 'h2', name: 'Helper 2', project: 'Beta', status: 'sleeping' },
          ],
        },
      },
      {
        id: 'busy-b',
        name: 'Lead B',
        project: { name: 'Beta', path: PROJECT_B },
        status: 'running',
        orchestrates: true,
        // Running, but not connected to the bridge yet.
        connected: false,
        branch: 'feature/b',
        helpers: { count: 0, helpers: [] },
      },
    ]);
  });

  it('a sleeping agent is listed as sleeping and not connected', async () => {
    await runDispatcher();
    addAgent(PROJECT_A, { id: 'lead-a' });
    policies.set('lead-a', policy({ connectToDispatcher: true }));
    // Left over from an earlier run.
    connections.set('lead-a', { connectedAt: 1, toolCount: 10 });
    const [row] = parse(await callTool('dispatcher', 'list_agents', {})).agents as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ id: 'lead-a', status: 'sleeping', connected: false });
  });

  it('lists a plain agent that is connected, and says it does not orchestrate (#2578)', async () => {
    await runDispatcher();
    addAgent(PROJECT_A, { id: 'plain' });
    addAgent(PROJECT_A, { id: 'lead' });
    policies.set('plain', policy({ orchestrate: false, connectToDispatcher: true }));
    policies.set('lead', policy({ connectToDispatcher: true }));
    const rows = parse(await callTool('dispatcher', 'list_agents', {})).agents as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.id, r.orchestrates])).toEqual([['plain', false], ['lead', true]]);
  });

  it('leaves out a helper with the switch set, resolved by the real policy (#2578)', async () => {
    await runDispatcher();
    addAgent(PROJECT_A, { id: 'lead', orchestration: { orchestrate: true } });
    addAgent(PROJECT_A, { id: 'h', parentAgentId: 'lead', orchestration: { connectToDispatcher: true } });
    // Once: only the project with agents resolves.
    vi.mocked(resolveOrchestrationPolicies).mockImplementationOnce(async (_p, agents) =>
      new Map(agents.map((a) => [a.id, resolveOrchestrationPolicy(a.orchestration, undefined, { helper: !!a.parentAgentId })])));
    const rows = parse(await callTool('dispatcher', 'list_agents', {})).agents as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['lead']);
  });

  it('leaves out agents with the switch off, policies without the field, and disposed agents', async () => {
    await runDispatcher();
    addAgent(PROJECT_A, { id: 'opted-out' });
    addAgent(PROJECT_A, { id: 'no-field' });
    addAgent(PROJECT_A, { id: 'not-orch' });
    addAgent(PROJECT_A, { id: 'no-policy' });
    addAgent(PROJECT_B, { id: 'gone', disposedAt: '2026-10-30T10:00:00.000Z' });
    addAgent(PROJECT_B, { id: 'kept' });
    policies.set('opted-out', policy({ connectToDispatcher: false }));
    // Before #2534 the resolved policy has no connectToDispatcher: read as off.
    policies.set('no-field', policy({}));
    policies.set('not-orch', policy({ orchestrate: false, connectToDispatcher: false }));
    policies.set('gone', policy({ connectToDispatcher: true }));
    policies.set('kept', policy({ connectToDispatcher: true }));

    const body = parse(await callTool('dispatcher', 'list_agents', {}));
    expect((body.agents as Array<{ id: string }>).map((o) => o.id)).toEqual(['kept']);
  });

  it('reads each project\'s agents once, and resolves its policies in one call', async () => {
    await runDispatcher();
    for (const id of ['a1', 'a2', 'a3']) {
      addAgent(PROJECT_A, { id });
      policies.set(id, policy({ connectToDispatcher: true }));
    }
    addAgent(PROJECT_B, { id: 'b1' });
    vi.mocked(agentConfig.listDurable).mockClear();
    vi.mocked(agentConfig.getDurableConfig).mockClear();
    vi.mocked(getOrchestrationPolicy).mockClear();
    vi.mocked(resolveOrchestrationPolicies).mockClear();

    const body = parse(await callTool('dispatcher', 'list_agents', {}));
    expect((body.agents as Array<{ id: string }>).map((o) => o.id)).toEqual(['a1', 'a2', 'a3']);
    const reads = vi.mocked(agentConfig.listDurable).mock.calls.map(([p]) => p);
    expect(reads.filter((p) => p === PROJECT_A)).toHaveLength(1);
    expect(reads.filter((p) => p === PROJECT_B)).toHaveLength(1);
    expect(agentConfig.getDurableConfig).not.toHaveBeenCalled();
    expect(getOrchestrationPolicy).not.toHaveBeenCalled();
    expect(vi.mocked(resolveOrchestrationPolicies).mock.calls.map(([p]) => p).sort()).toEqual([PROJECT_A, PROJECT_B].sort());
  });

  it('never lists the Dispatcher itself (its folder is not a project)', async () => {
    await runDispatcher();
    policies.set('dispatcher', policy({ connectToDispatcher: true }));
    expect(parse(await callTool('dispatcher', 'list_agents', {})).agents).toEqual([]);
  });
});

// ── list_projects for the Dispatcher ───────────────────────────────────────

describe('list_projects for the Dispatcher', () => {
  it('lists every project and marks none of them "yours"', async () => {
    await runDispatcher();
    const body = parse(await callTool('dispatcher', 'list_projects', {}));
    expect(body.projects).toEqual([
      { name: 'alpha', path: PROJECT_A, defaultBranch: 'main', personas: [] },
      { name: 'Beta', path: PROJECT_B, defaultBranch: 'main', personas: [] },
    ]);
  });
});

describe('list_agents with Clubhouse MCP off (#2589)', () => {
  it('leaves out an agent whose saved switch is on but MCP is off, and lists it again when MCP is back', async () => {
    await runDispatcher();
    addAgent(PROJECT_A, { id: 'lead-a', name: 'Lead A' });
    policies.set('lead-a', {
      ...policy({ orchestrate: false, connectToDispatcher: false }),
      mcpOff: { orchestrate: true, crossProjectHelpers: false, connectToDispatcher: true },
    });
    expect(parse(await callTool('dispatcher', 'list_agents', {})).agents).toEqual([]);

    policies.set('lead-a', policy({ connectToDispatcher: true }));
    expect(parse(await callTool('dispatcher', 'list_agents', {})).agents.map((a: { id: string }) => a.id)).toEqual(['lead-a']);
  });
});
