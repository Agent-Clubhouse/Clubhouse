import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';

vi.mock('./agent-config', () => ({
  updateDurableConfig: vi.fn(async () => undefined),
  updateDurable: vi.fn(async () => undefined),
  getDurableConfig: vi.fn(async () => null),
}));
vi.mock('./agent-creation', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-creation')>(),
  startDurableCreation: vi.fn(),
}));
const getModelOptions = vi.hoisted(() => vi.fn(async (id?: string, _opts?: unknown) => (id === 'codex-cli' ? [] : [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }])));
vi.mock('./agent-system', () => ({
  getAvailableOrchestrators: vi.fn(),
  checkAvailability: vi.fn(async () => ({ available: true })),
  resolveOrchestrator: vi.fn(async (_path: string, id?: string) => ({
    id: id ?? 'claude-code',
    getModelOptions: (opts?: unknown) => getModelOptions(id, opts),
  })),
  resolveProfileEnv: vi.fn(async () => undefined),
}));
vi.mock('./dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: vi.fn(() => false) }));
vi.mock('./mcp-settings', () => ({ isMcpEnabled: vi.fn((_projectPath?: string, agentOverride?: boolean) => agentOverride ?? true) }));
vi.mock('./agent-settings-service', () => ({
  readProjectAgentDefaults: vi.fn(async () => ({})),
  readMcpCatalog: vi.fn(async () => [{ id: 'ado', name: 'Azure DevOps', description: 'Work items', args: [{ name: 'org' }] }]),
  readDefaultMcps: vi.fn(async () => ['ado']),
}));
vi.mock('./materialization-service', () => ({
  listAvailablePersonas: vi.fn(async () => [{ id: 'qa', name: 'QA', source: 'builtin' }]),
}));
vi.mock('./orchestrator-settings', () => ({ getSettings: vi.fn(() => ({ enabled: ['claude-code', 'codex-cli'] })) }));
vi.mock('./profile-settings', () => ({ getProfile: vi.fn() }));
vi.mock('./clubhouse-mode-settings', () => ({ isClubhouseModeEnabled: vi.fn(() => false) }));
vi.mock('./chat-idle-settings', () => ({ chatIdleSettings: { getSettings: () => ({ idleTimeoutMinutes: 30 }) } }));
vi.mock('./chat-runtime-settings', () => ({
  isChatEnabled: vi.fn(() => true),
  resolveRuntimeMode: vi.fn((_provider: string, override?: string) => ({ mode: override ?? 'chat' })),
}));
vi.mock('./agent-runtime/chat-drivers', () => ({ resolveChatDriver: vi.fn((provider: string) => (provider === 'claude-code' ? {} : undefined)) }));
vi.mock('./agent-runtime', () => ({ isChatAgent: vi.fn(() => false) }));
vi.mock('./git-service', () => ({ isInsideGitRepo: vi.fn(async () => true), getBranchChanges: vi.fn() }));
vi.mock('./persona-application', () => ({ applyPersonaToAgent: vi.fn(async () => undefined) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./orchestration-settings', () => ({ getGlobalHelperCap: vi.fn(() => 8) }));
vi.mock('./orchestration-policy', async () => {
  const shared = await import('../../shared/orchestration-policy');
  return {
    resolveOrchestrationPolicies: vi.fn(async (_path: string, agents: DurableAgentConfig[]) =>
      new Map(agents.map((a) => [a.id, shared.resolveOrchestrationPolicy(a.orchestration, { maxHelpers: 3 }, { mcpOff: a.mcpOverride === false })]))),
    setOrchestrationPolicy: vi.fn(async () => ({ ok: true, message: 'Saved' })),
  };
});

import * as agentConfig from './agent-config';
import { startDurableCreation } from './agent-creation';
import { checkAvailability, getAvailableOrchestrators, resolveProfileEnv } from './agent-system';
import { isDispatcherEnabled } from './dispatcher/dispatcher-settings';
import { isMcpEnabled } from './mcp-settings';
import { readProjectAgentDefaults } from './agent-settings-service';
import { getProfile } from './profile-settings';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { isChatEnabled } from './chat-runtime-settings';
import { isChatAgent } from './agent-runtime';
import { getBranchChanges, isInsideGitRepo } from './git-service';
import { applyPersonaToAgent } from './persona-application';
import { MobileControlError } from './mobile-control';
import { setOrchestrationPolicy } from './orchestration-policy';
import * as orchestrationSettings from './orchestration-settings';
import { buildAgentDetails, buildAgentSettings, buildAgentSettingsOptions, buildCreateOptions, createMobileAgent, maxHelpersCap, updateMobileAgent, updateMobileDispatcher } from './mobile-agents';

const project = { id: 'p1', path: '/work/app' };
const orchestrator = (id: string, permissions = true) => ({ id, displayName: id, shortName: id.slice(0, 2), capabilities: { permissions } });
const agent = (extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig =>
  ({ id: 'durable_1', name: 'brave-otter', color: 'indigo', createdAt: '2026-01-01', worktreePath: '/work/app/.clubhouse/agents/brave-otter', ...extra });
const allow = () => {};
async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (e) { return e as MobileControlError; }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAvailableOrchestrators).mockReturnValue([orchestrator('claude-code'), orchestrator('codex-cli', false), orchestrator('copilot-cli')] as never);
  vi.mocked(startDurableCreation).mockImplementation(async (_path, params) => ({
    agentId: 'durable_new',
    config: { id: 'durable_new', name: params.name, color: params.color, createdAt: 'now', branch: `${params.name}/standby`, worktreePath: `/work/app/.clubhouse/agents/${params.name}`, creation: { state: 'creating', startedAt: 'now' } },
    done: Promise.resolve('ready'),
  }) as never);
});

describe('create options', () => {
  it('lists the enabled orchestrators with availability, permissions, chat and models', async () => {
    vi.mocked(checkAvailability).mockImplementation(async (_p, id) => (id === 'codex-cli' ? { available: false, error: 'Codex not found' } : { available: true }));
    const options = await buildCreateOptions(project);
    expect(options.orchestrators).toEqual([
      { id: 'claude-code', displayName: 'claude-code', shortName: 'cl', available: true, permissions: true, chat: true, models: [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }] },
      { id: 'codex-cli', displayName: 'codex-cli', shortName: 'co', available: false, unavailableReason: 'Codex not found', permissions: false, chat: false, models: [{ id: 'default', label: 'Default' }] },
    ]);
    expect(options).toMatchObject({
      projectId: 'p1', personas: [{ id: 'qa', name: 'QA', source: 'builtin' }], isGitRepo: true,
      mcp: { catalog: [{ id: 'ado', name: 'Azure DevOps', description: 'Work items' }], defaults: ['ado'] },
      defaults: { orchestrator: 'claude-code', color: 'indigo', model: 'default', useWorktree: true },
      freeAgentMode: { allowed: true },
    });
    expect(options.colors).toContainEqual({ id: 'rose', label: 'Rose', hex: '#f43f5e' });
    expect(options.suggestedName).toMatch(/^[a-z]+-[a-z]+$/);
  });
  it('narrows orchestrators to the project profile, unless it covers none', async () => {
    vi.mocked(readProjectAgentDefaults).mockResolvedValue({ profileId: 'work' } as never);
    vi.mocked(getProfile).mockReturnValue({ id: 'work', name: 'Work', orchestrators: { 'codex-cli': { env: {} } } });
    expect((await buildCreateOptions(project)).orchestrators.map((o) => o.id)).toEqual(['codex-cli']);
    vi.mocked(getProfile).mockReturnValue({ id: 'work', name: 'Work', orchestrators: { gemini: { env: {} } } });
    expect((await buildCreateOptions(project)).orchestrators.map((o) => o.id)).toEqual(['claude-code', 'codex-cli']);
  });
  it('offers no worktree outside a git repo', async () => {
    vi.mocked(isInsideGitRepo).mockResolvedValueOnce(false);
    expect(await buildCreateOptions(project)).toMatchObject({ isGitRepo: false, defaults: { useWorktree: false } });
  });
});

describe('agent.create', () => {
  const create = (extra = {}) => ({ projectId: 'p1', name: 'brave-otter', color: 'indigo', ...extra });

  it('starts a durable creation with the New agent page defaults and returns the receipt', async () => {
    const result = await createMobileAgent(project, create(), allow);
    expect(startDurableCreation).toHaveBeenCalledWith('/work/app', expect.objectContaining({ name: 'brave-otter', color: 'indigo', useWorktree: true, orchestrator: 'claude-code' }), { inject: undefined });
    const params = vi.mocked(startDurableCreation).mock.calls[0][1];
    expect(params.freeAgentMode).toBeUndefined();
    expect(params.model).toBeUndefined();
    expect(result).toEqual({ agentId: 'durable_new', projectId: 'p1', name: 'brave-otter', branch: 'brave-otter/standby', worktreePath: '/work/app/.clubhouse/agents/brave-otter', state: 'creating' });
  });
  it('injects the persona into the new worktree', async () => {
    await createMobileAgent(project, create({ persona: 'qa', model: 'opus', mcpIds: ['ado'], branchName: 'feat/otter', branchFrom: 'main' }), allow);
    const [, params, options] = vi.mocked(startDurableCreation).mock.calls[0];
    expect(params).toMatchObject({ persona: 'qa', model: 'opus', mcpIds: ['ado'], branchName: 'feat/otter', branchFrom: 'main' });
    await options!.inject!({ id: 'durable_new', worktreePath: '/wt' } as DurableAgentConfig);
    expect(applyPersonaToAgent).toHaveBeenCalledWith('/work/app', 'durable_new', 'qa', { appendToExisting: true });
  });
  it('refuses a name that cannot be a folder and branch, with the reason', async () => {
    const err = await refusal(createMobileAgent(project, create({ name: 'my agent' }), allow));
    expect(err).toMatchObject({ code: 'invalid_name', statusCode: 400 });
    expect(err.detail).toBeTruthy();
    expect((await refusal(createMobileAgent(project, create({ branchName: 'bad..branch' }), allow))).code).toBe('invalid_branch_name');
    expect((await refusal(createMobileAgent(project, create({ folderName: 'a/b' }), allow))).code).toBe('invalid_folder_name');
    // Without a worktree the name is only a label.
    await createMobileAgent(project, create({ name: 'My Agent', useWorktree: false }), allow);
    expect(startDurableCreation).toHaveBeenCalledTimes(1);
  });
  it('refuses options the desktop would not offer', async () => {
    expect((await refusal(createMobileAgent(project, create({ color: '#ff0000' }), allow))).code).toBe('invalid_color');
    expect((await refusal(createMobileAgent(project, create({ orchestrator: 'gemini' }), allow))).code).toBe('orchestrator_unavailable');
    expect((await refusal(createMobileAgent(project, create({ persona: 'pirate' }), allow))).code).toBe('unknown_persona');
    // The hidden dispatcher persona is never listed (#2551); agentConfig refuses it as well.
    expect((await refusal(createMobileAgent(project, create({ persona: 'dispatcher' }), allow))).code).toBe('unknown_persona');
    expect((await refusal(createMobileAgent(project, create({ mcpIds: ['kusto'] }), allow))).code).toBe('unknown_mcp');
    expect((await refusal(createMobileAgent(project, create({ useWorktree: false, branchName: 'x' }), allow))).code).toBe('worktree_options_require_worktree');
    vi.mocked(isInsideGitRepo).mockResolvedValueOnce(false);
    expect((await refusal(createMobileAgent(project, create({ useWorktree: true }), allow))).code).toBe('not_git_repo');
    expect(startDurableCreation).not.toHaveBeenCalled();
  });
  it('reports a refusal from agent-config, and rechecks authorization first', async () => {
    vi.mocked(startDurableCreation).mockRejectedValueOnce(new Error('A branch named brave-otter/standby already exists'));
    expect(await refusal(createMobileAgent(project, create(), allow))).toMatchObject({ code: 'create_refused', detail: 'A branch named brave-otter/standby already exists' });
    const revoked = () => { throw new MobileControlError('authorization_revoked', 403); };
    expect((await refusal(createMobileAgent(project, create(), revoked))).code).toBe('authorization_revoked');
    expect(startDurableCreation).toHaveBeenCalledTimes(1);
  });
});

describe('Free Agent Mode from a phone (#2462)', () => {
  const create = (extra = {}) => ({ projectId: 'p1', name: 'brave-otter', color: 'indigo', ...extra });
  const live = { live: undefined, assertAuthorized: allow };

  it('creates a free agent on a CLI with permission support', async () => {
    await createMobileAgent(project, create({ freeAgentMode: true }), allow);
    expect(vi.mocked(startDurableCreation).mock.calls[0][1].freeAgentMode).toBe(true);
  });
  it('refuses it on a CLI that sets access itself, as the New agent page does', async () => {
    expect(await refusal(createMobileAgent(project, create({ orchestrator: 'codex-cli', freeAgentMode: true }), allow))).toMatchObject({ code: 'free_agent_mode_unavailable', statusCode: 409 });
    expect(startDurableCreation).not.toHaveBeenCalled();
    await createMobileAgent(project, create({ orchestrator: 'codex-cli', freeAgentMode: false }), allow);
  });
  it('turns it on and off while the agent sleeps', async () => {
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', freeAgentMode: true }, live);
    await updateMobileAgent(project, agent({ freeAgentMode: true }), { agentId: 'durable_1', freeAgentMode: false }, live);
    expect(vi.mocked(agentConfig.updateDurableConfig).mock.calls.map((c) => c[2])).toEqual([{ freeAgentMode: true }, { freeAgentMode: false }]);
  });
  it('is a spawn setting: refused while the agent runs, and on a CLI without permission support', async () => {
    expect((await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', freeAgentMode: true }, { live: 'running', assertAuthorized: allow }))).code).toBe('agent_running');
    expect((await refusal(updateMobileAgent(project, agent({ orchestrator: 'codex-cli' }), { agentId: 'durable_1', freeAgentMode: true }, live))).code).toBe('free_agent_mode_unavailable');
    await updateMobileAgent(project, agent({ orchestrator: 'codex-cli', freeAgentMode: true }), { agentId: 'durable_1', freeAgentMode: false }, live);
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledTimes(1);
  });
  it('reads as never editable on a CLI without permission support', async () => {
    expect((await buildAgentSettings(project, agent({ orchestrator: 'codex-cli' }), undefined)).settings.freeAgentMode).toEqual({ value: false, editable: 'never' });
  });
});

describe('agent settings', () => {
  it('reads each setting with when it can change', async () => {
    const result = await buildAgentSettings(project, agent({ idleSleep: 60, persona: 'qa', model: 'opus', freeAgentMode: true }), undefined);
    expect(result).toEqual({
      agentId: 'durable_1', projectId: 'p1', state: 'sleeping', sleeping: true,
      settings: {
        name: { value: 'brave-otter', editable: 'sleeping' },
        color: { value: 'indigo', editable: 'sleeping' },
        emoji: { value: null, editable: 'sleeping' },
        hasImageIcon: false,
        orchestrator: { value: null, editable: 'sleeping', resolved: 'claude-code', changeStartsNewSession: false },
        model: { value: 'opus', editable: 'sleeping' },
        runtime: { value: 'default', editable: 'sleeping', resolved: 'chat' },
        persona: { value: 'qa', editable: 'sleeping' },
        clubhouseMode: { value: null, editable: 'never', projectEnabled: false },
        freeAgentMode: { value: true, editable: 'sleeping' },
        idleSleep: { value: 60, editable: 'always', minutes: 60, source: 'agent', applies: true },
      },
      orchestration: {
        orchestrate: false, access: 'same', control: 'hands-off', maxHelpers: 3, crossProjectHelpers: false, connectToDispatcher: false, mcpEnabled: true,
        sources: { orchestrate: 'default', access: 'default', control: 'default', maxHelpers: 'persona', crossProjectHelpers: 'default', connectToDispatcher: 'default' },
        maxHelpersCap: 8, controls: ['hands-off', 'ask-before-start', 'ask-everything'], accessLevels: ['same', 'standard', 'auto', 'bypass'],
      },
    });
  });
  it('resolves inherited auto-sleep from the app setting, and runtime from the live agent', async () => {
    vi.mocked(isClubhouseModeEnabled).mockReturnValue(true);
    const result = await buildAgentSettings(project, agent({ orchestrator: 'codex-cli', clubhouseModeOverride: true }), 'running');
    expect(result).toMatchObject({ state: 'running', sleeping: false });
    expect(result.settings).toMatchObject({
      runtime: { value: 'default', editable: 'never', resolved: 'terminal' },
      clubhouseMode: { value: false, editable: 'sleeping', projectEnabled: true },
      idleSleep: { value: 'inherit', minutes: 30, source: 'app', applies: false },
    });
    vi.mocked(isChatAgent).mockReturnValueOnce(true);
    expect((await buildAgentSettings(project, agent(), 'running')).settings.runtime.resolved).toBe('chat');
    vi.mocked(isClubhouseModeEnabled).mockReturnValue(false);
  });
  it('reports creating and failed agents', async () => {
    expect(await buildAgentSettings(project, agent({ creation: { state: 'creating', startedAt: 'now' } }), undefined)).toMatchObject({ state: 'creating', sleeping: false });
    expect(await buildAgentSettings(project, agent({ creation: { state: 'failed', startedAt: 'now' } }), undefined)).toMatchObject({ state: 'failed', sleeping: true });
  });
  it('offers the auto-sleep choices and the app timeout with the create options', async () => {
    const options = await buildAgentSettingsOptions('/work/app');
    expect(options.idleSleep).toEqual({ minutes: [15, 30, 60, 240], appMinutes: 30 });
    expect(options.orchestrators.map((o) => o.id)).toEqual(['claude-code', 'codex-cli']);
  });
});

describe('agent details', () => {
  it('sends the branch, worktree, MCP servers and a count-only summary of the branch changes', async () => {
    vi.mocked(getBranchChanges).mockResolvedValueOnce({
      available: true, branch: 'brave-otter/standby', base: 'main', ahead: 2, uncommitted: 1,
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 4 },
        { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
      ],
    });
    const result = await buildAgentDetails(project, agent({ branch: 'brave-otter/standby', mcpIds: ['github', 'linear'] }));
    expect(getBranchChanges).toHaveBeenCalledWith('/work/app/.clubhouse/agents/brave-otter', undefined, true);
    expect(result).toEqual({
      branch: 'brave-otter/standby',
      worktreePath: '/work/app/.clubhouse/agents/brave-otter',
      worktree: '.clubhouse/agents/brave-otter',
      mcpIds: ['github', 'linear'],
      changes: { available: true, base: 'main', noBase: false, files: 2, additions: 15, deletions: 4, ahead: 2, uncommitted: 1 },
    });
  });
  it('reads the project folder without a worktree, and keeps a worktree outside the project whole', async () => {
    vi.mocked(getBranchChanges).mockResolvedValueOnce({ available: false, files: [] });
    const plain = await buildAgentDetails(project, agent({ worktreePath: undefined }));
    expect(getBranchChanges).toHaveBeenCalledWith('/work/app', undefined, true);
    expect(plain).toMatchObject({ branch: null, worktreePath: null, worktree: null, mcpIds: [],
      changes: { available: false, base: null, files: 0, ahead: null, uncommitted: null } });
    vi.mocked(getBranchChanges).mockResolvedValueOnce({ available: true, noBase: true, files: [] });
    const elsewhere = await buildAgentDetails(project, agent({ worktreePath: '/elsewhere/brave-otter' }));
    expect(elsewhere).toMatchObject({ worktree: '/elsewhere/brave-otter', changes: { noBase: true } });
  });
  it('leaves changes out while the agent is created or when git fails', async () => {
    expect((await buildAgentDetails(project, agent({ creation: { state: 'creating', startedAt: 'now' } }))).changes).toBeNull();
    expect(getBranchChanges).not.toHaveBeenCalled();
    vi.mocked(getBranchChanges).mockRejectedValueOnce(new Error('git missing'));
    expect((await buildAgentDetails(project, agent())).changes).toBeNull();
  });
});

describe('agent.update', () => {
  const live = { live: undefined, assertAuthorized: allow };

  it('saves spawn settings through updateDurableConfig and identity through updateDurable', async () => {
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce(agent({ name: 'calm-otter', model: 'opus', idleSleep: 'never' }));
    const result = await updateMobileAgent(project, agent(), { agentId: 'durable_1', name: ' calm-otter ', color: 'rose', emoji: '🦦',
      orchestrator: 'claude-code', model: 'opus', runtime: 'terminal', persona: 'qa', idleSleep: 'never' }, live);
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/work/app', 'durable_1',
      { orchestrator: 'claude-code', model: 'opus', runtimeMode: 'terminal', persona: 'qa', idleSleep: 'never' });
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/work/app', 'durable_1', { name: 'calm-otter', color: 'rose', emoji: '🦦' });
    expect(result.settings).toMatchObject({ name: { value: 'calm-otter' }, model: { value: 'opus' }, idleSleep: { value: 'never', minutes: 0 } });
  });
  it('says a new CLI starts a new session, before and after the change (#2593)', async () => {
    const withSession = agent({ orchestrator: 'claude-code', lastSessionId: 's1' });
    expect((await buildAgentSettings(project, withSession, undefined)).settings.orchestrator.changeStartsNewSession).toBe(true);
    expect((await buildAgentSettings(project, agent(), undefined)).settings.orchestrator.changeStartsNewSession).toBe(false);

    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce(agent({ orchestrator: 'codex-cli' }));
    const changed = await updateMobileAgent(project, withSession, { agentId: 'durable_1', orchestrator: 'codex-cli' }, live);
    expect(changed.sessionReset).toBe(true);
    expect(changed.settings.orchestrator.changeStartsNewSession).toBe(false);
  });
  it('reports no session reset when a session stayed or there was none', async () => {
    const withSession = agent({ orchestrator: 'claude-code', lastSessionId: 's1' });
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce(withSession);
    expect(await updateMobileAgent(project, withSession, { agentId: 'durable_1', orchestrator: 'claude-code' }, live)).not.toHaveProperty('sessionReset');
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce(agent({ orchestrator: 'codex-cli' }));
    expect(await updateMobileAgent(project, agent(), { agentId: 'durable_1', orchestrator: 'codex-cli' }, live)).not.toHaveProperty('sessionReset');
  });
  it('clears with null, default and inherit', async () => {
    vi.mocked(isClubhouseModeEnabled).mockReturnValueOnce(true);
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', emoji: null, persona: null, runtime: 'default', model: 'default', idleSleep: 'inherit', clubhouseMode: true }, live);
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/work/app', 'durable_1',
      { model: 'default', runtimeMode: null, persona: '', clubhouseModeOverride: false, idleSleep: null });
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/work/app', 'durable_1', { emoji: null });
  });
  it('changes auto-sleep while the agent runs, but nothing read at spawn', async () => {
    const running = { live: 'running' as const, assertAuthorized: allow };
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', idleSleep: 15 }, running);
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/work/app', 'durable_1', { idleSleep: 15 });
    // As annex-server passes it: the whole command, with its version, epoch and id.
    const command = { version: 1, epoch: 'e', commandId: 'c', type: 'agent.update', agentId: 'durable_1', idleSleep: 30 } as const;
    await updateMobileAgent(project, agent(), command, running);
    expect(agentConfig.updateDurableConfig).toHaveBeenLastCalledWith('/work/app', 'durable_1', { idleSleep: 30 });
    for (const change of [{ name: 'calm-otter' }, { model: 'opus' }, { color: 'rose' }, { idleSleep: 15 as const, persona: 'qa' }]) {
      const err = await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', ...change }, running));
      expect(err).toMatchObject({ code: 'agent_running', statusCode: 409, detail: 'Sleep the agent to change these' });
    }
    expect((await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', model: 'opus' }, { live: 'starting', assertAuthorized: allow }))).code).toBe('agent_running');
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledTimes(2);
  });
  it('refuses changes the desktop would not allow, before writing anything', async () => {
    const refuse = async (change: object, cfg = agent()) => (await refusal(updateMobileAgent(project, cfg, { agentId: 'durable_1', idleSleep: 30, ...change }, live))).code;
    expect(await refuse({ name: 'two words' })).toBe('invalid_name');
    expect(await refuse({ name: '   ' })).toBe('invalid_name');
    expect(await refuse({ color: 'plaid' })).toBe('invalid_color');
    expect(await refuse({ orchestrator: 'gemini' })).toBe('orchestrator_unavailable');
    expect(await refuse({ orchestrator: 'codex-cli', runtime: 'chat' })).toBe('runtime_unavailable');
    expect(await refuse({ persona: 'pirate' })).toBe('unknown_persona');
    expect(await refuse({ persona: 'dispatcher' })).toBe('unknown_persona');
    expect(await refuse({ clubhouseMode: false })).toBe('clubhouse_mode_unavailable');
    expect(await refuse({}, agent({ creation: { state: 'creating', startedAt: 'now' } }))).toBe('agent_creating');
    vi.mocked(isChatEnabled).mockReturnValueOnce(false);
    expect(await refuse({ runtime: 'chat' })).toBe('runtime_unavailable');
    expect(agentConfig.updateDurableConfig).not.toHaveBeenCalled();
    expect(agentConfig.updateDurable).not.toHaveBeenCalled();
  });
  it('lets an agent without a worktree keep a free-form name', async () => {
    await updateMobileAgent(project, agent({ worktreePath: undefined }), { agentId: 'durable_1', name: 'Release notes' }, live);
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/work/app', 'durable_1', { name: 'Release notes' });
  });
  it('rechecks authorization before writing', async () => {
    const revoked = () => { throw new MobileControlError('authorization_revoked', 403); };
    expect((await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', idleSleep: 30 }, { live: undefined, assertAuthorized: revoked }))).code).toBe('authorization_revoked');
    expect(agentConfig.updateDurableConfig).not.toHaveBeenCalled();
  });
});

describe('orchestration policy from a phone (#2228)', () => {
  beforeEach(() => { vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(null); });

  it('shows the resolved policy, which fields the agent overrides, and the choices', async () => {
    const { orchestration } = await buildAgentSettings(project, agent({ orchestration: { orchestrate: true, control: 'ask-everything' } }), undefined);
    expect(orchestration).toMatchObject({
      orchestrate: true, control: 'ask-everything', access: 'same', maxHelpers: 3, maxHelpersCap: 8,
      sources: { orchestrate: 'agent', control: 'agent', access: 'default', maxHelpers: 'persona' },
    });
  });

  it('caps the helper limit at the hard limit even when the app-wide cap is higher', async () => {
    vi.mocked(orchestrationSettings.getGlobalHelperCap).mockReturnValueOnce(500);
    expect(maxHelpersCap()).toBe(100);
  });

  it('writes a partial patch through the desktop service, while the agent runs too', async () => {
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', orchestration: { orchestrate: true, maxHelpers: 8, control: 'ask-before-start', access: 'auto' } }, { live: 'running', assertAuthorized: allow });
    expect(setOrchestrationPolicy).toHaveBeenCalledWith('/work/app', 'durable_1', { orchestrate: true, maxHelpers: 8, control: 'ask-before-start', access: 'auto' });
    expect(agentConfig.updateDurableConfig).not.toHaveBeenCalled();
  });

  it('clears a field with null, and every override with a null object', async () => {
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', orchestration: { control: null } }, { live: undefined, assertAuthorized: allow });
    expect(setOrchestrationPolicy).toHaveBeenLastCalledWith('/work/app', 'durable_1', { control: null });
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', orchestration: null }, { live: undefined, assertAuthorized: allow });
    expect(setOrchestrationPolicy).toHaveBeenLastCalledWith('/work/app', 'durable_1',
      { orchestrate: null, access: null, control: null, maxHelpers: null, crossProjectHelpers: null, connectToDispatcher: null });
  });

  it('refuses invalid fields with the reason, before writing anything', async () => {
    const update = (orchestration: unknown) => refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', name: 'calm-otter', orchestration } as never, { live: undefined, assertAuthorized: allow }));
    expect(await update({ maxHelpers: 9 })).toMatchObject({ code: 'invalid_orchestration', statusCode: 400, detail: 'maxHelpers must be a whole number from 1 to 8' });
    expect(await update({ maxHelpers: 0 })).toMatchObject({ code: 'invalid_orchestration', detail: 'maxHelpers must be a whole number from 1 to 8' });
    expect(await update({ maxHelpers: 2.5 })).toMatchObject({ code: 'invalid_orchestration' });
    expect(await update({ control: 'yolo' })).toMatchObject({ code: 'invalid_orchestration', detail: 'control must be one of hands-off, ask-before-start, ask-everything' });
    expect(await update({ access: 'root' })).toMatchObject({ code: 'invalid_orchestration', detail: 'access must be one of same, standard, auto, bypass' });
    expect(await update({ orchestrate: 'yes' })).toMatchObject({ code: 'invalid_orchestration', detail: 'orchestrate must be a boolean' });
    expect(await update({ instructions: 'x' })).toMatchObject({ code: 'invalid_orchestration', detail: 'Unknown orchestration policy field: instructions' });
    expect(await update({})).toMatchObject({ code: 'invalid_orchestration' });
    expect(setOrchestrationPolicy).not.toHaveBeenCalled();
    expect(agentConfig.updateDurable).not.toHaveBeenCalled();
  });

  it('refuses turning orchestration off while helpers are live, and writes nothing else', async () => {
    vi.mocked(setOrchestrationPolicy).mockResolvedValueOnce({ ok: false, message: 'brave-otter has 2 helper(s). Choose whether to keep or dispose them first.', needsHelperChoice: { helperIds: ['h1', 'h2'] } });
    const err = await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', idleSleep: 30, orchestration: { orchestrate: false } }, { live: undefined, assertAuthorized: allow }));
    expect(err).toMatchObject({ code: 'orchestration_has_helpers', statusCode: 409, detail: expect.stringContaining('2 helper(s)') });
    expect(agentConfig.updateDurableConfig).not.toHaveBeenCalled();
  });

  it('sets the policy on a new agent, and refuses a bad one before creating it', async () => {
    const create = { projectId: 'p1', name: 'calm-otter', color: 'indigo' };
    await createMobileAgent(project, { ...create, orchestration: { orchestrate: true, maxHelpers: 4 } }, allow);
    expect(setOrchestrationPolicy).toHaveBeenCalledWith('/work/app', 'durable_new', { orchestrate: true, maxHelpers: 4 });
    vi.mocked(startDurableCreation).mockClear();
    expect(await refusal(createMobileAgent(project, { ...create, orchestration: { control: 'nope' } } as never, allow))).toMatchObject({ code: 'invalid_orchestration' });
    expect(await refusal(createMobileAgent(project, { ...create, orchestration: { control: null } } as never, allow))).toMatchObject({ code: 'invalid_orchestration' });
    expect(await refusal(createMobileAgent(project, { ...create, orchestration: { maxHelpers: 50 } }, allow))).toMatchObject({ code: 'invalid_orchestration' });
    expect(startDurableCreation).not.toHaveBeenCalled();
  });
});

describe('cross-project helpers and Connect to Dispatcher (#2512, #2534)', () => {
  beforeEach(() => { vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(null); });

  it('shows both with where they come from', async () => {
    const { orchestration } = await buildAgentSettings(project, agent({ orchestration: { orchestrate: true, crossProjectHelpers: true } }), undefined);
    expect(orchestration).toMatchObject({
      // Unset, it follows orchestrate (#2578).
      crossProjectHelpers: true, connectToDispatcher: true,
      sources: { crossProjectHelpers: 'agent', connectToDispatcher: 'default' },
    });
  });

  it('writes both, and turns Connect to Dispatcher on only while the Dispatcher is on', async () => {
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', orchestration: { crossProjectHelpers: true, connectToDispatcher: false } }, { live: undefined, assertAuthorized: allow });
    expect(setOrchestrationPolicy).toHaveBeenLastCalledWith('/work/app', 'durable_1', { crossProjectHelpers: true, connectToDispatcher: false });
    vi.mocked(setOrchestrationPolicy).mockClear();
    const off = await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', orchestration: { connectToDispatcher: true } }, { live: undefined, assertAuthorized: allow }));
    expect(off).toMatchObject({ code: 'dispatcher_off', statusCode: 409 });
    expect(await refusal(createMobileAgent(project, { projectId: 'p1', name: 'calm-otter', color: 'indigo', orchestration: { connectToDispatcher: true } }, allow)))
      .toMatchObject({ code: 'dispatcher_off' });
    expect(setOrchestrationPolicy).not.toHaveBeenCalled();
    vi.mocked(isDispatcherEnabled).mockReturnValue(true);
    await updateMobileAgent(project, agent(), { agentId: 'durable_1', orchestration: { connectToDispatcher: true } }, { live: undefined, assertAuthorized: allow });
    expect(setOrchestrationPolicy).toHaveBeenLastCalledWith('/work/app', 'durable_1', { connectToDispatcher: true });
    vi.mocked(isDispatcherEnabled).mockReturnValue(false);
  });
});

describe('no Clubhouse MCP, no orchestration (#2589)', () => {
  beforeEach(() => {
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(null);
    vi.mocked(setOrchestrationPolicy).mockClear();
    vi.mocked(startDurableCreation).mockClear();
    vi.mocked(isDispatcherEnabled).mockReturnValue(true);
  });
  afterEach(() => {
    vi.mocked(isDispatcherEnabled).mockReturnValue(false);
    vi.mocked(isMcpEnabled).mockImplementation((_projectPath?: string, agentOverride?: boolean) => agentOverride ?? true);
  });

  const off = { mcpOverride: false };
  const update = (config: Parameters<typeof agent>[0], orchestration: unknown) =>
    updateMobileAgent(project, agent(config), { agentId: 'durable_1', orchestration } as never, { live: undefined, assertAuthorized: allow });

  it('shows the switches off with the reason, keeping where the saved values come from', async () => {
    const { orchestration } = await buildAgentSettings(project, agent({ ...off, orchestration: { orchestrate: true, crossProjectHelpers: true, connectToDispatcher: true } }), undefined);
    expect(orchestration).toMatchObject({
      mcpEnabled: false, orchestrate: false, crossProjectHelpers: false, connectToDispatcher: false,
      sources: { orchestrate: 'agent', connectToDispatcher: 'agent' },
    });
  });

  it.each(['orchestrate', 'crossProjectHelpers', 'connectToDispatcher'])('refuses turning %s on with the agent\'s own MCP off, telling the phone why', async (key) => {
    const err = await refusal(update(off, { [key]: true }));
    expect(err).toMatchObject({ code: 'mcp_off', statusCode: 409, detail: expect.stringContaining('Clubhouse MCP') });
    expect(setOrchestrationPolicy).not.toHaveBeenCalled();
  });

  it('refuses with MCP off at project or app level, reading the agent\'s own override', async () => {
    vi.mocked(isMcpEnabled).mockImplementation((_projectPath?: string, agentOverride?: boolean) => agentOverride ?? false);
    expect(await refusal(update({}, { orchestrate: true }))).toMatchObject({ code: 'mcp_off' });
    expect(isMcpEnabled).toHaveBeenLastCalledWith('/work/app', undefined);
    // An agent turned on keeps it, whatever its project says.
    await update({ mcpOverride: true }, { orchestrate: true });
    expect(setOrchestrationPolicy).toHaveBeenLastCalledWith('/work/app', 'durable_1', { orchestrate: true });
  });

  it('refuses a create that turns one on before anything is made', async () => {
    vi.mocked(isMcpEnabled).mockImplementation(() => false);
    const err = await refusal(createMobileAgent(project, { projectId: 'p1', name: 'calm-otter', color: 'indigo', orchestration: { orchestrate: true } }, allow));
    expect(err).toMatchObject({ code: 'mcp_off', statusCode: 409 });
    expect(startDurableCreation).not.toHaveBeenCalled();
  });

  it('still takes turning off, clearing and the other fields', async () => {
    for (const patch of [{ orchestrate: false }, { connectToDispatcher: null }, { maxHelpers: 2 }]) {
      await update(off, patch);
      expect(setOrchestrationPolicy).toHaveBeenLastCalledWith('/work/app', 'durable_1', patch);
    }
    await update(off, null);
    expect(setOrchestrationPolicy).toHaveBeenCalledTimes(4);
  });

  it('maps a refusal from the service, when MCP went off after the check', async () => {
    vi.mocked(setOrchestrationPolicy).mockResolvedValueOnce({ ok: false, message: 'no', mcpRequired: true });
    expect(await refusal(update({}, { orchestrate: true }))).toMatchObject({ code: 'mcp_off', statusCode: 409 });
  });
});

describe('model options use the profile env (#2569)', () => {
  it('passes the profile env, as GET_MODEL_OPTIONS does', async () => {
    vi.mocked(resolveProfileEnv).mockResolvedValue({ CLAUDE_CONFIG_DIR: '/profiles/work' });
    await buildAgentSettingsOptions('/work/app');
    expect(resolveProfileEnv).toHaveBeenCalledWith('/work/app', 'claude-code');
    expect(getModelOptions).toHaveBeenCalledWith('claude-code', { env: { CLAUDE_CONFIG_DIR: '/profiles/work' } });
    vi.mocked(resolveProfileEnv).mockResolvedValue(undefined);
  });
});

describe('the Dispatcher from a phone (#2533)', () => {
  const folder = { id: '__dispatcher__', path: '/Users/me/.clubhouse/dispatcher' };
  const dispatcherAgent = (extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig =>
    ({ id: 'durable_d', name: 'Dispatcher', color: 'indigo', createdAt: '2026-01-01', orchestrator: 'claude-code', persona: 'dispatcher', freeAgentMode: true, ...extra });
  const update = (command: Record<string, unknown>, live: 'running' | undefined = undefined, config = dispatcherAgent()) =>
    updateMobileDispatcher(folder, config, { agentId: 'durable_d', ...command }, { live, assertAuthorized: allow });

  beforeEach(() => { vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(null); });

  it('reads Settings > Dispatcher: CLI, model, runtime and Free agent mode at any time, the rest never, no orchestration', async () => {
    const settings = await buildAgentSettings(folder, dispatcherAgent(), 'running', { dispatcher: true });
    expect(settings).toMatchObject({ isDispatcher: true, orchestration: null, state: 'running' });
    expect(settings.settings).toMatchObject({
      name: { editable: 'never' }, color: { editable: 'never' }, emoji: { editable: 'never' }, persona: { editable: 'never' },
      clubhouseMode: { editable: 'never', value: null }, orchestrator: { editable: 'always' }, model: { editable: 'always' },
      runtime: { editable: 'always' }, freeAgentMode: { editable: 'always' }, idleSleep: { editable: 'always' },
    });
    expect((await buildAgentSettings(project, agent(), undefined))).not.toHaveProperty('isDispatcher');
  });

  it('has no changes to show: its folder is no git repo', async () => {
    expect((await buildAgentDetails(folder, dispatcherAgent(), { dispatcher: true })).changes).toBeNull();
    expect(getBranchChanges).not.toHaveBeenCalled();
  });

  it('changes CLI, model, runtime, Free agent mode and auto-sleep, also while it runs', async () => {
    await update({ model: 'opus', runtime: 'terminal', freeAgentMode: false, idleSleep: 30 }, 'running');
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith(folder.path, 'durable_d', { model: 'opus', runtimeMode: 'terminal', freeAgentMode: false, idleSleep: 30 });
    expect(agentConfig.updateDurable).not.toHaveBeenCalled();
  });

  it('resets the model with a new CLI, as Settings > Dispatcher does, unless the command sets one', async () => {
    await update({ orchestrator: 'codex-cli' });
    expect(agentConfig.updateDurableConfig).toHaveBeenLastCalledWith(folder.path, 'durable_d', { orchestrator: 'codex-cli', model: 'default' });
    await update({ orchestrator: 'claude-code', model: 'opus' }, undefined, dispatcherAgent({ orchestrator: 'codex-cli' }));
    expect(agentConfig.updateDurableConfig).toHaveBeenLastCalledWith(folder.path, 'durable_d', { orchestrator: 'claude-code', model: 'opus' });
  });

  it('refuses what Settings > Dispatcher does not offer, before writing anything', async () => {
    for (const command of [{ name: 'Boss' }, { color: 'rose' }, { emoji: '🧭' }, { persona: 'qa' }, { persona: null }, { clubhouseMode: true }, { orchestration: { orchestrate: true } }, { orchestration: null }]) {
      expect(await refusal(update({ idleSleep: 30, ...command }))).toMatchObject({ code: 'dispatcher_locked', statusCode: 409 });
    }
    expect(await refusal(update({ model: 'gpt-9' }))).toMatchObject({ code: 'invalid_model', statusCode: 400 });
    expect(await refusal(update({ orchestrator: 'unknown-cli' }))).toMatchObject({ code: 'orchestrator_unavailable' });
    expect(await refusal(update({ orchestrator: 'codex-cli', freeAgentMode: true }))).toMatchObject({ code: 'free_agent_mode_unavailable' });
    expect(agentConfig.updateDurableConfig).not.toHaveBeenCalled();
  });

  it('keeps its current CLI choosable after it was turned off for new agents', async () => {
    vi.mocked(getAvailableOrchestrators).mockReturnValue([orchestrator('codex-cli', false)] as never);
    await update({ orchestrator: 'claude-code' }, undefined, dispatcherAgent({ orchestrator: undefined }));
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith(folder.path, 'durable_d', { orchestrator: 'claude-code', model: 'default' });
  });
});
