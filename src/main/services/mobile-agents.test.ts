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
vi.mock('./agent-system', () => ({
  getAvailableOrchestrators: vi.fn(),
  checkAvailability: vi.fn(async () => ({ available: true })),
  resolveOrchestrator: vi.fn(async (_path: string, id?: string) => ({
    id: id ?? 'claude-code',
    getModelOptions: async () => (id === 'codex-cli' ? [] : [{ id: 'default', label: 'Default' }, { id: 'opus', label: 'Opus' }]),
  })),
}));
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
vi.mock('./git-service', () => ({ isInsideGitRepo: vi.fn(async () => true) }));
vi.mock('./persona-application', () => ({ applyPersonaToAgent: vi.fn(async () => undefined) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import * as agentConfig from './agent-config';
import { startDurableCreation } from './agent-creation';
import { checkAvailability, getAvailableOrchestrators } from './agent-system';
import { readProjectAgentDefaults } from './agent-settings-service';
import { getProfile } from './profile-settings';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { isChatEnabled } from './chat-runtime-settings';
import { isChatAgent } from './agent-runtime';
import { isInsideGitRepo } from './git-service';
import { applyPersonaToAgent } from './persona-application';
import { MobileControlError } from './mobile-control';
import { buildAgentSettings, buildAgentSettingsOptions, buildCreateOptions, createMobileAgent, updateMobileAgent } from './mobile-agents';

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
        orchestrator: { value: null, editable: 'sleeping', resolved: 'claude-code' },
        model: { value: 'opus', editable: 'sleeping' },
        runtime: { value: 'default', editable: 'sleeping', resolved: 'chat' },
        persona: { value: 'qa', editable: 'sleeping' },
        clubhouseMode: { value: null, editable: 'never', projectEnabled: false },
        freeAgentMode: { value: true, editable: 'sleeping' },
        idleSleep: { value: 60, editable: 'always', minutes: 60, source: 'agent', applies: true },
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
    for (const change of [{ name: 'calm-otter' }, { model: 'opus' }, { color: 'rose' }, { idleSleep: 15 as const, persona: 'qa' }]) {
      const err = await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', ...change }, running));
      expect(err).toMatchObject({ code: 'agent_running', statusCode: 409, detail: 'Sleep the agent to change these' });
    }
    expect((await refusal(updateMobileAgent(project, agent(), { agentId: 'durable_1', model: 'opus' }, { live: 'starting', assertAuthorized: allow }))).code).toBe('agent_running');
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledTimes(1);
  });
  it('refuses changes the desktop would not allow, before writing anything', async () => {
    const refuse = async (change: object, cfg = agent()) => (await refusal(updateMobileAgent(project, cfg, { agentId: 'durable_1', idleSleep: 30, ...change }, live))).code;
    expect(await refuse({ name: 'two words' })).toBe('invalid_name');
    expect(await refuse({ name: '   ' })).toBe('invalid_name');
    expect(await refuse({ color: 'plaid' })).toBe('invalid_color');
    expect(await refuse({ orchestrator: 'gemini' })).toBe('orchestrator_unavailable');
    expect(await refuse({ orchestrator: 'codex-cli', runtime: 'chat' })).toBe('runtime_unavailable');
    expect(await refuse({ persona: 'pirate' })).toBe('unknown_persona');
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
