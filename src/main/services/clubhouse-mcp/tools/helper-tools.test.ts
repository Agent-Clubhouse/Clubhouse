import * as path from 'path';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';
import type { ModelList } from '../../../orchestrators/types';
import { IPC } from '../../../../shared/ipc-channels';
import { resolveHelperAccess, type AgentLaunchAccess } from '../../../../shared/orchestration-policy';

// ── Mocks: no CLI, git or disk is touched ──────────────────────────────────

const agents = new Map<string, DurableAgentConfig>();
/**
 * The project an agent's row is in, for agents in another project (#2515).
 * Reads and writes for those agents only find them at that path.
 */
const where = new Map<string, string>();
const isAt = (projectPath: string, id: string) => !where.has(id) || where.get(id) === projectPath;
const configListeners = new Set<(projectPath: string) => void>();

const mockCheckDurableCreation = vi.fn(async (_projectPath: string, _params: Record<string, unknown>) => {});
vi.mock('../../agent-config', () => ({
  checkDurableCreation: (projectPath: string, params: Record<string, unknown>) => mockCheckDurableCreation(projectPath, params),
  onAgentConfigChanged: vi.fn((listener: (projectPath: string) => void) => {
    configListeners.add(listener);
    return () => { configListeners.delete(listener); };
  }),
  getDurableConfig: vi.fn(async (projectPath: string, id: string) => (isAt(projectPath, id) ? agents.get(id) ?? null : null)),
  isSameProject: vi.fn(async (a: string, b: string) => path.resolve(a) === path.resolve(b)),
  setHelperStartFields: vi.fn(async (projectPath: string, id: string, fields: { pendingTask?: string | null; requestedAccess?: string | null }) => {
    const agent = agents.get(id);
    if (!agent || !isAt(projectPath, id)) return;
    const next: Record<string, unknown> = { ...agent };
    for (const key of ['pendingTask', 'requestedAccess'] as const) {
      if (fields[key] === undefined) continue;
      if (fields[key]) next[key] = fields[key];
      else delete next[key];
    }
    agents.set(id, next as unknown as DurableAgentConfig);
  }),
}));

const mockStartDurableCreation = vi.fn();

/** The real persona rule creation runs (#2551), for a mocked creation step to apply. */
async function realPersonaRule(projectPath: string, params: { persona?: string }): Promise<void> {
  const { assertPersonaAllowed } = await vi.importActual<typeof import('../../agent-config')>('../../agent-config');
  assertPersonaAllowed(projectPath, params.persona);
}
const mockPersonaInjection = vi.fn((projectPath: string, params: { persona?: string }) => ({
  inject: params.persona ? async (created: DurableAgentConfig) => mockApplyPersona(projectPath, created.id, params.persona) : undefined,
}));
vi.mock('../../agent-creation', () => ({
  startDurableCreation: (...args: unknown[]) => mockStartDurableCreation(...args),
  personaInjection: (projectPath: string, params: { persona?: string }) => mockPersonaInjection(projectPath, params),
}));

const helperPathOf = (id: string) => where.get(id) ?? PROJECT;
vi.mock('../../helper-index', () => ({
  // A helper's parent is in its parentProjectPath, else in the helper's own project.
  listHelpersEverywhere: vi.fn(async (home: string, id: string) => [...agents.values()]
    .filter((a) => a.parentAgentId === id && !a.disposedAt && (a.parentProjectPath ?? helperPathOf(a.id)) === home)
    .map((config) => ({ projectPath: helperPathOf(config.id), config }))),
  findParent: vi.fn(async (helperPath: string, config: DurableAgentConfig) => {
    const parentPath = config.parentProjectPath ?? helperPath;
    const parent = config.parentAgentId ? agents.get(config.parentAgentId) : undefined;
    return parent && isAt(parentPath, parent.id) ? { projectPath: parentPath, config: parent } : null;
  }),
}));

/** Registered local projects (#2515), and the git common dir of each path (null: not a repository). */
const projects: Array<{ id: string; name: string; path: string; displayName?: string }> = [];
const gitDirs = new Map<string, string | null>();
vi.mock('../../project-store', () => ({ list: async () => [...projects] }));
const mockListPersonas = vi.fn();
vi.mock('../../materialization-service', () => ({ listAvailablePersonas: (...args: unknown[]) => mockListPersonas(...args) }));

const running = new Set<string>();
/** Helpers told to stop whose process has not exited: id → the exit the test triggers. */
const stopping = new Map<string, { exited: Promise<void>; exit: () => void }>();
const mockSpawnAgent = vi.fn();
const mockKillAgent = vi.fn();
vi.mock('../../agent-system', () => ({
  resolveProfileEnv: (...args: unknown[]) => mockResolveProfileEnv(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  killAgent: (...args: unknown[]) => mockKillAgent(...args),
  isAgentRunning: (id: string) => running.has(id),
  isAgentStopping: (id: string) => stopping.has(id),
  waitForAgentStopped: async (id: string) => {
    await stopping.get(id)?.exited;
    return !running.has(id);
  },
}));

/** Begin a stop the way gracefulKill does: still running until `exit()`. */
function beginStop(id: string, onExit?: () => void) {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = () => {
      stopping.delete(id);
      running.delete(id);
      onExit?.();
      resolve();
    };
  });
  stopping.set(id, { exited, exit });
  return stopping.get(id)!;
}

const sent = new Map<string, string[]>();
/** Terminal agents whose runtime refuses input because they are shutting down. */
const refusing = new Set<string>();
vi.mock('../../agent-runtime', () => ({
  getAgentRuntime: (id: string) => (running.has(id)
    ? {
      kind: 'chat',
      agentId: id,
      isRunning: () => true,
      getState: () => 'idle',
      sendMessage: async (text: string) => {
        if (refusing.has(id)) throw new AgentStoppingError(id);
        sent.set(id, [...(sent.get(id) ?? []), text]);
        return { delivered: true };
      },
    }
    : undefined),
}));

const mockGetGitInfo = vi.fn();
vi.mock('../../git-service', () => ({
  getGitInfo: (...args: unknown[]) => mockGetGitInfo(...args),
  findGitCommonDir: async (dir: string) => (gitDirs.has(dir) ? gitDirs.get(dir) : path.join(dir, '.git')),
  getDefaultBranch: async (dir: string) => (gitDirs.get(dir) === null ? null : 'main'),
}));

const mockApplyPersona = vi.fn();
vi.mock('../../persona-application', () => ({ applyPersonaToAgent: (...args: unknown[]) => mockApplyPersona(...args) }));

const mockCheckLimit = vi.fn();
const mockGetPolicy = vi.fn();
const mockResolveLaunch = vi.fn();
const mockCrossAllowed = vi.fn();
vi.mock('../../orchestration-policy', () => ({
  isCrossProjectAllowed: (...args: unknown[]) => mockCrossAllowed(...args),
  checkHelperLimitFor: (...args: unknown[]) => mockCheckLimit(...args),
  getOrchestrationPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  resolveHelperLaunchSettings: (...args: unknown[]) => mockResolveLaunch(...args),
}));

/** Model lists per provider id (#2569); a provider without one can't list models. */
const modelLists = new Map<string, ModelList>();
/** Claude Code's real alias rules, loaded in beforeAll. */
let claudeAcceptsModel: (model: string, list: ModelList) => boolean;
const mockResolveProfileEnv = vi.fn(async (..._args: unknown[]): Promise<Record<string, string> | undefined> => undefined);
vi.mock('../../../orchestrators', () => ({
  getProvider: (id: string) => (['claude-code', 'codex-cli', 'copilot-cli'].includes(id)
    ? {
      id,
      getCapabilities: () => ({}),
      ...(modelLists.has(id) && { listModels: async () => modelLists.get(id) }),
      ...(id === 'claude-code' && { acceptsModel: (m: string, l: ModelList) => claudeAcceptsModel(m, l) }),
    }
    : undefined),
  getAllProviders: () => [{ id: 'claude-code' }, { id: 'codex-cli' }, { id: 'copilot-cli' }],
}));

const mockBroadcast = vi.fn();
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { AgentStoppingError } from '../../agent-runtime/agent-stopping';
import {
  approveHelperStart,
  declineHelperStart,
  registerHelperTools,
  watchHelperStartRequests,
  _resetHelperToolsForTesting,
  _settleHelperStartsForTesting,
} from './helper-tools';
import { listStartRequests, START_REQUEST_TTL_MS, _resetStartRequestsForTesting } from '../../helper-start-requests';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from '../orchestration-gate';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** The orchestrator's live launch access, the ceiling the policy mock ranks against. */
let live: AgentLaunchAccess;

const PROJECT = path.join(path.sep, 'tmp', 'project');
/** Another registered project, in another repository (#2515). */
const FAR = path.join(path.sep, 'tmp', 'far-project');
const worktreeOf = (folder: string) => path.join(PROJECT, '.clubhouse', 'agents', folder);

function addAgent(config: Partial<DurableAgentConfig> & { id: string }): DurableAgentConfig {
  const full: DurableAgentConfig = {
    name: config.id,
    color: 'indigo',
    createdAt: '2026-10-18T10:00:00.000Z',
    orchestrator: 'claude-code',
    ...config,
  };
  agents.set(full.id, full);
  return full;
}

/** A running agent the MCP knows, optionally with orchestration on. */
function runAgent(id: string, orchestrate = false): void {
  running.add(id);
  agentRegistry.register(id, { projectPath: PROJECT, orchestrator: 'claude-code', runtime: 'chat' });
  setOrchestrationEnabled(id, orchestrate);
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/** A creation the test finishes by hand. */
function controllableCreation() {
  let finish!: (outcome: 'ready' | 'failed' | 'cancelled') => void;
  const done = new Promise<'ready' | 'failed' | 'cancelled'>((resolve) => { finish = resolve; });
  mockStartDurableCreation.mockImplementation(async (projectPath: string, params: { name: string; folderName?: string; parentAgentId: string; parentProjectPath?: string }) => {
    const folder = params.folderName ?? params.name;
    if (projectPath !== PROJECT) where.set(`helper_${params.name}`, projectPath);
    const config = addAgent({
      id: `helper_${params.name}`,
      name: params.name,
      parentAgentId: params.parentAgentId,
      ...(params.parentProjectPath && { parentProjectPath: params.parentProjectPath }),
      disposable: true,
      branch: `${folder}/standby`,
      worktreePath: path.join(projectPath, '.clubhouse', 'agents', folder),
      creation: { state: 'creating', startedAt: '2026-10-18T10:00:00.000Z' },
    });
    return { agentId: config.id, config, done };
  });
  return {
    ready(id: string) {
      const { creation: _c, ...rest } = agents.get(id)!;
      agents.set(id, rest);
      finish('ready');
    },
    fail(id: string, reason: string) {
      agents.set(id, { ...agents.get(id)!, creation: { state: 'failed', startedAt: '2026-10-18T10:00:00.000Z', reason } });
      finish('failed');
    },
  };
}

beforeAll(async () => {
  const { ClaudeCodeProvider } = await vi.importActual<typeof import('../../../orchestrators/claude-code-provider')>(
    '../../../orchestrators/claude-code-provider',
  );
  claudeAcceptsModel = (m, l) => ClaudeCodeProvider.prototype.acceptsModel.call(null, m, l);
});

beforeEach(() => {
  vi.clearAllMocks();
  modelLists.clear();
  agents.clear();
  where.clear();
  gitDirs.clear();
  projects.splice(0, projects.length,
    { id: 'proj_home', name: 'home', path: PROJECT },
    { id: 'proj_far', name: 'far', displayName: 'Far Away', path: FAR });
  running.clear();
  stopping.clear();
  refusing.clear();
  sent.clear();
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  _resetOrchestrationGateForTesting();
  _resetHelperToolsForTesting();
  _resetStartRequestsForTesting();
  configListeners.clear();
  registerHelperTools();

  mockCrossAllowed.mockResolvedValue(true);
  mockListPersonas.mockResolvedValue([{ id: 'workhorse', name: 'Workhorse', source: 'builtin' }]);
  mockCheckLimit.mockResolvedValue({ ok: true, helperCount: 0, totalHelperCount: 0, maxHelpers: 5, globalCap: 20 });
  mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'hands-off', maxHelpers: 5 });
  live = { freeAgentMode: true, permissionMode: 'auto' };
  // The real ranking, against the orchestrator's live level in `live`.
  mockResolveLaunch.mockImplementation(async (_p: string, _o: string, options: { helperProvider?: string } = {}) =>
    resolveHelperAccess(live, 'same', options.helperProvider));
  mockSpawnAgent.mockImplementation(async (params: { agentId: string }) => { running.add(params.agentId); });
  // With waitForExit, killAgent resolves once the process is gone.
  mockKillAgent.mockImplementation(async (id: string) => { running.delete(id); });
  mockGetGitInfo.mockResolvedValue({
    hasGit: true, branch: 'x/standby', ahead: 2, behind: 1,
    status: [{ path: 'a.ts', status: 'M', staged: false }],
    log: [{ hash: 'h', shortHash: 'h', subject: 'wip', author: 'a', date: '2 minutes ago' }],
  });

  addAgent({ id: 'orch', name: 'Orch' });
  runAgent('orch', true);
});

// ── Gating ─────────────────────────────────────────────────────────────────

describe('gating', () => {
  it('lists the orchestration tools only while orchestration is on; message_parent always', () => {
    addAgent({ id: 'plain' });
    runAgent('plain', false);
    const plain = getScopedToolList('plain').map((t) => t.name);
    expect(plain).toContain('message_parent');
    expect(plain).not.toContain('start_helper');
    expect(plain).not.toContain('list_helpers');

    const orch = getScopedToolList('orch').map((t) => t.name);
    expect(orch).toEqual(expect.arrayContaining(['start_helper', 'list_helpers', 'sleep_helper', 'wake_helper', 'message_parent']));
  });

  it('refuses start_helper for an agent with orchestration off', async () => {
    addAgent({ id: 'plain' });
    runAgent('plain', false);
    const result = await callTool('plain', 'start_helper', { name: 'h', task: 't' });
    expect(result.isError).toBe(true);
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });
});

// ── start_helper ───────────────────────────────────────────────────────────

describe('start_helper', () => {
  it('refuses the dispatcher persona up front, with nothing created (#2551)', async () => {
    mockStartDurableCreation.mockImplementationOnce(realPersonaRule);
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't', persona: 'dispatcher' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Could not start helper "h": The Dispatcher persona is only for the Dispatcher.');
    expect(mockApplyPersona).not.toHaveBeenCalled();
    expect(parse(await callTool('orch', 'list_helpers', {})).helpers).toEqual([]);
  });

  it('returns "starting" before the creation completes, then spawns with the task and tells the orchestrator', async () => {
    const creation = controllableCreation();
    const result = await callTool('orch', 'start_helper', { name: 'fixer', task: 'Fix the bug', folder: 'fixer-1', branchFrom: 'main' });

    expect(result.isError).toBeFalsy();
    const body = parse(result);
    expect(body).toMatchObject({ helperId: 'helper_fixer', state: 'starting' });
    expect(mockSpawnAgent).not.toHaveBeenCalled();

    const [projectPath, params] = mockStartDurableCreation.mock.calls[0];
    expect(projectPath).toBe(PROJECT);
    expect(params).toMatchObject({ name: 'fixer', parentAgentId: 'orch', disposable: true, folderName: 'fixer-1', branchFrom: 'main', freeAgentMode: true });

    creation.ready('helper_fixer');
    await _settleHelperStartsForTesting();

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const spawn = mockSpawnAgent.mock.calls[0][0];
    expect(spawn).toMatchObject({ agentId: 'helper_fixer', projectPath: PROJECT, cwd: worktreeOf('fixer-1'), kind: 'durable' });
    expect(spawn.mission).toContain('Fix the bug');
    expect(spawn.mission).toContain('message_parent');
    expect(sent.get('orch')?.[0]).toMatch(/fixer.*is ready on branch fixer-1\/standby/);
  });

  it('passes an explicit freeAgentMode and permissionMode to spawn', async () => {
    mockResolveLaunch.mockResolvedValue({ freeAgentMode: false, permissionMode: 'auto', level: 'standard', ceiling: 'standard', clamped: false });
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();

    const spawn = mockSpawnAgent.mock.calls[0][0];
    expect(spawn).toHaveProperty('freeAgentMode', false);
    expect(spawn).toHaveProperty('permissionMode', 'auto');
  });

  it('clamps a requested access to the resolved ceiling, and lowers it when asked', async () => {
    controllableCreation();
    const higher = parse(await callTool('orch', 'start_helper', { name: 'a', task: 't', access: 'bypass' }));
    expect(higher.access).toBe('auto');
    expect(higher.accessNote).toBeDefined();

    const lower = parse(await callTool('orch', 'start_helper', { name: 'b', task: 't', access: 'standard' }));
    expect(lower.access).toBe('standard');
    expect(mockStartDurableCreation.mock.calls[1][1]).toMatchObject({ freeAgentMode: false });
  });

  it('resolves the launch settings for the requested cli', async () => {
    controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't', cli: 'copilot-cli' });
    expect(mockResolveLaunch).toHaveBeenCalledWith(PROJECT, 'orch', { helperProvider: 'copilot-cli' });
    expect(mockStartDurableCreation.mock.calls[0][1]).toMatchObject({ orchestrator: 'copilot-cli' });
  });

  it('rejects an unknown cli and a bad access level', async () => {
    expect((await callTool('orch', 'start_helper', { name: 'h', task: 't', cli: 'nope' })).isError).toBe(true);
    expect((await callTool('orch', 'start_helper', { name: 'h', task: 't', access: 'root' })).isError).toBe(true);
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  it('refuses when the helper limit is reached', async () => {
    mockCheckLimit.mockResolvedValue({
      ok: false, reason: 'agent-limit', message: 'This agent already has 5 of 5 helpers.',
      helperCount: 5, totalHelperCount: 5, maxHelpers: 5, globalCap: 20,
    });
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('5 of 5');
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  it('asks the user under "ask before starting" instead of creating', async () => {
    mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'ask-before-start', maxHelpers: 5 });
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    expect(parse(result)).toMatchObject({ state: 'needs_approval', control: 'ask-before-start' });
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.APP.AGENT_ATTENTION, 'orch', expect.objectContaining({ title: expect.stringContaining('Orch') }));
  });

  it('reports a refused creation as an error', async () => {
    mockStartDurableCreation.mockRejectedValue(new Error('An agent named "h" already exists'));
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('tells the orchestrator why a creation failed, and does not spawn', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    creation.fail('helper_h', 'git worktree add failed.');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(sent.get('orch')?.[0]).toContain('failed to start: git worktree add failed.');
  });

  it('tells the orchestrator when the spawn fails, and lists the helper as failed', async () => {
    mockSpawnAgent.mockRejectedValue(new Error('claude CLI is not available'));
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(sent.get('orch')?.[0]).toContain('claude CLI is not available');
    const list = parse(await callTool('orch', 'list_helpers', {}));
    expect(list.helpers).toEqual([expect.objectContaining({ helperId: 'helper_h', status: 'failed', reason: 'claude CLI is not available' })]);
  });

  it('applies a persona in the creation inject step', async () => {
    controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't', persona: 'workhorse' });
    const [, params, options] = mockStartDurableCreation.mock.calls[0];
    expect(params.persona).toBe('workhorse');
    expect(mockPersonaInjection).toHaveBeenCalledWith(PROJECT, params);
    await options.inject(agents.get('helper_h'));
    expect(mockApplyPersona).toHaveBeenCalledWith(PROJECT, 'helper_h', 'workhorse');
  });
});

// ── start_helper: what changes during creation ─────────────────────────────

describe('start_helper model check (#2569)', () => {
  const claudeLive: ModelList = {
    source: 'live', via: 'handshake', fetchedAt: 0,
    models: [
      { id: 'default', label: 'Default', isDefault: true, resolvedId: 'claude-opus-5-5' },
      { id: 'opus', label: 'Opus 5.5', resolvedId: 'claude-opus-5-5' },
      { id: 'haiku', label: 'Haiku 5.5', resolvedId: 'claude-haiku-5-5' },
    ],
  };
  const codexFallback: ModelList = {
    source: 'fallback', via: 'static', fetchedAt: 0, liveError: 'model handshake timed out after 10000ms',
    models: [{ id: 'default', label: 'Default' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
  };

  it('starts a helper with a model the CLI\'s live list has', async () => {
    controllableCreation();
    modelLists.set('claude-code', claudeLive);
    const body = parse(await callTool('orch', 'start_helper', { name: 'h', task: 't', model: 'haiku' }));
    expect(body).toMatchObject({ state: 'starting' });
    expect(body.modelWarning).toBeUndefined();
    expect(mockStartDurableCreation.mock.calls[0][1]).toMatchObject({ model: 'haiku' });
  });

  it('refuses a model missing from a live list, naming the valid ids, and creates nothing', async () => {
    modelLists.set('claude-code', claudeLive);
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't', model: 'gpt-5.6-sol' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'Model "gpt-5.6-sol" is not one claude-code accepts. Valid ids: default, opus, haiku. Call list_models for details.',
    );
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  it('only warns for a model missing from a fallback list', async () => {
    controllableCreation();
    modelLists.set('codex-cli', codexFallback);
    const body = parse(await callTool('orch', 'start_helper', { name: 'h', task: 't', cli: 'codex-cli', model: 'gpt-7' }));
    expect(body).toMatchObject({ state: 'starting' });
    expect(body.modelWarning).toContain('Model "gpt-7" is not in codex-cli\'s fallback model list (default, gpt-5.6-sol)');
    expect(body.modelWarning).toContain('model handshake timed out');
    expect(mockStartDurableCreation.mock.calls[0][1]).toMatchObject({ model: 'gpt-7', orchestrator: 'codex-cli' });
  });

  it('accepts an alias the CLI resolves itself', async () => {
    controllableCreation();
    modelLists.set('claude-code', claudeLive);
    for (const model of ['opus[1m]', 'sonnet', 'claude-opus-5-5']) {
      const result = await callTool('orch', 'start_helper', { name: `h-${model.replace(/\W/g, '')}`, task: 't', model });
      expect(result.isError, model).toBeFalsy();
    }
  });

  it('checks against the helper\'s CLI, not the orchestrator\'s', async () => {
    modelLists.set('claude-code', claudeLive);
    modelLists.set('codex-cli', { ...codexFallback, source: 'live', via: 'handshake' });
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't', cli: 'codex-cli', model: 'opus' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not one codex-cli accepts');
  });

  it('lists under the profile of the project the helper is created in', async () => {
    controllableCreation();
    modelLists.set('claude-code', claudeLive);
    await callTool('orch', 'start_helper', { name: 'h', task: 't', model: 'opus', project: 'far' });
    expect(mockResolveProfileEnv).toHaveBeenCalledWith(FAR, 'claude-code');
  });

  it('refuses before holding a start for approval', async () => {
    mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'ask-before-start', maxHelpers: 5 });
    modelLists.set('claude-code', claudeLive);
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't', model: 'nope' });
    expect(result.isError).toBe(true);
    expect(listStartRequests()).toEqual([]);
  });

  it('skips the check for a CLI that can\'t list models', async () => {
    controllableCreation();
    const body = parse(await callTool('orch', 'start_helper', { name: 'h', task: 't', model: 'anything' }));
    expect(body).toMatchObject({ state: 'starting' });
    expect(body.modelWarning).toBeUndefined();
  });
});

describe('start_helper re-checks at spawn time', () => {
  it('ranks access again when a persona switched the CLI during creation', async () => {
    // A Claude orchestrator at auto: Claude auto is --permission-mode auto,
    // but any Free Agent Mode on Copilot is --yolo.
    const creation = controllableCreation();
    const started = parse(await callTool('orch', 'start_helper', { name: 'h', task: 't', persona: 'copilot-fan' }));
    expect(started.access).toBe('auto');

    agents.set('helper_h', { ...agents.get('helper_h')!, orchestrator: 'copilot-cli' });
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();

    expect(mockResolveLaunch).toHaveBeenLastCalledWith(PROJECT, 'orch', { helperProvider: 'copilot-cli' });
    const spawn = mockSpawnAgent.mock.calls[0][0];
    expect(spawn).toMatchObject({ orchestrator: 'copilot-cli', freeAgentMode: false });
    expect(sent.get('orch')?.[0]).toContain('with standard access');
  });

  it('ranks a requested level for the helper CLI and reports the real level', async () => {
    live = { freeAgentMode: true, permissionMode: 'skip-all' };
    controllableCreation();
    const result = parse(await callTool('orch', 'start_helper', { name: 'h', task: 't', cli: 'copilot-cli', access: 'auto' }));
    // Copilot has no auto: Free Agent Mode would be --yolo, so it starts standard.
    expect(result.access).toBe('standard');
    expect(mockStartDurableCreation.mock.calls[0][1]).toMatchObject({ freeAgentMode: false });
  });

  it('uses the orchestrator\'s level at spawn time when it was lowered during creation', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    live = { freeAgentMode: false, permissionMode: 'auto' };
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent.mock.calls[0][0]).toMatchObject({ freeAgentMode: false, permissionMode: 'auto' });
  });

  it('leaves the helper asleep, with its task saved, when orchestration was turned off', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 'Fix it' });
    setOrchestrationEnabled('orch', false);
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(agents.get('helper_h')?.pendingTask).toBe('Fix it');
    expect(sent.get('orch')?.[0]).toContain('orchestration was turned off');
  });

  it('leaves the helper asleep when the orchestrator stopped', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 'Fix it' });
    running.delete('orch');
    agentRegistry.untrack('orch');
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(agents.get('helper_h')?.pendingTask).toBe('Fix it');
    expect(sent.get('orch')).toBeUndefined();
  });

  it('leaves the helper asleep when it was reparented', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    agents.set('helper_h', { ...agents.get('helper_h')!, parentAgentId: undefined });
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('clears the saved task once the spawn delivered it', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(agents.get('helper_h')?.pendingTask).toBeUndefined();
  });

  it('re-reads the helper after resolving access: a reparent during resolution blocks the spawn', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    mockResolveLaunch.mockImplementation(async (_p: string, _o: string, options: { helperProvider?: string } = {}) => {
      agents.set('helper_h', { ...agents.get('helper_h')!, parentAgentId: 'someone-else' });
      return resolveHelperAccess(live, 'same', options.helperProvider);
    });
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(agents.get('helper_h')?.pendingTask).toBe('t');
  });

  it('takes the task off the helper during the spawn, and puts it back if the spawn fails', async () => {
    const creation = controllableCreation();
    let fail!: (err: Error) => void;
    mockSpawnAgent.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    await callTool('orch', 'start_helper', { name: 'h', task: 'Fix it' });
    creation.ready('helper_h');
    await vi.waitFor(() => expect(mockSpawnAgent).toHaveBeenCalled());
    expect(agents.get('helper_h')?.pendingTask).toBeUndefined();
    fail(new Error('boom'));
    await _settleHelperStartsForTesting();
    expect(agents.get('helper_h')?.pendingTask).toBe('Fix it');
  });

  it('keeps the requested access on the helper, so a later wake never goes above it', async () => {
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't', access: 'standard' });
    creation.ready('helper_h');
    await _settleHelperStartsForTesting();
    expect(agents.get('helper_h')?.requestedAccess).toBe('standard');
    expect(mockSpawnAgent.mock.calls[0][0]).toMatchObject({ freeAgentMode: false });

    running.delete('helper_h');
    live = { freeAgentMode: true, permissionMode: 'skip-all' };
    await callTool('orch', 'wake_helper', { helper: 'h' });
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    expect(mockSpawnAgent.mock.calls[1][0]).toMatchObject({ freeAgentMode: false });
  });

  it('serializes concurrent starts so both cannot pass the limit', async () => {
    mockCheckLimit.mockImplementation(async (_p: string, id: string) => {
      const helperCount = [...agents.values()].filter((a) => a.parentAgentId === id).length;
      return helperCount >= 1
        ? { ok: false, reason: 'agent-limit', message: `This agent already has ${helperCount} of 1 helpers.`, helperCount, totalHelperCount: helperCount, maxHelpers: 1, globalCap: 20 }
        : { ok: true, helperCount, totalHelperCount: helperCount, maxHelpers: 1, globalCap: 20 };
    });
    controllableCreation();
    const [a, b] = await Promise.all([
      callTool('orch', 'start_helper', { name: 'a', task: 't' }),
      callTool('orch', 'start_helper', { name: 'b', task: 't' }),
    ]);
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    expect(mockStartDurableCreation).toHaveBeenCalledTimes(1);
  });

  it('notifies the user about a needed approval at most once a minute', async () => {
    mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'ask-everything', maxHelpers: 5 });
    await callTool('orch', 'start_helper', { name: 'a', task: 't' });
    await callTool('orch', 'start_helper', { name: 'b', task: 't' });
    const attention = mockBroadcast.mock.calls.filter((c) => c[0] === IPC.APP.AGENT_ATTENTION);
    expect(attention).toHaveLength(1);
  });
});

// ── Start approvals (#2234) ────────────────────────────────────────────────

describe('start approvals', () => {
  const OTHER_PROJECT = path.join(path.sep, 'tmp', 'other-project');

  beforeEach(() => {
    mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'ask-before-start', maxHelpers: 5 });
  });

  async function ask(args: Record<string, unknown> = { name: 'impl-api', task: 'Build the API' }): Promise<string> {
    const result = await callTool('orch', 'start_helper', args);
    const body = parse(result);
    expect(body.state).toBe('needs_approval');
    return body.requestId as string;
  }

  it('holds the start with a request id and says requests are kept in memory and expire', async () => {
    const result = await callTool('orch', 'start_helper', {
      name: 'impl-api', task: 'Build the API', persona: 'qa', cli: 'codex-cli', model: 'm', access: 'auto', branchFrom: 'main', folder: 'api',
    });
    const body = parse(result);
    expect(body).toMatchObject({ state: 'needs_approval', control: 'ask-before-start', requestId: expect.stringMatching(/^hstart_/) });
    expect(body.message).toContain('24 hours');
    expect(body.message).toContain('quits');
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
    expect(listStartRequests()).toEqual([expect.objectContaining({
      requestId: body.requestId, projectPath: PROJECT, orchestratorId: 'orch', orchestratorName: 'Orch',
      args: { name: 'impl-api', task: 'Build the API', persona: 'qa', cli: 'codex-cli', model: 'm', access: 'auto', branchFrom: 'main', folder: 'api' },
    })]);
    // The desktop notice stays.
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.APP.AGENT_ATTENTION, 'orch', expect.anything());
  });

  it('checks the name, folder and branch before asking, with what the start would use', async () => {
    await ask({ name: 'impl-api', task: 'Build the API', folder: 'api', branchFrom: 'main' });
    expect(mockCheckDurableCreation).toHaveBeenCalledWith(PROJECT, expect.objectContaining({
      name: 'impl-api', parentAgentId: 'orch', disposable: true, folderName: 'api', branchFrom: 'main',
    }));
  });

  it('refuses the dispatcher persona before asking, and records no request (#2551)', async () => {
    mockCheckDurableCreation.mockImplementationOnce(realPersonaRule);
    const result = await callTool('orch', 'start_helper', { name: 'h', task: 't', persona: 'dispatcher' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('The Dispatcher persona is only for the Dispatcher.');
    expect(listStartRequests()).toEqual([]);
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  it('refuses at once a start that could never run, and records no request', async () => {
    mockCheckDurableCreation.mockRejectedValueOnce(new Error('Another agent already uses .clubhouse/agents/h1. Use another folder name such as "h1-2".'));
    const result = await callTool('orch', 'start_helper', { name: 'h1', task: 'Again' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not start helper "h1": Another agent already uses .clubhouse/agents/h1');
    expect(listStartRequests()).toEqual([]);
    expect(mockBroadcast).not.toHaveBeenCalledWith(IPC.APP.AGENT_ATTENTION, 'orch', expect.anything());
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  it('reuses the waiting request for the same start, and caps how many wait', async () => {
    const first = await ask();
    const again = parse(await callTool('orch', 'start_helper', { name: 'impl-api', task: 'Build the API' }));
    expect(again).toMatchObject({ requestId: first, reused: true });
    await ask({ name: 'b', task: 't' });
    await ask({ name: 'c', task: 't' });
    const over = await callTool('orch', 'start_helper', { name: 'd', task: 't' });
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toContain('3 helper starts waiting');
    expect(listStartRequests()).toHaveLength(3);
  });

  it('approve runs exactly one start, with the limit and access checks, and tells the orchestrator', async () => {
    const id = await ask({ name: 'impl-api', task: 'Build the API', access: 'standard' });
    const creation = controllableCreation();
    const result = await approveHelperStart(PROJECT, id);
    expect(result).toMatchObject({ ok: true, helperId: 'helper_impl-api' });
    expect(mockStartDurableCreation).toHaveBeenCalledTimes(1);
    expect(mockStartDurableCreation.mock.calls[0][1]).toMatchObject({ name: 'impl-api', parentAgentId: 'orch', freeAgentMode: false });
    expect(mockCheckLimit).toHaveBeenCalledWith(PROJECT, 'orch');
    expect(sent.get('orch')).toEqual([expect.stringContaining(`The user approved starting helper "impl-api" (request ${id}). It is being created as helper_impl-api with standard access.`)]);
    // The control level is not asked again: the approved start is not held a second time.
    expect(listStartRequests()).toEqual([]);

    creation.ready('helper_impl-api');
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent.mock.calls[0][0]).toMatchObject({ agentId: 'helper_impl-api', freeAgentMode: false });
  });

  it('an approved request cannot be approved again, even twice at once', async () => {
    const id = await ask();
    controllableCreation();
    const [a, b] = await Promise.all([approveHelperStart(PROJECT, id), approveHelperStart(PROJECT, id)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const again = await approveHelperStart(PROJECT, id);
    expect(again.ok).toBe(false);
    expect(mockStartDurableCreation).toHaveBeenCalledTimes(1);
  });

  it('an approved start still respects the helper limit', async () => {
    const id = await ask();
    mockCheckLimit.mockResolvedValue({ ok: false, reason: 'agent-limit', message: 'This agent already has 5 of 5 helpers.', helperCount: 5, totalHelperCount: 5, maxHelpers: 5, globalCap: 20 });
    const result = await approveHelperStart(PROJECT, id);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Couldn’t start impl-api because this agent already has 5 of 5 helpers.');
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
    expect(sent.get('orch')?.[0]).toContain('but it was not started because this agent already has 5 of 5 helpers.');
  });

  it('an approved start still applies the name and folder rules of the creation', async () => {
    const id = await ask({ name: 'bad name', task: 't' });
    mockStartDurableCreation.mockRejectedValue(new Error('Invalid folder name'));
    const result = await approveHelperStart(PROJECT, id);
    expect(result).toEqual({ ok: false, message: 'Couldn’t start bad name because invalid folder name' });
  });

  it('approve is refused once orchestration is off, and the request keeps waiting', async () => {
    const id = await ask();
    setOrchestrationEnabled('orch', false);
    const off = await approveHelperStart(PROJECT, id);
    expect(off).toEqual({ ok: false, message: 'Orchestration is off for Orch, so this start can\'t be approved.' });
    expect(listStartRequests().map((r) => r.requestId)).toEqual([id]);
    expect(sent.get('orch')).toBeUndefined();
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  it('approve while the orchestrator is asleep leaves the request waiting, and works once it runs again', async () => {
    const id = await ask();
    agentRegistry.untrack('orch');
    const asleep = await approveHelperStart(PROJECT, id);
    expect(asleep.ok).toBe(false);
    expect(asleep.message).toContain('Wake Orch to approve');
    expect(listStartRequests().map((r) => r.requestId)).toEqual([id]);
    expect(mockStartDurableCreation).not.toHaveBeenCalled();

    runAgent('orch', true);
    controllableCreation();
    expect(await approveHelperStart(PROJECT, id)).toMatchObject({ ok: true, helperId: 'helper_impl-api' });
    expect(listStartRequests()).toEqual([]);
  });

  it('approve refuses an orchestrator running in another project', async () => {
    const id = await ask();
    agentRegistry.untrack('orch');
    agentRegistry.register('orch', { projectPath: OTHER_PROJECT, orchestrator: 'claude-code', runtime: 'chat' });
    setOrchestrationEnabled('orch', true);
    expect((await approveHelperStart(PROJECT, id)).ok).toBe(false);
    expect(listStartRequests().map((r) => r.requestId)).toEqual([id]);
  });

  it('decline uses the request up and tells the orchestrator', async () => {
    const id = await ask();
    expect(await declineHelperStart(PROJECT, id)).toEqual({ ok: true, message: 'Declined' });
    expect(sent.get('orch')).toEqual([`[Clubhouse] The user declined your request to start helper "impl-api" (request ${id}). Nothing was created.`]);
    expect((await declineHelperStart(PROJECT, id)).ok).toBe(false);
    expect((await approveHelperStart(PROJECT, id)).ok).toBe(false);
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  it('refuses an unknown request and one from another project', async () => {
    expect((await approveHelperStart(PROJECT, 'hstart_nope')).ok).toBe(false);
    expect((await declineHelperStart(PROJECT, 'hstart_nope')).ok).toBe(false);
    const id = await ask();
    expect((await approveHelperStart(OTHER_PROJECT, id)).ok).toBe(false);
    expect((await declineHelperStart(OTHER_PROJECT, id)).ok).toBe(false);
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
    // Still waiting in its own project.
    expect(listStartRequests().map((r) => r.requestId)).toEqual([id]);
  });

  it('refuses an expired request', async () => {
    const id = await ask();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + START_REQUEST_TTL_MS + 1);
    try {
      expect((await approveHelperStart(PROJECT, id)).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(mockStartDurableCreation).not.toHaveBeenCalled();
  });

  describe('watching', () => {
    const send = vi.fn();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const changeConfig = () => { for (const l of configListeners) l(PROJECT); };

    beforeEach(() => {
      send.mockReset();
      watchHelperStartRequests(send);
    });

    it('sends added and closed requests to the main window', async () => {
      const id = await ask();
      expect(send).toHaveBeenCalledWith(IPC.AGENT.HELPER_START_REQUEST, expect.objectContaining({ requestId: id }));
      await declineHelperStart(PROJECT, id);
      expect(send).toHaveBeenCalledWith(IPC.AGENT.HELPER_START_REQUESTS_CLOSED, [id]);
    });

    it('drops an orchestrator\'s requests when orchestration is turned off', async () => {
      const id = await ask();
      mockGetPolicy.mockResolvedValue({ orchestrate: false, access: 'same', control: 'ask-before-start', maxHelpers: 5 });
      changeConfig();
      await flush();
      expect(listStartRequests()).toEqual([]);
      expect(send).toHaveBeenCalledWith(IPC.AGENT.HELPER_START_REQUESTS_CLOSED, [id]);
    });

    it('drops them when the orchestrator is disposed or deleted', async () => {
      await ask();
      agents.set('orch', { ...agents.get('orch')!, disposedAt: '2026-10-18T12:00:00.000Z' });
      changeConfig();
      await flush();
      expect(listStartRequests()).toEqual([]);

      agents.set('orch', { ...agents.get('orch')!, disposedAt: undefined });
      await ask({ name: 'b', task: 't' });
      agents.delete('orch');
      changeConfig();
      await flush();
      expect(listStartRequests()).toEqual([]);
    });

    it('keeps them when the gate closes because the orchestrator went to sleep', async () => {
      await ask();
      setOrchestrationEnabled('orch', false);
      await flush();
      expect(listStartRequests()).toHaveLength(1);

      mockGetPolicy.mockResolvedValue({ orchestrate: false, access: 'same', control: 'ask-before-start', maxHelpers: 5 });
      setOrchestrationEnabled('orch', true);
      setOrchestrationEnabled('orch', false);
      await flush();
      expect(listStartRequests()).toEqual([]);
    });
  });
});

// ── list_helpers ───────────────────────────────────────────────────────────

describe('list_helpers', () => {
  it('lists only the caller\'s direct children, with status and git state', async () => {
    addAgent({ id: 'other', name: 'Other' });
    runAgent('other', true);
    addAgent({ id: 'mine', name: 'Mine', parentAgentId: 'orch', branch: 'mine/standby', worktreePath: worktreeOf('mine') });
    addAgent({ id: 'theirs', name: 'Theirs', parentAgentId: 'other', worktreePath: worktreeOf('theirs') });
    addAgent({ id: 'grandchild', name: 'Grand', parentAgentId: 'mine' });
    addAgent({ id: 'making', name: 'Making', parentAgentId: 'orch', creation: { state: 'creating', startedAt: '2026-10-18T10:05:00.000Z' } });
    addAgent({ id: 'broken', name: 'Broken', parentAgentId: 'orch', creation: { state: 'failed', startedAt: '2026-10-18T10:05:00.000Z', reason: 'no space' } });
    running.add('mine');

    const body = parse(await callTool('orch', 'list_helpers', {}));
    const helpers = body.helpers as Array<Record<string, unknown>>;
    expect(helpers.map((h) => h.helperId).sort()).toEqual(['broken', 'making', 'mine']);
    expect(helpers.find((h) => h.helperId === 'mine')).toMatchObject({ status: 'idle', branch: 'x/standby', ahead: 2, behind: 1, dirty: 1 });
    expect(helpers.find((h) => h.helperId === 'making')).toMatchObject({ status: 'creating' });
    expect(helpers.find((h) => h.helperId === 'broken')).toMatchObject({ status: 'failed', reason: 'no space' });
    expect(mockGetGitInfo).toHaveBeenCalledTimes(1);
    expect(mockGetGitInfo).toHaveBeenCalledWith(worktreeOf('mine'));
  });

  it('shows a helper as starting until its spawn finishes', async () => {
    let release!: () => void;
    mockSpawnAgent.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const creation = controllableCreation();
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    expect(parse(await callTool('orch', 'list_helpers', {})).helpers).toEqual([expect.objectContaining({ status: 'creating' })]);
    creation.ready('helper_h');
    await vi.waitFor(() => expect(mockSpawnAgent).toHaveBeenCalled());
    expect(parse(await callTool('orch', 'list_helpers', {})).helpers).toEqual([expect.objectContaining({ status: 'starting' })]);
    release();
    await _settleHelperStartsForTesting();
  });
});

// ── sleep_helper / wake_helper ─────────────────────────────────────────────

describe('sleep_helper and wake_helper', () => {
  beforeEach(() => {
    addAgent({ id: 'other', name: 'Other' });
    runAgent('other', true);
    addAgent({ id: 'mine', name: 'Mine', parentAgentId: 'orch', worktreePath: worktreeOf('mine'), lastSessionId: 'sess-1', orchestrator: 'codex-cli' });
    addAgent({ id: 'theirs', name: 'Theirs', parentAgentId: 'other', worktreePath: worktreeOf('theirs') });
  });

  it('sleeps a running helper by id or name', async () => {
    running.add('mine');
    const result = await callTool('orch', 'sleep_helper', { helper: 'mine' });
    expect(parse(result)).toMatchObject({ helperId: 'mine', status: 'sleeping' });
    expect(mockKillAgent).toHaveBeenCalledWith('mine', PROJECT, 'codex-cli', 'agent_tool', { by: 'Orch', waitForExit: true });

    mockKillAgent.mockClear();
    running.add('mine');
    await callTool('orch', 'sleep_helper', { helper: 'MINE' });
    expect(mockKillAgent).toHaveBeenCalledTimes(1);
  });

  it('will not touch another orchestrator\'s helper', async () => {
    running.add('theirs');
    const sleep = await callTool('orch', 'sleep_helper', { helper: 'theirs' });
    expect(sleep.isError).toBe(true);
    expect(sleep.content[0].text).toContain('not one of your helpers');
    const wake = await callTool('orch', 'wake_helper', { helper: 'Theirs' });
    expect(wake.isError).toBe(true);
    expect(mockKillAgent).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('wakes a sleeping helper with the resolved launch settings, resuming its session', async () => {
    mockResolveLaunch.mockResolvedValue({ freeAgentMode: true, permissionMode: 'skip-all', level: 'bypass', ceiling: 'bypass', clamped: false });
    const result = await callTool('orch', 'wake_helper', { helper: 'mine', message: 'Rebase on main' });
    expect(parse(result)).toMatchObject({ helperId: 'mine', status: 'running', resumed: true });
    expect(mockResolveLaunch).toHaveBeenCalledWith(PROJECT, 'orch', { helperProvider: 'codex-cli' });
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'mine',
      cwd: worktreeOf('mine'),
      freeAgentMode: true,
      permissionMode: 'skip-all',
      resume: true,
      sessionId: 'sess-1',
      mission: expect.stringContaining('Rebase on main'),
    }));
  });

  it('spawns once for parallel wakes', async () => {
    let release!: () => void;
    mockSpawnAgent.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = callTool('orch', 'wake_helper', { helper: 'mine' });
    const second = callTool('orch', 'wake_helper', { helper: 'mine', message: 'hi' });
    await vi.waitFor(() => expect(mockSpawnAgent).toHaveBeenCalled());
    release();
    const results = (await Promise.all([first, second])).map(parse);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status).sort()).toEqual(['running', 'starting']);
    expect(results.find((r) => r.status === 'starting')).toMatchObject({ messageDelivered: false });
  });

  it('will not wake a helper that start_helper is still spawning', async () => {
    const creation = controllableCreation();
    let release!: () => void;
    mockSpawnAgent.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    await callTool('orch', 'start_helper', { name: 'h', task: 't' });
    creation.ready('helper_h');
    await vi.waitFor(() => expect(mockSpawnAgent).toHaveBeenCalled());
    expect(parse(await callTool('orch', 'wake_helper', { helper: 'h', message: 'x' }))).toMatchObject({ status: 'starting', messageDelivered: false });
    release();
    await _settleHelperStartsForTesting();
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it('delivers a pending task on wake and clears it', async () => {
    agents.set('mine', { ...agents.get('mine')!, pendingTask: 'Write the docs', lastSessionId: undefined });
    const listed = parse(await callTool('orch', 'list_helpers', {})).helpers as Array<Record<string, unknown>>;
    expect(listed.find((h) => h.helperId === 'mine')).toMatchObject({ status: 'sleeping', taskPending: true });

    const result = parse(await callTool('orch', 'wake_helper', { helper: 'mine', message: 'Also lint' }));
    expect(result).toMatchObject({ status: 'running', taskDelivered: true, resumed: false });
    const mission = mockSpawnAgent.mock.calls[0][0].mission as string;
    expect(mission).toContain('Write the docs');
    expect(mission).toContain('Also lint');
    expect(agents.get('mine')?.pendingTask).toBeUndefined();
  });

  it('delivers the message to a helper that is already running', async () => {
    running.add('mine');
    const result = await callTool('orch', 'wake_helper', { helper: 'mine', message: 'hello' });
    expect(parse(result)).toMatchObject({ status: 'already_running', messageDelivered: true });
    expect(sent.get('mine')?.[0]).toContain('hello');
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('returns from sleep only after the helper has exited, showing it stopping until then', async () => {
    running.add('mine');
    let stop!: ReturnType<typeof beginStop>;
    mockKillAgent.mockImplementation(async (id: string) => {
      stop = beginStop(id);
      await stop.exited;
    });
    const sleep = callTool('orch', 'sleep_helper', { helper: 'mine' });
    await vi.waitFor(() => expect(mockKillAgent).toHaveBeenCalled());

    const listed = parse(await callTool('orch', 'list_helpers', {})).helpers as Array<Record<string, unknown>>;
    expect(listed.find((h) => h.helperId === 'mine')).toMatchObject({ status: 'stopping' });
    let settled = false;
    void sleep.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    stop.exit();
    expect(parse(await sleep)).toMatchObject({ status: 'sleeping' });
    expect(mockBroadcast).toHaveBeenCalledWith(IPC.AGENT.AGENT_SLEEPING, 'mine');
    const after = parse(await callTool('orch', 'list_helpers', {})).helpers as Array<Record<string, unknown>>;
    expect(after.find((h) => h.helperId === 'mine')).toMatchObject({ status: 'sleeping' });
  });

  it('reports stopping, not sleeping, when the helper outlives the kill', async () => {
    running.add('mine');
    mockKillAgent.mockImplementation(async () => { /* the exit never came */ });
    expect(parse(await callTool('orch', 'sleep_helper', { helper: 'mine' }))).toMatchObject({ status: 'stopping' });
    expect(mockBroadcast).not.toHaveBeenCalledWith(IPC.AGENT.AGENT_SLEEPING, 'mine');
  });

  it('wakes for real after a sleep that is still exiting, delivering the message to the new session', async () => {
    running.add('mine');
    // The exit saves the session id the wake must resume.
    const stop = beginStop('mine', () => { agents.set('mine', { ...agents.get('mine')!, lastSessionId: 'sess-2' }); });
    const wake = callTool('orch', 'wake_helper', { helper: 'mine', message: 'welcome back' });
    await Promise.resolve();
    expect(sent.get('mine')).toBeUndefined();
    expect(mockSpawnAgent).not.toHaveBeenCalled();

    stop.exit();
    expect(parse(await wake)).toMatchObject({ status: 'running', resumed: true });
    expect(sent.get('mine')).toBeUndefined();
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'mine', resume: true, sessionId: 'sess-2', mission: expect.stringContaining('welcome back'),
    }));
  });

  it('never reports a delivery into a helper that is still exiting', async () => {
    running.add('mine');
    stopping.set('mine', { exited: Promise.resolve(), exit: () => {} }); // still alive after the wait
    const result = parse(await callTool('orch', 'wake_helper', { helper: 'mine', message: 'x' }));
    expect(result).toMatchObject({ status: 'stopping', messageDelivered: false });
    expect(sent.get('mine')).toBeUndefined();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('handles sleep then an immediate wake: the wake waits, then starts a session with the message', async () => {
    running.add('mine');
    let stop!: ReturnType<typeof beginStop>;
    mockKillAgent.mockImplementation(async (id: string) => {
      stop = beginStop(id);
      await stop.exited;
    });
    const sleep = callTool('orch', 'sleep_helper', { helper: 'mine' });
    await vi.waitFor(() => expect(mockKillAgent).toHaveBeenCalled());
    const wake = callTool('orch', 'wake_helper', { helper: 'mine', message: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.get('mine')).toBeUndefined();

    stop.exit();
    expect(parse(await sleep)).toMatchObject({ status: 'sleeping' });
    const woke = parse(await wake);
    expect(woke).toMatchObject({ status: 'running' });
    expect(woke).not.toHaveProperty('messageDelivered', true);
    expect(sent.get('mine')).toBeUndefined();
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    expect(mockSpawnAgent.mock.calls[0][0].mission).toContain('x');
    expect(running.has('mine')).toBe(true);
  });

  it('reports no delivery when the running helper\'s terminal refuses the message', async () => {
    running.add('mine');
    refusing.add('mine');
    const result = parse(await callTool('orch', 'wake_helper', { helper: 'mine', message: 'x' }));
    expect(result).toMatchObject({ status: 'stopping', messageDelivered: false });
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('reports a sleeping helper as already sleeping', async () => {
    expect(parse(await callTool('orch', 'sleep_helper', { helper: 'mine' }))).toMatchObject({ status: 'already_sleeping' });
    expect(mockKillAgent).not.toHaveBeenCalled();
  });
});

// ── message_parent ─────────────────────────────────────────────────────────

describe('message_parent', () => {
  it('delivers the text to the parent', async () => {
    addAgent({ id: 'mine', name: 'Mine', parentAgentId: 'orch' });
    runAgent('mine', false);
    const result = await callTool('mine', 'message_parent', { text: 'Done: PR #12' });
    expect(result.isError).toBeFalsy();
    expect(sent.get('orch')?.[0]).toContain('[FROM HELPER:Mine (mine)] Done: PR #12');
  });

  it('takes `message` as another name for `text` (#2366)', async () => {
    addAgent({ id: 'mine', name: 'Mine', parentAgentId: 'orch' });
    runAgent('mine', false);
    const result = await callTool('mine', 'message_parent', { message: 'PR opened' });
    expect(result.isError).toBeFalsy();
    expect(sent.get('orch')?.[0]).toContain('[FROM HELPER:Mine (mine)] PR opened');
  });

  it('names the right field when the message is missing (#2366)', async () => {
    addAgent({ id: 'mine', name: 'Mine', parentAgentId: 'orch' });
    runAgent('mine', false);
    const result = await callTool('mine', 'message_parent', { body: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Missing required argument: text (the message for your parent).');
  });

  it('is refused for an agent with no parent', async () => {
    addAgent({ id: 'plain' });
    runAgent('plain', false);
    const result = await callTool('plain', 'message_parent', { text: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no parent');
  });

  it('says a parent that is shutting down did not get the message', async () => {
    addAgent({ id: 'mine', name: 'Mine', parentAgentId: 'orch' });
    runAgent('mine', false);
    refusing.add('orch');
    const result = await callTool('mine', 'message_parent', { text: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Orch is shutting down, so the message was not delivered.');
  });

  it('reports a sleeping parent', async () => {
    addAgent({ id: 'mine', name: 'Mine', parentAgentId: 'orch' });
    runAgent('mine', false);
    running.delete('orch');
    const result = await callTool('mine', 'message_parent', { text: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('asleep');
  });
});

// ── Helpers in another project (#2515) ─────────────────────────────────────

describe('start_helper description', () => {
  it('says how to reach the wire from a CLI with a fixed tool list (#2603)', () => {
    const start = getScopedToolList('orch').find((t) => t.name === 'start_helper');
    expect(start?.description).toContain('If you have call_wire_tool');
  });
});

describe('helpers in another project', () => {
  /** A ready helper of orch whose row is in FAR. */
  function farHelper(extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
    where.set('far', FAR);
    return addAgent({
      id: 'far', name: 'Far', parentAgentId: 'orch', parentProjectPath: PROJECT, disposable: true,
      branch: 'far/standby', worktreePath: path.join(FAR, '.clubhouse', 'agents', 'far'), ...extra,
    });
  }

  describe('start_helper with project', () => {
    it('refuses the dispatcher persona in the target project, with nothing created (#2551)', async () => {
      mockStartDurableCreation.mockImplementationOnce(realPersonaRule);
      const result = await callTool('orch', 'start_helper', { name: 'api', task: 't', project: 'Far Away', persona: 'dispatcher' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Could not start helper "api": The Dispatcher persona is only for the Dispatcher.');
      expect(mockStartDurableCreation.mock.calls[0][0]).toBe(FAR);
      expect(mockApplyPersona).not.toHaveBeenCalled();
    });

    it('creates and spawns the helper in the target project, with limits and launch from home', async () => {
      const creation = controllableCreation();
      const body = parse(await callTool('orch', 'start_helper', { name: 'api', task: 'Build it', project: 'Far Away', persona: 'workhorse' }));
      expect(body).toMatchObject({ state: 'starting', helperId: 'helper_api', project: 'Far Away', projectPath: FAR });
      expect(body.message).toContain('in Far Away');

      expect(mockCrossAllowed).toHaveBeenCalledWith(PROJECT, 'orch');
      expect(mockCheckLimit).toHaveBeenCalledWith(PROJECT, 'orch');
      const [createdIn, params, options] = mockStartDurableCreation.mock.calls[0];
      expect(createdIn).toBe(FAR);
      expect(params).toMatchObject({ name: 'api', parentAgentId: 'orch', parentProjectPath: PROJECT, persona: 'workhorse' });
      expect(mockPersonaInjection).toHaveBeenCalledWith(FAR, params);
      expect(options).toBe(mockPersonaInjection.mock.results[0].value);

      creation.ready('helper_api');
      await _settleHelperStartsForTesting();
      expect(mockResolveLaunch).toHaveBeenCalledWith(PROJECT, 'orch', expect.anything());
      expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'helper_api', projectPath: FAR, cwd: path.join(FAR, '.clubhouse', 'agents', 'api'),
      }));
      expect(sent.get('orch')?.[0]).toContain('is ready');
    });

    it('takes the project by path, and treats the home project as same-project', async () => {
      controllableCreation();
      await callTool('orch', 'start_helper', { name: 'a', task: 't', project: FAR });
      expect(mockStartDurableCreation.mock.calls[0][0]).toBe(FAR);

      await callTool('orch', 'start_helper', { name: 'b', task: 't', project: 'home' });
      const [createdIn, params] = mockStartDurableCreation.mock.calls[1];
      expect(createdIn).toBe(PROJECT);
      expect(params.parentProjectPath).toBeUndefined();
      expect(mockCrossAllowed).toHaveBeenCalledTimes(1);
    });

    it('is refused while cross-project helpers are off', async () => {
      mockCrossAllowed.mockResolvedValue(false);
      const result = await callTool('orch', 'start_helper', { name: 'a', task: 't', project: 'far' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Cross-project helpers are turned off for this agent.');
      expect(mockStartDurableCreation).not.toHaveBeenCalled();
    });

    it('is refused for an unknown project, a non-git target and the same repository', async () => {
      const unknown = await callTool('orch', 'start_helper', { name: 'a', task: 't', project: 'nowhere' });
      expect(unknown.content[0].text).toContain('"nowhere" is not a project in Clubhouse');

      gitDirs.set(FAR, null);
      const notGit = await callTool('orch', 'start_helper', { name: 'a', task: 't', project: 'far' });
      expect(notGit.content[0].text).toContain('Far Away is not a git repository');

      gitDirs.set(FAR, path.join(PROJECT, '.git'));
      const sameRepo = await callTool('orch', 'start_helper', { name: 'a', task: 't', project: 'far' });
      expect(sameRepo.content[0].text).toContain('same git repository');

      for (const r of [unknown, notGit, sameRepo]) expect(r.isError).toBe(true);
      expect(mockStartDurableCreation).not.toHaveBeenCalled();
    });

    it('passes an unknown persona to the creation, which refuses it', async () => {
      mockStartDurableCreation.mockRejectedValueOnce(new Error('Unknown persona "nope".'));
      const result = await callTool('orch', 'start_helper', { name: 'a', task: 't', project: 'far', persona: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Could not start helper "a": Unknown persona "nope".');
      expect(mockStartDurableCreation.mock.calls[0][0]).toBe(FAR);
    });
  });

  describe('approvals', () => {
    beforeEach(() => {
      mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'ask-before-start', maxHelpers: 5 });
    });

    it('holds the start by the target\'s path, checked in the target, and starts it there on approval', async () => {
      const body = parse(await callTool('orch', 'start_helper', { name: 'api', task: 't', project: 'Far Away' }));
      expect(body.state).toBe('needs_approval');
      expect(mockCheckDurableCreation).toHaveBeenCalledWith(FAR, expect.objectContaining({ parentProjectPath: PROJECT }));
      const [request] = listStartRequests();
      expect(request).toMatchObject({ projectPath: PROJECT, args: { name: 'api', task: 't', project: FAR } });

      controllableCreation();
      expect(await approveHelperStart(PROJECT, request.requestId)).toMatchObject({ ok: true, helperId: 'helper_api' });
      expect(mockStartDurableCreation.mock.calls[0][0]).toBe(FAR);
    });

    it('re-checks the target on approval and leaves the request waiting when it is refused', async () => {
      const { requestId } = parse(await callTool('orch', 'start_helper', { name: 'api', task: 't', project: 'far' })) as { requestId: string };
      mockCrossAllowed.mockResolvedValue(false);
      const off = await approveHelperStart(PROJECT, requestId);
      expect(off.ok).toBe(false);
      expect(off.message).toContain('cross-project helpers are turned off');

      mockCrossAllowed.mockResolvedValue(true);
      projects.splice(1, 1);
      const removed = await approveHelperStart(PROJECT, requestId);
      expect(removed.ok).toBe(false);
      expect(removed.message).toContain('is not a project in Clubhouse');
      expect(listStartRequests().map((r) => r.requestId)).toEqual([requestId]);
      expect(mockStartDurableCreation).not.toHaveBeenCalled();
    });
  });

  it('lists helpers in every project with their project and worktree', async () => {
    farHelper();
    addAgent({ id: 'near', name: 'Near', parentAgentId: 'orch', worktreePath: worktreeOf('near') });
    const helpers = parse(await callTool('orch', 'list_helpers', {})).helpers as Array<Record<string, unknown>>;
    expect(helpers).toEqual(expect.arrayContaining([
      expect.objectContaining({ helperId: 'far', project: 'Far Away', worktreePath: path.join(FAR, '.clubhouse', 'agents', 'far') }),
      expect.objectContaining({ helperId: 'near', project: 'home', worktreePath: worktreeOf('near') }),
    ]));
  });

  it('sleeps and wakes a helper in its own project, with the access from home', async () => {
    farHelper({ lastSessionId: 'sess-far', pendingTask: 'Do it' });
    running.add('far');
    await callTool('orch', 'sleep_helper', { helper: 'Far' });
    expect(mockKillAgent).toHaveBeenCalledWith('far', FAR, 'claude-code', 'agent_tool', { by: 'Orch', waitForExit: true });

    const woke = parse(await callTool('orch', 'wake_helper', { helper: 'far', message: 'go' }));
    expect(woke).toMatchObject({ status: 'running', resumed: true, taskDelivered: true });
    expect(mockResolveLaunch).toHaveBeenCalledWith(PROJECT, 'orch', expect.anything());
    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'far', projectPath: FAR, cwd: path.join(FAR, '.clubhouse', 'agents', 'far') }));
    expect(agents.get('far')?.pendingTask).toBeUndefined();
  });

  it('a helper in another project reaches its parent with message_parent', async () => {
    farHelper();
    agentRegistry.register('far', { projectPath: FAR, orchestrator: 'claude-code', runtime: 'chat' });
    const result = await callTool('far', 'message_parent', { text: 'done' });
    expect(result.isError).toBeFalsy();
    expect(sent.get('orch')?.[0]).toContain('[FROM HELPER:Far (far)] done');
  });

  describe('list_projects', () => {
    it('is listed and callable only with the cross-project gate open', async () => {
      expect(getScopedToolList('orch').map((t) => t.name)).not.toContain('list_projects');
      const refused = await callTool('orch', 'list_projects', {});
      expect(refused.isError).toBe(true);

      setOrchestrationEnabled('orch', true, { crossProject: true });
      expect(getScopedToolList('orch').map((t) => t.name)).toContain('list_projects');
    });

    it('lists each project with its default branch and personas, and marks the caller\'s', async () => {
      setOrchestrationEnabled('orch', true, { crossProject: true });
      const same = path.join(path.sep, 'tmp', 'project-wt');
      const plain = path.join(path.sep, 'tmp', 'plain-folder');
      projects.push({ id: 'proj_wt', name: 'wt', path: same }, { id: 'proj_plain', name: 'plain', path: plain });
      gitDirs.set(same, path.join(PROJECT, '.git'));
      gitDirs.set(plain, null);
      mockListPersonas.mockImplementation(async (p: string) =>
        (p === FAR ? [{ id: 'far-only', name: 'Far only', source: 'project' }, { id: 'workhorse', name: 'Workhorse', source: 'builtin' }] : []));

      const body = parse(await callTool('orch', 'list_projects', {}));
      expect(body.projects).toEqual([
        { name: 'home', path: PROJECT, defaultBranch: 'main', personas: [], yours: true },
        { name: 'Far Away', path: FAR, defaultBranch: 'main', personas: ['far-only', 'workhorse'] },
        { name: 'wt', path: same, defaultBranch: 'main', personas: [], sameRepository: true },
        { name: 'plain', path: plain, defaultBranch: null, personas: [], notGit: true },
      ]);
    });
  });
});
