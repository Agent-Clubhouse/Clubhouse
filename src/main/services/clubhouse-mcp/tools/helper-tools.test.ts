import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';
import { IPC } from '../../../../shared/ipc-channels';

// ── Mocks: no CLI, git or disk is touched ──────────────────────────────────

const agents = new Map<string, DurableAgentConfig>();

vi.mock('../../agent-config', () => ({
  getDurableConfig: vi.fn(async (_projectPath: string, id: string) => agents.get(id) ?? null),
  listHelpers: vi.fn(async (_projectPath: string, id: string) =>
    [...agents.values()].filter((a) => a.parentAgentId === id && !a.disposedAt)),
}));

const mockStartDurableCreation = vi.fn();
vi.mock('../../agent-creation', () => ({
  startDurableCreation: (...args: unknown[]) => mockStartDurableCreation(...args),
}));

const running = new Set<string>();
const mockSpawnAgent = vi.fn();
const mockKillAgent = vi.fn();
vi.mock('../../agent-system', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  killAgent: (...args: unknown[]) => mockKillAgent(...args),
  isAgentRunning: (id: string) => running.has(id),
}));

const sent = new Map<string, string[]>();
vi.mock('../../agent-runtime', () => ({
  getAgentRuntime: (id: string) => (running.has(id)
    ? {
      kind: 'chat',
      agentId: id,
      isRunning: () => true,
      getState: () => 'idle',
      sendMessage: async (text: string) => {
        sent.set(id, [...(sent.get(id) ?? []), text]);
        return { delivered: true };
      },
    }
    : undefined),
}));

const mockGetGitInfo = vi.fn();
vi.mock('../../git-service', () => ({ getGitInfo: (...args: unknown[]) => mockGetGitInfo(...args) }));

const mockApplyPersona = vi.fn();
vi.mock('../../persona-application', () => ({ applyPersonaToAgent: (...args: unknown[]) => mockApplyPersona(...args) }));

const mockCheckLimit = vi.fn();
const mockGetPolicy = vi.fn();
const mockResolveLaunch = vi.fn();
vi.mock('../../orchestration-policy', () => ({
  checkHelperLimitFor: (...args: unknown[]) => mockCheckLimit(...args),
  getOrchestrationPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  resolveHelperLaunchSettings: (...args: unknown[]) => mockResolveLaunch(...args),
}));

vi.mock('../../../orchestrators', () => ({
  getProvider: (id: string) => (['claude-code', 'codex-cli', 'copilot-cli'].includes(id) ? { id } : undefined),
  getAllProviders: () => [{ id: 'claude-code' }, { id: 'codex-cli' }, { id: 'copilot-cli' }],
}));

const mockBroadcast = vi.fn();
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { registerHelperTools, _resetHelperToolsForTesting, _settleHelperStartsForTesting } from './helper-tools';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from '../orchestration-gate';

// ── Fixtures ───────────────────────────────────────────────────────────────

const PROJECT = path.join(path.sep, 'tmp', 'project');
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
  mockStartDurableCreation.mockImplementation(async (_projectPath: string, params: { name: string; folderName?: string; parentAgentId: string }) => {
    const folder = params.folderName ?? params.name;
    const config = addAgent({
      id: `helper_${params.name}`,
      name: params.name,
      parentAgentId: params.parentAgentId,
      disposable: true,
      branch: `${folder}/standby`,
      worktreePath: worktreeOf(folder),
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

beforeEach(() => {
  vi.clearAllMocks();
  agents.clear();
  running.clear();
  sent.clear();
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  _resetOrchestrationGateForTesting();
  _resetHelperToolsForTesting();
  registerHelperTools();

  mockCheckLimit.mockResolvedValue({ ok: true, helperCount: 0, totalHelperCount: 0, maxHelpers: 5, globalCap: 20 });
  mockGetPolicy.mockResolvedValue({ orchestrate: true, access: 'same', control: 'hands-off', maxHelpers: 5 });
  mockResolveLaunch.mockResolvedValue({ freeAgentMode: true, permissionMode: 'auto', level: 'auto', ceiling: 'auto', clamped: false });
  mockSpawnAgent.mockImplementation(async (params: { agentId: string }) => { running.add(params.agentId); });
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
    await options.inject(agents.get('helper_h'));
    expect(mockApplyPersona).toHaveBeenCalledWith(PROJECT, 'helper_h', 'workhorse', { appendToExisting: true });
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
    expect(mockKillAgent).toHaveBeenCalledWith('mine', PROJECT, 'codex-cli', 'agent_tool', { by: 'Orch' });

    mockKillAgent.mockClear();
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

  it('delivers the message to a helper that is already running', async () => {
    running.add('mine');
    const result = await callTool('orch', 'wake_helper', { helper: 'mine', message: 'hello' });
    expect(parse(result)).toMatchObject({ status: 'already_running', messageDelivered: true });
    expect(sent.get('mine')?.[0]).toContain('hello');
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

  it('is refused for an agent with no parent', async () => {
    addAgent({ id: 'plain' });
    runAgent('plain', false);
    const result = await callTool('plain', 'message_parent', { text: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no parent');
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
