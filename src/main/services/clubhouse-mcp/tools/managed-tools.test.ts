import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';

const state = vi.hoisted(() => ({
  base: '',
  agents: new Map<string, DurableAgentConfig>(),
  running: new Set<string>(),
  restartOrigins: [] as string[],
  /** Rows the grant check's peek doesn't see, as when it can't place a name. */
  hiddenFromPeek: new Set<string>(),
  available: true,
  failMetadata: false,
  projectListeners: new Set<() => void>(),
  projectPresent: true,
  projectGeneration: 0,
  projectPending: false,
  beforeSetupPrepare: undefined as undefined | (() => void | Promise<void>),
  afterSetupPrepare: undefined as undefined | (() => void | Promise<void>),
  beforeSettingsPrepare: undefined as undefined | (() => void | Promise<void>),
  beforePolicyPrepare: undefined as undefined | (() => void | Promise<void>),
}));

vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../project-import/service', () => ({
  projectImportService: { importForProject: vi.fn(async () => undefined) },
}));
vi.mock('../../agent-system', async (original) => ({
  ...await original<typeof import('../../agent-system')>(),
  resolveOrchestrator: vi.fn(async (_projectPath: string, cli?: string) => ({
    id: cli ?? 'claude-code',
    displayName: 'Test CLI',
    checkAvailability: async () => ({ available: state.available }),
    conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md' },
  })),
}));
vi.mock('../dispatcher-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => id === 'dispatcher',
}));
vi.mock('../../project-store', () => ({
  peekProjects: async () => state.projectPresent ? [{ id: 'p1', name: 'Clubhouse', path: '/proj' }] : [],
  projectRegistryMutationState: () => ({ generation: state.projectGeneration, pending: state.projectPending }),
  onProjectsChanged: (listener: () => void) => { state.projectListeners.add(listener); return () => { state.projectListeners.delete(listener); }; },
}));
vi.mock('../../agent-config', () => ({
  listDurable: async () => [...state.agents.values()],
  peekDurableConfigs: async () => [...state.agents.values()].filter((a) => !state.hiddenFromPeek.has(a.id)),
  getDurableConfig: async (_p: string, id: string) => state.agents.get(id) ?? null,
  createDurable: async (_p: string, name: string, color: string, model?: string, _worktree?: boolean, orchestrator?: string,
    _access?: unknown, _mcpIds?: unknown, _mcpConfigs?: unknown, _worktreeOptions?: unknown, options?: { connectToDispatcher?: false }) => {
    const a: DurableAgentConfig = { id: `new-${name}`, name, color, createdAt: '', worktreePath: `/w/${name}`, ...(model && { model }), ...(orchestrator && { orchestrator: orchestrator as never }),
      ...(options?.connectToDispatcher === false && { orchestration: { connectToDispatcher: false } }) };
    state.agents.set(a.id, a);
    return a;
  },
  deleteUnregister: async (_p: string, id: string) => { state.agents.delete(id); },
  deleteDurable: async (_p: string, id: string) => { state.agents.delete(id); },
  updateDurableConfig: async (_p: string, id: string, updates: Partial<DurableAgentConfig>, _before?: unknown, precondition?: import('../../agent-config').ManagedSetupCommitPrecondition) => {
    await state.beforeSettingsPrepare?.();
    await precondition?.prepare();
    const current = state.agents.get(id)!;
    precondition?.check(current);
    Object.assign(current, updates);
  },
  setOrchestrationConfig: async (_p: string, id: string, policy: DurableAgentConfig['orchestration'], precondition?: import('../../agent-config').ManagedSetupCommitPrecondition, updates?: Partial<DurableAgentConfig>) => {
    await state.beforePolicyPrepare?.();
    if (updates) await state.beforeSettingsPrepare?.();
    await precondition?.prepare();
    const current = state.agents.get(id)!;
    precondition?.check(current);
    Object.assign(current, updates);
    current.orchestration = policy;
  },
}));
const legacy = vi.hoisted(() => ({ notice: undefined as 'not_copied' | undefined }));
vi.mock('../../legacy-defaults', () => ({ legacyDefaultsNotCopied: async () => legacy.notice }));
vi.mock('../../agent-delete', () => ({ deleteAgent: vi.fn(async () => ({ ok: true, message: 'Force deleted', deleted: true })) }));
const grantMock = vi.hoisted(() => ({ granted: false }));
vi.mock('../grant-check', async (original) => {
  const real = await original<typeof import('../grant-check')>();
  // On: stands in for a person allowing every call, so a test can reach the tool's own refusals.
  return { ...real, checkToolGrant: (...args: Parameters<typeof real.checkToolGrant>) => (grantMock.granted ? { ok: true } : real.checkToolGrant(...args)) };
});
vi.mock('../../managed-agents/agents', async (original) => {
  const real = await original<typeof import('../../managed-agents/agents')>();
  return { ...real, previewConvert: vi.fn(real.previewConvert), convertToManaged: vi.fn(real.convertToManaged) };
});
vi.mock('../../managed-agents', async () => {
  const { createManagedAgentsService } = await import('../../managed-agents/service');
  const { createAssetCatalogStore } = await import('../../asset-catalog/store');
  const { createManagedStateStore } = await import('../../managed-agents/state-store');
  let svc: ReturnType<typeof createManagedAgentsService> | null = null;
  return {
    managedAgents: () => {
      const backing = createManagedStateStore(path.join(state.base, 'managed'));
      svc ??= createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(state.base, 'catalog') }),
        state: { read: backing.read, update: async (fn) => {
          if (state.failMetadata) throw new Error('password=private-value at /private/metadata');
          return backing.update(fn);
        } },
        listProjects: async () => [{ path: '/proj', name: 'Clubhouse' }],
        listAgents: async () => [...state.agents.values()],
        getAgent: async (_p, id) => state.agents.get(id) ?? null,
        setManagedSetup: async (_p, id, setup, precondition) => {
          await state.beforeSetupPrepare?.();
          await precondition?.prepare();
          await state.afterSetupPrepare?.();
          // Match production: load the current mutation snapshot AFTER preparation.
          const a = state.agents.get(id);
          if (!a) throw new Error('Agent not found');
          precondition?.check(a);
          if (setup) a.managed = setup; else delete a.managed;
        },
        isRunning: (id) => state.running.has(id),
      });
      return svc;
    },
    statusFor: async (_p: string, id: string) => ({ managed: !!state.agents.get(id)?.managed, running: state.running.has(id), waiting: false, changes: [], cliChanged: false }),
    activationFor: vi.fn(async () => ({ verification: { status: 'not_confirmed', reason: 'provider_evidence_unavailable', attempts: 0 } })),
    restartManagedAgent: vi.fn(async () => {
      // What the restart (and its spawn) runs under: never the Dispatcher's write grant.
      const { currentSettingsOrigin } = await import('../../settings-audit');
      state.restartOrigins.push(currentSettingsOrigin().surface);
      return { resumed: true };
    }),
  };
});

import { callTool, getScopedToolList, registerGlobalTool, _resetForTesting } from '../tool-registry';
import { CONFIRM_TTL_MS, registerManagedTools, _resetConfirmTokensForTesting } from './managed-tools';
import { activationFor, managedAgents, restartManagedAgent } from '../../managed-agents';
import { convertToManaged, previewConvert } from '../../managed-agents/agents';
import { _resetSettingsAuditForTesting } from '../../settings-audit';
import { CLUBHOUSE_MCP_PART_ID, CLUBHOUSE_PART_ALWAYS_ON } from '../../../../shared/managed-agents-types';
import { BUILTIN_BLOCK_IDS } from '../../managed-agents/builtins';
import { getAgentGrantChanges, updateAgentGrantChanges } from '../../agent-grants-store';
import { deleteAgent } from '../../agent-delete';
import { agentRegistry } from '../../agent-registry';
import * as setupAgentConfig from '../../agent-config';
import * as setupProjects from '../../project-store';
import { dropCallApprovalsFor, listGrantRequests, takeGrantRequest, _resetGrantRequestsForTesting } from '../../grant-requests';
import { resolveOrchestrator } from '../../agent-system';
import { describeDeleteCall } from './managed-tools';
import { _resetDispatcherBootstrapForTesting } from '../dispatcher-bootstrap';
import { getOrchestrationPolicy, setOrchestrationPolicy } from '../../orchestration-policy';

const call = async (name: string, args: Record<string, unknown>, caller = 'dispatcher') => {
  const r = await callTool(caller, name, args);
  return { ...r, json: (() => { try { return JSON.parse(r.content[0].text ?? 'null'); } catch { return null; } })() };
};

beforeEach(async () => {
  state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-tools-'));
  state.agents = new Map();
  state.running = new Set();
  state.restartOrigins = [];
  state.hiddenFromPeek = new Set();
  state.available = true;
  state.failMetadata = false;
  state.projectListeners = new Set();
  state.projectPresent = true;
  state.projectGeneration = 0;
  state.projectPending = false;
  state.beforeSetupPrepare = undefined;
  state.afterSetupPrepare = undefined;
  state.beforeSettingsPrepare = undefined;
  state.beforePolicyPrepare = undefined;
  vi.mocked(resolveOrchestrator).mockReset();
  vi.mocked(restartManagedAgent).mockClear();
  vi.mocked(deleteAgent).mockClear();
  grantMock.granted = false;
  _resetSettingsAuditForTesting(false);
  _resetForTesting();
  _resetConfirmTokensForTesting();
  _resetDispatcherBootstrapForTesting();
  registerManagedTools();
  await managedAgents().ensureBuiltins();
});

describe('builder tools for the Dispatcher (#2900)', () => {
  it('only the Dispatcher can call them', async () => {
    const r = await call('list_agent_parts', { kind: 'block' }, 'some-agent');
    expect(r.isError).toBe(true);
  });

  it('creates a part, attributed to the Dispatcher, and lists it', async () => {
    const created = await call('create_agent_part', { kind: 'block', name: 'Rules', content: { kind: 'block', content: 'Be brief.' } });
    expect(created.isError).toBeFalsy();
    expect(created.json).toMatchObject({ name: 'Rules', updatedBy: 'Dispatcher' });
    const listed = await call('list_agent_parts', { kind: 'block' });
    expect(listed.json.map((p: { name: string }) => p.name)).toContain('Rules');
  });

  it('refuses create_managed_agent before creating anything when its resolved CLI is unavailable', async () => {
    state.available = false;
    const made = await call('create_managed_agent', { project: 'Clubhouse', name: 'unavailable' });
    expect(made.isError).toBe(true);
    expect(made.content[0].text).toContain('Test CLI is unavailable.');
    expect(state.agents.size).toBe(0);
  });

  it('keeps explicit CLI and model choices over a template, and inherits only omitted choices', async () => {
    grantMock.granted = true;
    const template = await managedAgents().saveTemplate({
      name: 'Provider precedence', description: '',
      setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] },
      settings: { orchestrator: 'claude-code', model: 'opus' },
    });
    const explicit = await call('create_managed_agent', {
      project: 'Clubhouse', name: 'explicit-provider', templateId: template.id,
      settings: { orchestrator: 'copilot-cli', model: 'gpt-5' },
    });
    expect(explicit.isError).toBeFalsy();
    expect(state.agents.get(explicit.json.id)).toMatchObject({
      orchestrator: 'copilot-cli', model: 'gpt-5', managed: { templateId: template.id },
    });
    const inherited = await call('create_managed_agent', {
      project: 'Clubhouse', name: 'template-provider', templateId: template.id,
    });
    expect(inherited.isError).toBeFalsy();
    expect(state.agents.get(inherited.json.id)).toMatchObject({ orchestrator: 'claude-code', model: 'opus' });
  });

  it.each([
    { provider: 'copilot-cli' },
    { orchestrator: 'copilot-cli' },
    { model: 'gpt-5' },
    { settings: { provider: 'copilot-cli', model: 'gpt-5' } },
    { settings: { orchestrator: null, model: 'gpt-5' } },
    { settings: { orchestrator: '', model: 'gpt-5' } },
    { settings: { orchestrator: 'copilot-cli', model: null } },
  ])('refuses misplaced or invalid explicit runtime choices instead of creating a default agent: %j', async (choices) => {
    grantMock.granted = true;
    const result = await call('create_managed_agent', {
      project: 'Clubhouse', name: 'wrong-provider', templateId: 'builtin-template-orchestrator', ...choices,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/settings\.orchestrator|settings\.model|CLI|model/);
    expect(state.agents.size).toBe(0);
  });

  it('a shared edit needs the preview\'s confirm token, and saves with it', async () => {
    // The service is shared across tests here, so names are unique per test.
    const part = (await call('create_agent_part', { kind: 'block', name: 'Shared rules', content: { kind: 'block', content: 'one' } })).json;
    for (const id of ['a', 'b']) state.agents.set(id, { id, name: id, color: 'indigo', createdAt: '', worktreePath: `/w/${id}`, managed: { version: 1, blocks: [part.id], skills: [], mcps: [] } });
    const args = { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } };
    const first = await call('update_agent_part', args);
    expect(first.json).toMatchObject({ status: 'needs_confirmation' });
    expect(first.json.reaches).toHaveLength(2);
    const saved = await call('update_agent_part', { ...args, confirm: first.json.confirm });
    expect(saved.json).toMatchObject({ revision: part.revision + 1 });
  });

  it('asks first for a part one agent and one template use, as the UI does (#3100)', async () => {
    const part = (await call('create_agent_part', { kind: 'block', name: 'Agent and template 3100', content: { kind: 'block', content: 'one' } })).json;
    state.agents.set('c3100', { id: 'c3100', name: 'c3100', color: 'indigo', createdAt: '', worktreePath: '/w/c3100', managed: { version: 1, blocks: [part.id], skills: [], mcps: [] } });
    await call('save_agent_template', { name: 'Template 3100', blocks: [part.id] });
    const first = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } });
    expect(first.json).toMatchObject({ status: 'needs_confirmation', templates: ['Template 3100'] });
    expect(first.json.reaches).toHaveLength(1);
    const saved = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' }, confirm: first.json.confirm });
    expect(saved.json).toMatchObject({ revision: part.revision + 1 });
  });

  it('asks first for a part only two templates use (#3100)', async () => {
    const part = (await call('create_agent_part', { kind: 'block', name: 'Two templates 3100', content: { kind: 'block', content: 'one' } })).json;
    await call('save_agent_template', { name: 'Template A 3100', blocks: [part.id] });
    await call('save_agent_template', { name: 'Template B 3100', blocks: [part.id] });
    const first = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } });
    expect(first.json).toMatchObject({ status: 'needs_confirmation', reaches: [] });
  });

  it('has no retired built-ins: they are not installed, and nothing lists them (D99)', async () => {
    const parts = (await call('list_agent_parts', { kind: 'block' })).json as Array<{ id: string }>;
    expect(parts.map((p) => p.id)).toContain(BUILTIN_BLOCK_IDS.identity);
    expect(parts.map((p) => p.id)).not.toContain(BUILTIN_BLOCK_IDS.projectManager);
    const templates = (await call('list_agent_templates', {})).json as Array<{ id: string }>;
    expect(templates.map((t) => t.id)).toContain('builtin-template-product-owner');
    expect(templates.map((t) => t.id)).not.toContain('builtin-template-project-manager');
    expect((await call('get_agent_part', { id: BUILTIN_BLOCK_IDS.projectManager })).isError).toBe(true);
  });

  it('refuses to edit a built-in, and sets a managed agent\'s setup', async () => {
    const identity = (await call('get_agent_part', { id: 'builtin-block-identity' })).json;
    const r = await call('update_agent_part', { id: identity.id, expectedRevision: identity.revision, content: { kind: 'block', content: 'x' } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/builtin_read_only/);
    state.agents.set('a', { id: 'a', name: 'release-lead', color: 'indigo', createdAt: '', worktreePath: '/w/a', managed: { version: 1, blocks: [], skills: [], mcps: [] } });
    agentRegistry.register('dispatcher', { projectPath: state.base, orchestrator: 'claude-code', runtime: 'pty' });
    const args = { project: 'Clubhouse', agent: 'release-lead', blocks: ['builtin-block-identity'], skills: [], mcps: [] };
    const modelChange = await call('set_agent_setup', { ...args, model: 'opus' });
    expect(modelChange.isError).toBe(true);
    expect(modelChange.content[0].text).toContain('require an existing connection');
    expect(listGrantRequests().filter((r) => r.agentId === 'dispatcher')).toEqual([]);
    const asked = await call('set_agent_setup', args);
    expect(asked.content[0].text).toContain('Needs you');
    expect(state.agents.get('a')!.managed!.blocks).toEqual([]);
    expect(takeGrantRequest(listGrantRequests().find((r) => r.agentId === 'dispatcher')!.requestId, true)).toBeTruthy();
    const set = await call('set_agent_setup', args);
    expect(set.json).toMatchObject({ blocks: ['builtin-block-identity'], mcps: [CLUBHOUSE_MCP_PART_ID], note: CLUBHOUSE_PART_ALWAYS_ON });
    expect(state.agents.get('a')!.managed!.blocks).toEqual(['builtin-block-identity']);
    expect(state.agents.get('a')!.managed!.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    // Naming it gives no note.
    grantMock.granted = true;
    const kept = await call('set_agent_setup', { project: 'Clubhouse', agent: 'release-lead', blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    expect(kept.json).not.toHaveProperty('note');
    agentRegistry.untrack('dispatcher');
    _resetGrantRequestsForTesting();
  });

  it('keeps the Clubhouse MCP part in a template saved without it, and says so (D69)', async () => {
    const t = (await call('save_agent_template', { name: 'No bridge', blocks: [], mcps: [] })).json;
    expect(t).toMatchObject({ setup: { mcps: [CLUBHOUSE_MCP_PART_ID] }, note: CLUBHOUSE_PART_ALWAYS_ON });
    const edited = (await call('save_agent_template', { id: t.id, mcps: [] })).json;
    expect(edited).toMatchObject({ setup: { mcps: [CLUBHOUSE_MCP_PART_ID] }, note: CLUBHOUSE_PART_ALWAYS_ON });
  });

  it('refuses literal env values, so a part only ever holds names (D46)', async () => {
    const refused = await call('create_agent_part', { kind: 'mcp', name: 'Env svc', content: { kind: 'mcp', serverKey: 'envsvc', transport: 'stdio', command: 'svc', env: { MODE: 'fast' } } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/invalid: MCP servers keep variable names only/);
    const created = await call('create_agent_part', { kind: 'mcp', name: 'Env svc', content: { kind: 'mcp', serverKey: 'envsvc', transport: 'stdio', command: 'svc', envVars: ['MODE'] } });
    const read = await call('get_agent_part', { id: created.json.id });
    expect(read.json.content).toEqual({ kind: 'mcp', serverKey: 'envsvc', transport: 'stdio', command: 'svc', envVars: ['MODE'] });
  });

  it('reads a setup saved before the Clubhouse MCP part was required as having it (D69)', async () => {
    state.agents.set('old', { id: 'old', name: 'old-timer', color: 'indigo', createdAt: '', worktreePath: '/w/old', managed: { version: 1, blocks: [], skills: [], mcps: [] } });
    const r = await call('get_agent_setup', { project: 'Clubhouse', agent: 'old-timer' });
    expect(r.json.setup.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    // And the part's "used by" counts it.
    const part = (await call('get_agent_part', { id: CLUBHOUSE_MCP_PART_ID })).json;
    expect(part.usedBy.map((c: { agentName: string }) => c.agentName)).toContain('old-timer');
    // Reading never writes.
    expect(state.agents.get('old')!.managed!.mcps).toEqual([]);
  });

  it('says plainly when the project or agent is unknown', async () => {
    const r = await call('get_agent_setup', { project: 'Nope', agent: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No registered project matches/);
  });
});

function managedAgent(id: string, setup: Partial<NonNullable<DurableAgentConfig['managed']>> = {}): DurableAgentConfig {
  const a: DurableAgentConfig = { id, name: id, color: 'indigo', createdAt: '', worktreePath: `/w/${id}`, managed: { version: 1, blocks: [], skills: [], mcps: [], ...setup } };
  state.agents.set(id, a);
  return a;
}

describe('the builder tools', () => {
  it('are listed in the dispatcher group', () => {
    const names = getScopedToolList('dispatcher').map((t) => t.name);
    for (const name of ['list_agent_parts', 'update_agent_part', 'push_agent_template', 'restart_agent']) expect(names).toContain(name);
  });
});

describe('verified activation and plain agents (#2855)', () => {
  const pending = { verification: { status: 'not_confirmed', reason: 'awaiting_provider_report', attempts: 1 } };
  const verified = { status: 'verified', verification: { status: 'verified', attempts: 1 } };
  afterEach(() => { vi.useRealTimers(); });
  /** Steps the fake clock a second at a time, letting the call's real file reads run in between. */
  const settled = async <T>(promise: Promise<T>): Promise<T> => {
    let done = false;
    void promise.finally(() => { done = true; });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    return promise;
  };

  it('re-reads a pending provider report within waitSeconds, and stops once it is answered', async () => {
    managedAgent('target');
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.mocked(activationFor).mockReset().mockResolvedValueOnce(pending as never).mockResolvedValueOnce(pending as never).mockResolvedValue(verified as never);
    const result = await settled(call('get_agent_activation', { project: 'Clubhouse', agent: 'target', waitSeconds: 30 }));
    expect(result.json).toMatchObject({ status: 'verified', verification: { status: 'verified', attempts: 3 } });
    expect(activationFor).toHaveBeenCalledTimes(3);
  });

  it('never waits past the cap, and does not wait on a block or without waitSeconds', async () => {
    managedAgent('target');
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.mocked(activationFor).mockReset().mockResolvedValue(pending as never);
    const answered = (await settled(call('get_agent_activation', { project: 'Clubhouse', agent: 'target', waitSeconds: 1_000 }))).json;
    expect(answered.verification).toMatchObject({ status: 'not_confirmed', reason: 'awaiting_provider_report' });
    expect(answered.verification.attempts).toBeLessThanOrEqual(46);
    vi.mocked(activationFor).mockReset().mockResolvedValue({ verification: { status: 'blocked', reason: 'not_in_provider_report', attempts: 1 } } as never);
    expect((await call('get_agent_activation', { project: 'Clubhouse', agent: 'target', waitSeconds: 30 })).json.verification.attempts).toBe(1);
    vi.mocked(activationFor).mockReset().mockResolvedValue(pending as never);
    expect((await call('get_agent_activation', { project: 'Clubhouse', agent: 'target' })).json.verification.attempts).toBe(1);
    expect((await call('get_agent_activation', { project: 'Clubhouse', agent: 'target', waitSeconds: 0 })).json.verification.attempts).toBe(1);
    for (const waitSeconds of [-1, '5', Number.NaN]) {
      expect((await call('get_agent_activation', { project: 'Clubhouse', agent: 'target', waitSeconds })).isError, String(waitSeconds)).toBe(true);
    }
  });

  it('switches a plain agent to managed only with the preview\'s confirm token, keeping what it has', async () => {
    state.agents.set('plain', { id: 'plain', name: 'plain', color: 'indigo', createdAt: '', worktreePath: '/w/plain' });
    vi.mocked(previewConvert).mockResolvedValue({ blocks: ['plain notes'], skills: ['review'], mcps: ['tickets'], notes: [] });
    vi.mocked(convertToManaged).mockImplementation(async (_p, id) => {
      const setup = { version: 1 as const, blocks: ['b'], skills: ['s'], mcps: [CLUBHOUSE_MCP_PART_ID, 'm'] };
      state.agents.get(id)!.managed = setup;
      return setup;
    });
    const args = { project: 'Clubhouse', agent: 'plain' };
    const preview = await call('switch_agent_to_managed', args);
    expect(preview.json).toMatchObject({ status: 'needs_confirmation', blocks: ['plain notes'], skills: ['review'], mcps: ['tickets'] });
    expect(convertToManaged).not.toHaveBeenCalled();
    expect((await call('switch_agent_to_managed', { ...args, confirm: 'not-issued' })).isError).toBe(true);
    vi.mocked(previewConvert).mockResolvedValueOnce({ blocks: ['plain notes'], skills: ['review', 'added-since'], mcps: ['tickets'], notes: [] });
    expect((await call('switch_agent_to_managed', { ...args, confirm: preview.json.confirm })).content[0].text).toContain('stale');
    const again = await call('switch_agent_to_managed', args);
    const switched = await call('switch_agent_to_managed', { ...args, confirm: again.json.confirm });
    expect(switched.json).toMatchObject({ status: 'switched', setup: { mcps: [CLUBHOUSE_MCP_PART_ID, 'm'] } });
    expect(convertToManaged).toHaveBeenCalledExactlyOnceWith('/proj', 'plain', { keep: true });
    vi.mocked(previewConvert).mockReset().mockImplementation(async () => { throw new Error('This agent is already Clubhouse managed.'); });
    expect((await call('switch_agent_to_managed', args)).isError).toBe(true);
  });
});

describe('discovery and confirmed library imports (#2855)', () => {
  function sourceAgent() {
    const folder = path.join(state.base, 'native-source');
    const skill = path.join(folder, '.claude/skills/import-review');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: import-review\n---\nReview without executing anything.\n');
    state.agents.set('native-source', { id: 'native-source', name: 'native-source', color: 'indigo', createdAt: '', worktreePath: folder });
    return { project: 'Clubhouse', agent: 'native-source' };
  }

  it('imports only after a bound confirmation and leaves a plain source untouched', async () => {
    const source = sourceAgent();
    const original = JSON.stringify(state.agents.get('native-source'));
    const discovered = await call('discover_agent_assets', source);
    expect(discovered.isError).toBeFalsy();
    expect(discovered.json.providerLoaded).toBe('not_confirmed');
    const args = { ...source, candidateId: discovered.json.candidates[0].id, mode: 'copy', name: 'Confirmed imported review 2855' };
    const preview = await call('import_agent_asset', args);
    expect(preview.json.status).toBe('needs_confirmation');
    expect((await managedAgents().listParts('skill')).some((p) => p.name === args.name)).toBe(false);
    const imported = await call('import_agent_asset', { ...args, confirm: preview.json.confirm });
    expect(imported.isError, imported.content[0].text).toBeFalsy();
    expect(imported.json).toMatchObject({ status: 'imported', assigned: false, providerLoaded: 'not_confirmed', part: { name: args.name } });
    expect(imported.json.part.content).toBeUndefined();
    expect(JSON.stringify(state.agents.get('native-source'))).toBe(original);
    expect((await call('import_agent_asset', { ...args, confirm: preview.json.confirm })).isError).toBe(true);

    const reuse = { ...source, candidateId: args.candidateId, mode: 'reuse', partId: imported.json.part.id };
    const shared = await call('import_agent_asset', reuse);
    const reused = await call('import_agent_asset', { ...reuse, confirm: shared.json.confirm });
    expect(reused.json).toMatchObject({ status: 'reused', part: { id: imported.json.part.id }, assigned: false });
    expect(reused.json.part.content).toBeUndefined();
  });

  it('refuses source edits and worktree migration after the preview', async () => {
    const source = sourceAgent();
    const discovered = await call('discover_agent_assets', source);
    const args = { ...source, candidateId: discovered.json.candidates[0].id, mode: 'copy', name: 'Stale imported review 2855' };
    const before = await call('import_agent_asset', args);
    const folder = state.agents.get('native-source')!.worktreePath!;
    fs.writeFileSync(path.join(folder, '.claude/skills/import-review/SKILL.md'), 'Changed after preview.\n');
    expect((await call('import_agent_asset', { ...args, confirm: before.json.confirm })).content[0].text).toContain('stale');
    const next = await call('import_agent_asset', args);
    const moved = path.join(state.base, 'moved-source');
    fs.renameSync(folder, moved);
    state.agents.get('native-source')!.worktreePath = moved;
    expect((await call('import_agent_asset', { ...args, confirm: next.json.confirm })).content[0].text).toContain('stale');
    expect((await managedAgents().listParts('skill')).some((p) => p.name === args.name)).toBe(false);
  });

  it('rechecks source-read and library-write grants at confirmation', async () => {
    const source = sourceAgent();
    const discovered = await call('discover_agent_assets', source);
    const args = { ...source, candidateId: discovered.json.candidates[0].id, mode: 'copy', name: 'Grant blocked review 2855' };
    const before = await call('import_agent_asset', args);
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'library.write', target: { kind: 'any' }, mode: 'off' }] }));
      expect((await call('import_agent_asset', { ...args, confirm: before.json.confirm })).isError).toBe(true);
      expect((await managedAgents().listParts('skill')).some((p) => p.name === args.name)).toBe(false);
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.read', target: { kind: 'any' }, mode: 'off' }] }));
      expect((await call('discover_agent_assets', source)).isError).toBe(true);
      expect((await call('import_agent_asset', { ...args, confirm: before.json.confirm })).isError).toBe(true);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
    }
  });

  async function importPreview(name: string) {
    const source = sourceAgent();
    const discovered = await call('discover_agent_assets', source);
    const args = { ...source, candidateId: discovered.json.candidates[0].id, mode: 'copy', name };
    const preview = await call('import_agent_asset', args);
    expect(preview.json.status).toBe('needs_confirmation');
    return { args, token: preview.json.confirm };
  }

  it.each(['library.write', 'agent.read'] as const)('refuses %s revoked during confirmation preparation at the effect boundary', async (action) => {
    const { args, token } = await importPreview(`In-flight revoked ${action}`);
    const service = managedAgents();
    const entries = service.liveEntries.bind(service);
    vi.spyOn(service, 'liveEntries').mockImplementationOnce(async () => {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action, target: { kind: 'any' }, mode: 'off' }] }));
      return entries();
    });
    try {
      expect((await call('import_agent_asset', { ...args, confirm: token })).isError).toBe(true);
      expect((await service.listParts('skill')).some((p) => p.name === args.name)).toBe(false);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
    }
  });

  it.each(['move', 'retarget', 'provider'] as const)('refuses an in-flight registered source %s before the durable import', async (change) => {
    const { args, token } = await importPreview(`In-flight source ${change}`);
    const service = managedAgents();
    const entries = service.liveEntries.bind(service);
    vi.spyOn(service, 'liveEntries').mockImplementationOnce(async () => {
      const source = state.agents.get('native-source')!;
      if (change === 'provider') source.orchestrator = 'copilot-cli';
      else {
        const moved = path.join(state.base, 'moved-during-confirm');
        if (change === 'move') fs.renameSync(source.worktreePath!, moved);
        else fs.mkdirSync(moved);
        source.worktreePath = moved;
      }
      return entries();
    });
    expect((await call('import_agent_asset', { ...args, confirm: token })).isError).toBe(true);
    expect((await service.listParts('skill')).some((p) => p.name === args.name)).toBe(false);
  });

  it('keeps real Ask-first approval separate from preview confirmation and valid through the effect check', async () => {
    const { args, token } = await importPreview('Actually approved import');
    const confirmed = { ...args, confirm: token };
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: '/dispatcher-home', orchestrator: 'claude-code', runtime: 'pty' });
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'library.write', target: { kind: 'any' }, mode: 'ask' }] }));
      const asked = await call('import_agent_asset', confirmed);
      expect(asked.isError).toBe(true);
      expect(asked.content[0].text).toContain('approval');
      expect((await managedAgents().listParts('skill')).some((p) => p.name === args.name)).toBe(false);
      expect(takeGrantRequest(listGrantRequests('dispatcher')[0].requestId, true)).toBeTruthy();
      const imported = await call('import_agent_asset', confirmed);
      expect(imported.isError, imported.content[0].text).toBeFalsy();
      expect(imported.json).toMatchObject({ status: 'imported', part: { name: args.name } });
      expect((await call('import_agent_asset', confirmed)).isError).toBe(true);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
      agentRegistry.untrack('dispatcher');
      _resetGrantRequestsForTesting();
    }
  });

  it.each(['off', 'ask'] as const)('does not let a real approval cover source-read changed to %s in flight', async (mode) => {
    const { args, token } = await importPreview(`Approval does not widen to ${mode}`);
    const confirmed = { ...args, confirm: token };
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: '/dispatcher-home', orchestrator: 'claude-code', runtime: 'pty' });
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'library.write', target: { kind: 'any' }, mode: 'ask' }] }));
      expect((await call('import_agent_asset', confirmed)).isError).toBe(true);
      expect(takeGrantRequest(listGrantRequests('dispatcher')[0].requestId, true)).toBeTruthy();
      const service = managedAgents();
      const entries = service.liveEntries.bind(service);
      vi.spyOn(service, 'liveEntries').mockImplementationOnce(async () => {
        await updateAgentGrantChanges('dispatcher', () => ({ changes: [
          { action: 'library.write', target: { kind: 'any' }, mode: 'ask' },
          { action: 'agent.read', target: { kind: 'any' }, mode },
        ] }));
        return entries();
      });
      expect((await call('import_agent_asset', confirmed)).isError).toBe(true);
      expect((await service.listParts('skill')).some((p) => p.name === args.name)).toBe(false);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
      agentRegistry.untrack('dispatcher');
      _resetGrantRequestsForTesting();
    }
  });

  it('does not widen the original pending approval when source-read becomes Ask first before the user answers', async () => {
    const { args, token } = await importPreview('Original pending approval scope');
    const confirmed = { ...args, confirm: token };
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: '/dispatcher-home', orchestrator: 'claude-code', runtime: 'pty' });
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'library.write', target: { kind: 'any' }, mode: 'ask' }] }));
      expect((await call('import_agent_asset', confirmed)).isError).toBe(true);
      const old = listGrantRequests('dispatcher')[0];
      expect(old.actions).toEqual(['library.write']);
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [
        { action: 'library.write', target: { kind: 'any' }, mode: 'ask' },
        { action: 'agent.read', target: { kind: 'any' }, mode: 'ask' },
      ] }));
      dropCallApprovalsFor('dispatcher');
      expect(takeGrantRequest(old.requestId, true)?.actions).toEqual(['library.write']);
      expect((await call('import_agent_asset', confirmed)).isError).toBe(true);
      expect((await managedAgents().listParts('skill')).some((p) => p.name === args.name)).toBe(false);
      const current = listGrantRequests('dispatcher')[0];
      expect(current.actions).toEqual(['agent.read', 'library.write']);
      expect(takeGrantRequest(current.requestId, true)).toBeTruthy();
      expect((await call('import_agent_asset', confirmed)).json.status).toBe('imported');
      expect((await call('import_agent_asset', confirmed)).isError).toBe(true);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
      agentRegistry.untrack('dispatcher');
      _resetGrantRequestsForTesting();
    }
  });

  it('refuses an inherited project provider changed during the final source/library snapshot', async () => {
    let projectProvider: 'claude-code' | 'copilot-cli' = 'claude-code';
    const provider = await resolveOrchestrator('/proj');
    vi.mocked(resolveOrchestrator).mockImplementation(async (_p, cli) => ({ ...provider, id: cli ?? projectProvider }));
    const { args, token } = await importPreview('Late inherited project provider');
    const service = managedAgents();
    const entries = service.liveEntries.bind(service);
    let snapshots = 0;
    vi.spyOn(service, 'liveEntries').mockImplementation(async () => {
      if (++snapshots === 2) projectProvider = 'copilot-cli';
      return entries();
    });
    expect(state.agents.get('native-source')?.orchestrator).toBeUndefined();
    expect((await call('import_agent_asset', { ...args, confirm: token })).isError).toBe(true);
    expect(projectProvider).toBe('copilot-cli');
    expect((await service.listParts('skill')).some((p) => p.name === args.name)).toBe(false);
  });

  it('re-asks when a name resolves to a different canonical agent despite identical actions and labels', async () => {
    sourceAgent();
    const original = state.agents.get('native-source')!;
    original.name = 'Shared source name';
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] }));
    registerGlobalTool('test_read_named_agent', { description: 'Read an agent', inputSchema: { type: 'object' } }, handler, {
      grant: { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
    });
    const args = { project: 'Clubhouse', agent: original.name };
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: '/dispatcher-home', orchestrator: 'claude-code', runtime: 'pty' });
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.read', target: { kind: 'any' }, mode: 'ask' }] }));
      expect((await call('test_read_named_agent', args)).isError).toBe(true);
      const old = listGrantRequests()[0];
      original.name = 'Previous source';
      state.agents.set('replacement', { ...original, id: 'replacement', name: args.agent });
      expect(takeGrantRequest(old.requestId, true)).toBeTruthy();
      expect((await call('test_read_named_agent', args)).isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      const current = listGrantRequests()[0];
      expect(current.actions).toEqual(old.actions);
      expect(current.where).toBe(old.where);
      expect(takeGrantRequest(current.requestId, true)).toBeTruthy();
      expect((await call('test_read_named_agent', args)).isError).toBeFalsy();
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
      agentRegistry.untrack('dispatcher');
      _resetGrantRequestsForTesting();
    }
  });

  it('synchronously refuses a project generation change after the final provider resolution and releases its listener', async () => {
    let projectProvider: 'claude-code' | 'copilot-cli' = 'claude-code';
    const provider = await resolveOrchestrator('/proj');
    vi.mocked(resolveOrchestrator).mockImplementation(async (_p, cli) => ({ ...provider, id: cli ?? projectProvider }));
    const { args, token } = await importPreview('Project generation changed at final snapshot');
    const service = managedAgents();
    const entries = service.liveEntries.bind(service);
    let snapshots = 0;
    vi.spyOn(service, 'liveEntries').mockImplementation(async () => {
      if (++snapshots === 3) {
        projectProvider = 'copilot-cli';
        for (const listener of state.projectListeners) listener();
      }
      return entries();
    });
    expect((await call('import_agent_asset', { ...args, confirm: token })).isError).toBe(true);
    expect(projectProvider).toBe('copilot-cli');
    expect((await service.listParts('skill')).some((p) => p.name === args.name)).toBe(false);
    expect(state.projectListeners.size).toBe(0);
  });

  it('returns an error-shaped durable partial receipt and can repair the existing part without creating again', async () => {
    const { args, token } = await importPreview('Recoverable partial import');
    let partial: Awaited<ReturnType<typeof call>>;
    try {
      state.failMetadata = true;
      partial = await call('import_agent_asset', { ...args, confirm: token });
    } finally { state.failMetadata = false; }
    expect(partial.isError).toBe(true);
    expect(partial.json).toMatchObject({ status: 'partial', assigned: false, providerLoaded: 'not_confirmed',
      receipt: { catalog: 'committed', metadata: 'not_saved', unfinishedStage: 'metadata' } });
    expect(partial.content[0].text).not.toMatch(/private-value|\/private\/metadata/);
    const id = partial.json.receipt.partId;
    expect((await call('get_agent_part', { id })).json).toMatchObject({ name: args.name, revision: 1 });
    expect((await call('import_agent_asset', { ...args, confirm: token })).isError).toBe(true);
    expect((await call('update_agent_part', { id, expectedRevision: 1, expectedDescription: '', description: 'Recovered metadata' })).json)
      .toMatchObject({ id, description: 'Recovered metadata' });
    expect((await managedAgents().listParts('skill')).filter((p) => p.name === args.name)).toHaveLength(1);
  });
});

describe('confirm tokens (#2900)', () => {
  async function sharedPart(name: string) {
    const part = (await call('create_agent_part', { kind: 'block', name, content: { kind: 'block', content: 'one' } })).json;
    managedAgent('a', { blocks: [part.id] });
    managedAgent('b', { blocks: [part.id] });
    return { part, args: { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } } };
  }

  it('refuses a token it never issued', async () => {
    const { args } = await sharedPart('Never issued');
    const r = await call('update_agent_part', { ...args, confirm: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/wasn't issued to you/);
    expect((await call('get_agent_part', { id: args.id })).json.revision).toBe(args.expectedRevision);
  });

  it('works once', async () => {
    const { args } = await sharedPart('Once only');
    const first = await call('update_agent_part', args);
    expect((await call('update_agent_part', { ...args, confirm: first.json.confirm })).isError).toBeFalsy();
    const again = await call('update_agent_part', { ...args, expectedRevision: args.expectedRevision + 1, confirm: first.json.confirm });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/already used/);
  });

  it('expires after ten minutes', async () => {
    const { args } = await sharedPart('Expiring');
    const first = await call('update_agent_part', args);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + CONFIRM_TTL_MS + 1);
    try {
      const r = await call('update_agent_part', { ...args, confirm: first.json.confirm });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/expired/);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a token when the arguments differ from the preview', async () => {
    const { args } = await sharedPart('Different args');
    const first = await call('update_agent_part', args);
    const r = await call('update_agent_part', { ...args, content: { kind: 'block', content: 'three' }, confirm: first.json.confirm });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/stale/);
  });

  it('lists the templates an edit reaches in its preview', async () => {
    const { part, args } = await sharedPart('In a template');
    await call('save_agent_template', { name: 'Uses the part', blocks: [part.id] });
    const first = await call('update_agent_part', args);
    expect(first.json.templates).toEqual(['Uses the part']);
  });
});

describe('delete_agent_part', () => {
  it('previews the agents and templates a part in use reaches, and deletes with the token', async () => {
    const part = (await call('create_agent_part', { kind: 'block', name: 'Doomed', content: { kind: 'block', content: 'x' } })).json;
    managedAgent('a', { blocks: [part.id] });
    await call('save_agent_template', { name: 'Doomed template', blocks: [part.id] });
    const args = { id: part.id, expectedRevision: part.revision, mode: 'remove' };
    const first = await call('delete_agent_part', args);
    expect(first.json).toMatchObject({ status: 'needs_confirmation', reaches: [{ agent: 'a' }], templates: ['Doomed template'] });
    expect((await call('get_agent_part', { id: part.id })).isError).toBeFalsy();
    const done = await call('delete_agent_part', { ...args, confirm: first.json.confirm });
    expect(done.json).toEqual({ status: 'deleted' });
    expect(state.agents.get('a')!.managed!.blocks).toEqual([]);
  });

  it('deletes an unused part at once', async () => {
    const part = (await call('create_agent_part', { kind: 'block', name: 'Unused', content: { kind: 'block', content: 'x' } })).json;
    expect((await call('delete_agent_part', { id: part.id, expectedRevision: part.revision, mode: 'remove' })).json).toEqual({ status: 'deleted' });
  });
});

describe('templates', () => {
  it.each(['off', 'declined', 'user-disabled'] as const)('a confirmed template push cannot reconnect a %s agent by omitting the connection field', async (mode) => {
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: '/proj', orchestrator: 'claude-code', runtime: 'chat' });
    agentRegistry.setLaunchCap('dispatcher', { freeAgentMode: true, access: 'full_access' });
    try {
      const template = await managedAgents().getTemplate('builtin-template-orchestrator');
      const createArgs = { project: 'Clubhouse', name: `unconnected-${mode}`, templateId: template.id };
      if (mode === 'off') {
        await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'connection.bootstrap', target: { kind: 'created_by_me' }, mode: 'off' }] }));
        expect((await call('create_managed_agent', { ...createArgs, connectToDispatcher: true })).isError).toBe(true);
      } else if (mode === 'declined') {
        expect((await call('create_managed_agent', { ...createArgs, connectToDispatcher: true })).json.status).toBe('needs_approval');
        expect(takeGrantRequest(listGrantRequests('dispatcher')[0].requestId, false)).toBeTruthy();
      }
      const made = await call('create_managed_agent', { ...createArgs, connectToDispatcher: false });
      expect(made.isError, made.content[0].text).toBeFalsy();
      const target = state.agents.get(made.json.id)!;
      if (mode === 'user-disabled') {
        await setOrchestrationPolicy('/proj', target.id, { connectToDispatcher: true });
        await setOrchestrationPolicy('/proj', target.id, { connectToDispatcher: false });
      }
      const { connectToDispatcher: _connection, ...orchestration } = template.settings.orchestration!;
      const args = { id: template.id, ...template.setup, settings: { ...template.settings, orchestration }, agents: [target.id] };
      const preview = await call('push_agent_template', args);
      expect(preview.json.status).toBe('needs_confirmation');
      const pushed = await call('push_agent_template', { ...args, confirm: preview.json.confirm });
      expect(pushed.json).toMatchObject({
        status: 'pushed', applied: 0, failed: [{ agentId: target.id, message: expect.stringContaining('require an existing connection') }],
      });
      expect(target.orchestration?.connectToDispatcher).toBe(false);
      expect((await getOrchestrationPolicy('/proj', target.id))?.connectToDispatcher).toBe(false);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
      agentRegistry.untrack('dispatcher');
      _resetGrantRequestsForTesting();
    }
  });

  it('save_agent_template with an id keeps the fields the call left out', async () => {
    const skill = (await call('create_agent_part', { kind: 'skill', name: 'Keep skill', content: { kind: 'skill', skillName: 'keep-skill', files: [{ path: 'SKILL.md', content: '# k' }] } })).json;
    const t = (await call('save_agent_template', {
      name: 'Keeper', description: 'Keeps things', blocks: [BUILTIN_BLOCK_IDS.identity], skills: [skill.id], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { model: 'opus' },
    })).json;
    const edited = (await call('save_agent_template', { id: t.id, name: 'Keeper 2' })).json;
    expect(edited).toMatchObject({
      id: t.id, name: 'Keeper 2', description: 'Keeps things', settings: { model: 'opus' },
      setup: { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [skill.id], mcps: [CLUBHOUSE_MCP_PART_ID] },
    });
    const blocksOnly = (await call('save_agent_template', { id: t.id, blocks: [] })).json;
    expect(blocksOnly).toMatchObject({ name: 'Keeper 2', setup: { blocks: [], skills: [skill.id] }, settings: { model: 'opus' } });
  });

  it('only the user sets a template\'s Clubhouse permissions, and an edit over MCP keeps them (#2971)', async () => {
    const grants = [{ action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' }];
    const refused = await call('save_agent_template', { name: 'Escalate', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { grants } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('only the user');
    expect((await call('create_managed_agent', { project: '/p', name: 'x', settings: { grants } })).isError).toBe(true);

    const saved = await managedAgents().saveTemplate({ name: 'User perms', description: '', setup: { blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] }, settings: { grants: [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'off' }] } });
    const edited = (await call('save_agent_template', { id: saved.id, settings: { model: 'opus' } })).json;
    expect(edited.settings).toEqual({ model: 'opus', grants: [{ action: 'agent.message', target: { kind: 'connected' }, mode: 'off' }] });
  });

  it('an agent creating from a template passes its permissions only as far as it holds them (#2971)', async () => {
    const app = { kind: 'app' };
    const t = await managedAgents().saveTemplate({ name: 'Wide', description: '', setup: { blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] }, settings: { grants: [
      { action: 'settings.app.write', target: app, mode: 'allow' },
      { action: 'models.read', target: app, mode: 'off' },
    ] as never } });
    const made = await call('create_managed_agent', { project: 'Clubhouse', name: 'from-wide', templateId: t.id });
    expect(made.isError).toBeFalsy();
    // The Dispatcher has app settings writes only as Ask first, so that's all it passes.
    expect(getAgentGrantChanges(made.json.id)?.template).toEqual([
      { action: 'settings.app.write', target: app, mode: 'ask' },
      { action: 'models.read', target: app, mode: 'off' },
    ]);
  });

  it('push keeps the template\'s settings when the call leaves them out', async () => {
    const t = (await call('save_agent_template', { name: 'Settings stay', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { model: 'opus', orchestration: { maxHelpers: 2 } } })).json;
    const preview = await call('push_agent_template', { id: t.id, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    expect(preview.json.changes).toEqual([expect.objectContaining({ kind: 'add', id: BUILTIN_BLOCK_IDS.identity })]);
  });

  it('a level sent back with its read-back legacy flag is saved as the level, never higher (#2997)', async () => {
    const t = (await call('save_agent_template', { name: 'Free', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'full_access' } })).json;
    const read = (await call('list_agent_templates', {})).json.find((x: { id: string }) => x.id === t.id);
    expect(read.settings).toMatchObject({ access: 'full_access', freeAgentMode: true });
    // Lower only the level, sending back the rest as read.
    const lowered = (await call('save_agent_template', { id: t.id, settings: { ...read.settings, access: 'plan' } })).json;
    expect(lowered.settings).toMatchObject({ access: 'plan', freeAgentMode: false });
    // And the other way: raising it with the old flag beside it.
    const raised = (await call('save_agent_template', { id: t.id, settings: { ...lowered.settings, access: 'auto' } })).json;
    expect(raised.settings).toMatchObject({ access: 'auto', freeAgentMode: true });
    // A push previews the level it was sent.
    const preview = await call('push_agent_template', { id: t.id, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { ...raised.settings, access: 'ask' } });
    expect(JSON.stringify(preview.json.changes)).toContain('Ask first');
    expect(JSON.stringify(preview.json.changes)).not.toContain('Full access');
  });

  it('refuses a level or legacy flag it can\'t read, never reading it as some level (#2997)', async () => {
    const t = (await call('save_agent_template', { name: 'Plan', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'plan' } })).json;
    for (const settings of [{ freeAgentMode: 'false' }, { freeAgentMode: 1 }, { access: 'full' }, { access: 'full', freeAgentMode: true }]) {
      const saved = await call('save_agent_template', { id: t.id, settings });
      expect(saved.isError, JSON.stringify(settings)).toBe(true);
      const pushed = await call('push_agent_template', { id: t.id, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings });
      expect(pushed.isError, JSON.stringify(settings)).toBe(true);
      const made = await call('create_managed_agent', { project: 'Clubhouse', name: 'odd', templateId: t.id, settings });
      expect(made.isError, JSON.stringify(settings)).toBe(true);
    }
    expect((await call('list_agent_templates', {})).json.find((x: { id: string }) => x.id === t.id).settings).toMatchObject({ access: 'plan' });
  });

  it('a new template with only a legacy flag maps it as a legacy record does, not to the Default access', async () => {
    const t = (await call('save_agent_template', { name: 'Off', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { freeAgentMode: false } })).json;
    expect(t.settings).toMatchObject({ access: 'ask', freeAgentMode: false });
  });

  it('a bare legacy flag keeps the template\'s level on that side (#2997)', async () => {
    const t = (await call('save_agent_template', { name: 'Auto', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'auto' } })).json;
    const kept = (await call('save_agent_template', { id: t.id, settings: { freeAgentMode: true } })).json;
    expect(kept.settings).toMatchObject({ access: 'auto' });
  });

  it('push refuses a stale token after the template changed, and changes nothing', async () => {
    const t = (await call('save_agent_template', { name: 'Stale push', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID] })).json;
    managedAgent('a', { mcps: [CLUBHOUSE_MCP_PART_ID], templateId: t.id });
    const args = { id: t.id, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], agents: ['a'] };
    const first = await call('push_agent_template', args);
    expect(first.json.status).toBe('needs_confirmation');
    await call('save_agent_template', { id: t.id, blocks: [BUILTIN_BLOCK_IDS.basics] });
    const r = await call('push_agent_template', { ...args, confirm: first.json.confirm });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/stale/);
    expect(state.agents.get('a')!.managed!.blocks).toEqual([]);
  });

  it('push counts only the agents it changed', async () => {
    const t = (await call('save_agent_template', { name: 'Count push', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID] })).json;
    managedAgent('a', { mcps: [CLUBHOUSE_MCP_PART_ID], templateId: t.id });
    managedAgent('b', { blocks: [BUILTIN_BLOCK_IDS.identity], mcps: [CLUBHOUSE_MCP_PART_ID], templateId: t.id });
    state.agents.get('a')!.orchestration = { connectToDispatcher: true };
    state.agents.get('b')!.orchestration = { connectToDispatcher: true };
    const args = { id: t.id, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], agents: ['a', 'b'] };
    const first = await call('push_agent_template', args);
    const pushed = await call('push_agent_template', { ...args, confirm: first.json.confirm });
    expect(pushed.json).toMatchObject({ status: 'pushed', applied: 1, skipped: ['b'], failed: [] });
    expect(state.agents.get('a')!.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity]);
  });

  it('push refuses agents not made from the template', async () => {
    const t = (await call('save_agent_template', { name: 'Wrong agents', blocks: [], mcps: [] })).json;
    managedAgent('a', {});
    const r = await call('push_agent_template', { id: t.id, blocks: [], skills: [], mcps: [], agents: ['a'] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Not made from this template: a/);
  });
});

describe('restart_agent', () => {
  beforeEach(() => {
    agentRegistry.register('dispatcher', { projectPath: '/dispatcher-home', orchestrator: 'claude-code', runtime: 'pty', nonce: 'original' });
  });
  afterEach(() => { agentRegistry.untrack('dispatcher'); });

  it('refuses an agent that isn\'t managed, one that is asleep, and the Dispatcher itself', async () => {
    state.agents.set('plain', { id: 'plain', name: 'plain', color: 'indigo', createdAt: '', worktreePath: '/w/plain' });
    state.running.add('plain');
    managedAgent('sleepy');
    managedAgent('dispatcher');
    state.running.add('dispatcher');
    const plain = await call('restart_agent', { project: 'Clubhouse', agent: 'plain' });
    expect(plain.isError).toBe(true);
    expect(plain.content[0].text).toMatch(/isn't Clubhouse managed/);
    const sleepy = await call('restart_agent', { project: 'Clubhouse', agent: 'sleepy' });
    expect(sleepy.isError).toBe(true);
    expect(sleepy.content[0].text).toMatch(/isn't running/);
    const self = await call('restart_agent', { project: 'Clubhouse', agent: 'dispatcher' });
    expect(self.isError).toBe(true);
    expect(self.content[0].text).toMatch(/can't restart yourself/);
    expect(restartManagedAgent).not.toHaveBeenCalled();
  });

  it('waits for the turn to end unless now is true, and never under the write grant', async () => {
    managedAgent('worker');
    state.running.add('worker');
    expect((await call('restart_agent', { project: 'Clubhouse', agent: 'worker' })).json).toEqual({ status: 'restarted', resumed: true });
    expect(restartManagedAgent).toHaveBeenLastCalledWith('/proj', 'worker', { fresh: undefined, whenTurnEnds: true, authorize: expect.any(Function) });
    grantMock.granted = true;
    await call('restart_agent', { project: 'Clubhouse', agent: 'worker', now: true, fresh: true });
    expect(restartManagedAgent).toHaveBeenLastCalledWith('/proj', 'worker', { fresh: true, whenTurnEnds: false, authorize: expect.any(Function) });
    expect(state.restartOrigins).toEqual(['mcp', 'mcp']);
  });

  it('says when there was no conversation to resume', async () => {
    managedAgent('newbie');
    state.running.add('newbie');
    grantMock.granted = true;
    vi.mocked(restartManagedAgent).mockResolvedValueOnce({ resumed: false, noSession: true });
    expect((await call('restart_agent', { project: 'Clubhouse', agent: 'newbie', now: true })).json).toEqual({
      status: 'restarted', resumed: false, note: 'There was no conversation to resume, so it started a new one.',
    });
  });

  it('does not turn a restart-only grant into permission to interrupt, and rechecks authorization after waiting', async () => {
    managedAgent('restart-only');
    state.running.add('restart-only');
    expect((await call('restart_agent', { project: 'Clubhouse', agent: 'restart-only', now: true })).isError).toBe(true);
    expect(restartManagedAgent).not.toHaveBeenCalled();
    expect((await call('restart_agent', { project: 'Clubhouse', agent: 'restart-only' })).json.status).toBe('restarted');
    const authorize = vi.mocked(restartManagedAgent).mock.calls[0][2]?.authorize;
    expect(authorize).toBeTypeOf('function');
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.restart', target: { kind: 'any' }, mode: 'off' }] }));
      await expect(authorize!().then((check) => check())).rejects.toMatchObject({ code: 'not_permitted' });
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
    }
  });

  it.each([false, true])('keeps genuine original Ask-first approval through the restart effect check (now=%s)', async (now) => {
    managedAgent('approved-worker');
    state.running.add('approved-worker');
    agentRegistry.register('dispatcher', { projectPath: '/dispatcher-home', orchestrator: 'claude-code', runtime: 'pty' });
    _resetGrantRequestsForTesting();
    const effect = vi.fn();
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [
        { action: 'agent.restart', target: { kind: 'any' }, mode: 'ask' },
        { action: 'agent.sleep', target: { kind: 'any' }, mode: 'ask' },
      ] }));
      const args = { project: 'Clubhouse', agent: 'approved-worker', now };
      expect((await call('restart_agent', args)).isError).toBe(true);
      expect(restartManagedAgent).not.toHaveBeenCalled();
      const request = listGrantRequests()[0];
      expect(request.actions).toEqual(now ? ['agent.restart', 'agent.sleep'] : ['agent.restart']);
      expect(takeGrantRequest(request.requestId, true)).toBeTruthy();
      vi.mocked(restartManagedAgent).mockImplementationOnce(async (_p, _id, options) => {
        for (const stage of ['stop', 'start']) {
          const authorize = await options?.authorize?.();
          if (typeof authorize === 'function') authorize();
          effect(stage);
        }
        return { resumed: true };
      });
      const result = await call('restart_agent', args);
      expect(result.isError, result.content[0].text).toBeFalsy();
      expect(result.json.status).toBe('restarted');
      expect(effect.mock.calls).toEqual([['stop'], ['start']]);
      expect((await call('restart_agent', args)).isError).toBe(true);
      expect(effect).toHaveBeenCalledTimes(2);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
      agentRegistry.untrack('dispatcher');
      _resetGrantRequestsForTesting();
    }
  });

  it.each(['off', 'ask'] as const)('refuses restart changed to %s after asynchronous authorization preparation', async (mode) => {
    managedAgent('late-authorization');
    state.running.add('late-authorization');
    const effect = vi.fn();
    vi.mocked(restartManagedAgent).mockImplementationOnce(async (_p, _id, options) => {
      const authorize = await options?.authorize?.();
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.restart', target: { kind: 'any' }, mode }] }));
      if (typeof authorize === 'function') authorize();
      effect();
      return { resumed: true };
    });
    try {
      expect((await call('restart_agent', { project: 'Clubhouse', agent: 'late-authorization' })).isError).toBe(true);
      expect(effect).not.toHaveBeenCalled();
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
    }
  });

  it('refuses a restart when its registered authorization target disappears before the effect', async () => {
    managedAgent('unresolved-restart');
    state.running.add('unresolved-restart');
    const effect = vi.fn();
    vi.mocked(restartManagedAgent).mockImplementationOnce(async (_p, _id, options) => {
      state.hiddenFromPeek.add('unresolved-restart');
      const authorize = await options?.authorize?.();
      if (typeof authorize === 'function') authorize();
      effect();
      return { resumed: true };
    });
    expect((await call('restart_agent', { project: 'Clubhouse', agent: 'unresolved-restart' })).isError).toBe(true);
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed', 'pending'] as const)('refuses a %s project after asynchronous lifecycle preparation', async (change) => {
    managedAgent('project-fence');
    state.running.add('project-fence');
    const effect = vi.fn();
    vi.mocked(restartManagedAgent).mockImplementationOnce(async (_p, _id, options) => {
      const authorize = await options?.authorize?.();
      if (change === 'missing') state.projectPresent = false;
      await authorize?.refresh?.();
      if (change === 'changed') state.projectGeneration++;
      if (change === 'pending') state.projectPending = true;
      authorize?.();
      effect();
      return { resumed: true };
    });
    expect((await call('restart_agent', { project: 'Clubhouse', agent: 'project-fence' })).isError).toBe(true);
    expect(effect).not.toHaveBeenCalled();
  });

  it('does not reuse original Ask proof after the caller registration and nonce are replaced', async () => {
    managedAgent('caller-fence');
    state.running.add('caller-fence');
    _resetGrantRequestsForTesting();
    const effects = vi.fn();
    try {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.restart', target: { kind: 'any' }, mode: 'ask' }] }));
      const args = { project: 'Clubhouse', agent: 'caller-fence' };
      expect((await call('restart_agent', args)).isError).toBe(true);
      expect(takeGrantRequest(listGrantRequests()[0].requestId, true)).toBeTruthy();
      vi.mocked(restartManagedAgent).mockImplementationOnce(async (_p, _id, options) => {
        (await options?.authorize?.())?.();
        effects('stop');
        const original = agentRegistry.get('dispatcher')!;
        agentRegistry.untrack('dispatcher');
        agentRegistry.register('dispatcher', { ...original, nonce: 'replacement' });
        (await options?.authorize?.())?.();
        effects('start');
        return { resumed: true };
      });
      expect((await call('restart_agent', args)).isError).toBe(true);
      expect(effects.mock.calls).toEqual([['stop']]);
    } finally {
      await updateAgentGrantChanges('dispatcher', () => undefined);
      _resetGrantRequestsForTesting();
    }
  });
});

describe('builder tools: filters, template delete, plain agents, stale edits (#2900)', () => {
  it('filters list_agent_parts by source', async () => {
    await call('create_agent_part', { kind: 'block', name: 'Filter me', content: { kind: 'block', content: 'x' } });
    const custom = (await call('list_agent_parts', { kind: 'block', source: 'custom' })).json as Array<{ builtin: boolean; name: string }>;
    expect(custom.length).toBeGreaterThan(0);
    expect(custom.every((p) => !p.builtin)).toBe(true);
    expect(custom.map((p) => p.name)).toContain('Filter me');
    const builtin = (await call('list_agent_parts', { kind: 'block', source: 'builtin' })).json as Array<{ builtin: boolean }>;
    expect(builtin.length).toBeGreaterThan(0);
    expect(builtin.every((p) => p.builtin)).toBe(true);
    const bad = await call('list_agent_parts', { kind: 'block', source: 'mine' });
    expect(bad.isError).toBe(true);
  });

  it('refuses a stale edit with what the part is now, and never saves over it', async () => {
    const part = (await call('create_agent_part', { kind: 'block', name: 'Stale rules', content: { kind: 'block', content: 'one' } })).json;
    await call('update_agent_part', { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } });
    const stale = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'mine' } });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toMatch(new RegExp(`^stale: Stale rules changed since you read it\\. It is at revision ${part.revision + 1} now, saved by Dispatcher`));
    const now = (await call('get_agent_part', { id: part.id })).json;
    expect(now.content.content).toBe('two');
  });

  it('deletes a custom template after a preview that lists the agents made from it', async () => {
    const t = (await call('save_agent_template', { name: 'Doomed', blocks: [], skills: [], mcps: [] })).json;
    expect(t.updatedBy).toBe('Dispatcher');
    state.agents.set('made', { id: 'made', name: 'made', color: 'indigo', createdAt: '', worktreePath: '/w/made', managed: { version: 1, blocks: [], skills: [], mcps: [], templateId: t.id } });
    const first = await call('delete_agent_template', { id: t.id });
    expect(first.json).toMatchObject({ status: 'needs_confirmation', madeFromIt: [{ agent: 'made', project: 'Clubhouse', running: false }] });
    expect(first.json.note).toMatch(/keep their setup/);
    const done = await call('delete_agent_template', { id: t.id, confirm: first.json.confirm });
    expect(done.json).toEqual({ status: 'deleted' });
    expect((await call('list_agent_templates', {})).json.map((x: { id: string }) => x.id)).not.toContain(t.id);
    // The agent keeps its setup.
    expect(state.agents.get('made')!.managed!.templateId).toBe(t.id);
    const builtin = await call('delete_agent_template', { id: 'builtin-template-helper' });
    expect(builtin.isError).toBe(true);
    expect(builtin.content[0].text).toMatch(/builtin_read_only/);
  });

  it('refuses a template delete whose agents changed since the preview', async () => {
    const t = (await call('save_agent_template', { name: 'Moving', blocks: [], skills: [], mcps: [] })).json;
    const first = await call('delete_agent_template', { id: t.id });
    state.agents.set('late', { id: 'late', name: 'late', color: 'indigo', createdAt: '', worktreePath: '/w/late', managed: { version: 1, blocks: [], skills: [], mcps: [], templateId: t.id } });
    const r = await call('delete_agent_template', { id: t.id, confirm: first.json.confirm });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^stale/);
  });

  it('creates a managed agent attributed to the Dispatcher, or a plain one when asked', async () => {
    const managed = await call('create_managed_agent', { project: 'Clubhouse', name: 'builder-made' });
    expect(managed.json).toMatchObject({ name: 'builder-made', managed: true, status: 'sleeping', connectedToDispatcher: false });
    expect(managed.json.nextStep).toContain('enable Connect to Dispatcher');
    expect(state.agents.get(managed.json.id)?.orchestration?.connectToDispatcher).toBe(false);
    expect(state.agents.get(managed.json.id)!.managed).toMatchObject({ updatedBy: 'Dispatcher' });
    const plain = await call('create_managed_agent', { project: 'Clubhouse', name: 'plain-one', managed: false, settings: { model: 'opus' } });
    expect(plain.json).toMatchObject({ name: 'plain-one', managed: false, status: 'sleeping' });
    expect(state.agents.get(plain.json.id)!.managed).toBeUndefined();
    expect(state.agents.get(plain.json.id)!.model).toBe('opus');
    expect(plain.json).not.toHaveProperty('legacyDefaults');
    // A plain agent made here never gets the project's legacy defaults (#3245): the result says so when there are some.
    legacy.notice = 'not_copied';
    const told = await call('create_managed_agent', { project: 'Clubhouse', name: 'plain-two', managed: false });
    expect(told.json).toMatchObject({ legacyDefaults: 'not_copied', note: expect.stringContaining('weren\'t copied') });
    const managedTold = await call('create_managed_agent', { project: 'Clubhouse', name: 'builder-two' });
    expect(managedTold.json).not.toHaveProperty('legacyDefaults');
    legacy.notice = undefined;
    const mixed = await call('create_managed_agent', { project: 'Clubhouse', name: 'mixed', managed: false, templateId: 'builtin-template-helper' });
    expect(mixed.isError).toBe(true);
    expect(state.agents.has('new-mixed')).toBe(false);
  });

  it('refuses the untyped connection route and a non-boolean bootstrap option (#3281)', async () => {
    for (const connectToDispatcher of [true, false, null]) {
      const made = await call('create_managed_agent', {
        project: 'Clubhouse', name: 'bypass', settings: { orchestration: { connectToDispatcher } },
      });
      expect(made.isError).toBe(true);
      expect(made.content[0].text).toContain('top-level connectToDispatcher');
      expect(state.agents.has('new-bypass')).toBe(false);
    }
    const invalid = await call('create_managed_agent', { project: 'Clubhouse', name: 'invalid-flag', connectToDispatcher: 'true' });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain('expected boolean');
    for (const orchestration of [false, 1, 'invalid', [], null]) {
      const malformed = await call('create_managed_agent', { project: 'Clubhouse', name: 'malformed', settings: { orchestration } });
      expect(malformed.isError).toBe(true);
      expect(malformed.content[0].text).toContain('settings.orchestration must be an object');
      expect(state.agents.has('new-malformed')).toBe(false);
    }
  });

  it('a template cannot implicitly connect a new agent without bootstrap (#3281)', async () => {
    const template = await managedAgents().saveTemplate({
      name: 'Connected template', description: '', setup: { blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] },
      settings: { orchestration: { orchestrate: true, connectToDispatcher: true } },
    });
    const made = await call('create_managed_agent', { project: 'Clubhouse', name: 'not-implicitly-connected', templateId: template.id });
    expect(made.isError).toBeFalsy();
    expect(made.json.connectedToDispatcher).toBe(false);
    expect(state.agents.get(made.json.id)?.orchestration).toMatchObject({ orchestrate: true, connectToDispatcher: false });
  });
});

describe('stale renames over MCP (#2897, D92)', () => {
  it('needs the name and description it read to change them, and refuses either when it changed', async () => {
    const part = (await call('create_agent_part', { kind: 'block', name: 'Tool rules', description: 'Old', content: { kind: 'block', content: 'one' } })).json;
    const bare = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, name: 'Renamed' });
    expect(bare.isError).toBe(true);
    expect(bare.content[0].text).toMatch(/needs expectedName/);
    const noDesc = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, description: 'x' });
    expect(noDesc.content[0].text).toMatch(/needs expectedDescription/);
    // Someone renames it in the app; the revision stays.
    await managedAgents().updatePart({ id: part.id, expectedRevision: part.revision, expectedName: 'Tool rules', name: 'Tool rules v2' });
    const stale = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, expectedName: 'Tool rules', name: 'Tool rules' });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toMatch(/^stale: Tool rules v2 changed since you read it/);
    const descStale = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, expectedDescription: 'Older', description: 'x' });
    expect(descStale.content[0].text).toMatch(/^stale/);
    const ok = await call('update_agent_part', { id: part.id, expectedRevision: part.revision, expectedName: 'Tool rules v2', expectedDescription: 'Old', name: 'Tool rules 3', description: 'New' });
    expect(ok.json).toMatchObject({ name: 'Tool rules 3', description: 'New' });
  });

  it('refuses a confirm token after a rename between the preview and the commit', async () => {
    const part = (await call('create_agent_part', { kind: 'block', name: 'Token rules', content: { kind: 'block', content: 'one' } })).json;
    for (const id of ['ta', 'tb']) state.agents.set(id, { id, name: id, color: 'indigo', createdAt: '', worktreePath: `/w/${id}`, managed: { version: 1, blocks: [part.id], skills: [], mcps: [] } });
    const args = { id: part.id, expectedRevision: part.revision, content: { kind: 'block', content: 'two' } };
    const first = await call('update_agent_part', args);
    await managedAgents().updatePart({ id: part.id, expectedRevision: part.revision, expectedName: 'Token rules', name: 'Token rules v2' });
    const r = await call('update_agent_part', { ...args, confirm: first.json.confirm });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^stale/);
  });
});

describe('an orchestrator reads the library (#3001)', () => {
  it('only while orchestrators may choose helper templates, and sees only its own project\'s agents', async () => {
    const { setOrchestrationEnabled } = await import('../orchestration-gate');
    const { agentRegistry } = await import('../../agent-registry');
    state.agents.set('lead', { id: 'lead', name: 'lead', color: 'indigo', createdAt: '', worktreePath: '/w/lead', managed: { version: 1, blocks: [], skills: [], mcps: [] } });
    agentRegistry.register('orch', { projectPath: '/elsewhere', orchestrator: 'claude-code', runtime: 'pty' });
    setOrchestrationEnabled('orch', true);
    try {
      const off = await call('list_agent_templates', {}, 'orch');
      expect(off.isError).toBe(true);
      expect(off.content[0].text).toContain('choose helper templates');
      expect((await call('list_agent_parts', { kind: 'mcp' }, 'orch')).isError).toBe(true);
      await managedAgents().setHelperTemplateChoice(true);
      expect((await call('list_agent_templates', {}, 'orch')).isError).toBeFalsy();
      const mine = (await call('list_agent_parts', { kind: 'mcp' }, 'orch')).json.find((p: { id: string }) => p.id === CLUBHOUSE_MCP_PART_ID);
      // Another project's agents stay out of an orchestrator's view without cross-project helpers.
      expect(mine.usedBy).toEqual([]);
      const all = (await call('list_agent_parts', { kind: 'mcp' })).json.find((p: { id: string }) => p.id === CLUBHOUSE_MCP_PART_ID);
      expect(all.usedBy.map((u: { agentName: string }) => u.agentName)).toContain('lead');
    } finally {
      await managedAgents().setHelperTemplateChoice(false);
      setOrchestrationEnabled('orch', false);
      agentRegistry.untrack('orch');
    }
  });
});

describe('no agent sets Access above its own (D126)', () => {
  /** The Dispatcher running at this level, or not running. */
  const runAt = async (access: 'plan' | 'auto' | 'full_access' | null) => {
    const { agentRegistry } = await import('../../agent-registry');
    agentRegistry.untrack('dispatcher');
    agentRegistry.register('dispatcher', { projectPath: '/proj', orchestrator: 'claude-code', runtime: 'pty' });
    if (access) agentRegistry.setLaunchCap('dispatcher', { freeAgentMode: access !== 'plan', access });
  };
  afterEach(async () => { (await import('../../agent-registry')).agentRegistry.untrack('dispatcher'); });

  it('creating an agent: a level named above the caller\'s is refused, naming both, and nothing is made', async () => {
    await runAt('auto');
    const r = await call('create_managed_agent', { project: 'Clubhouse', name: 'too-high', settings: { access: 'full_access' } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('You run at Auto, so you can\'t create an agent at Full access: an agent never sets Access above its own. Use Auto or lower, or ask the user to set it.');
    expect(state.agents.has('new-too-high')).toBe(false);
    // A plain agent the same way.
    expect((await call('create_managed_agent', { project: 'Clubhouse', name: 'plain-high', managed: false, settings: { access: 'full_access' } })).isError).toBe(true);
    expect(state.agents.has('new-plain-high')).toBe(false);
    // At or below its own goes ahead.
    expect((await call('create_managed_agent', { project: 'Clubhouse', name: 'same', settings: { access: 'auto' } })).isError).toBeFalsy();
    expect((await call('create_managed_agent', { project: 'Clubhouse', name: 'lower', managed: false, settings: { access: 'plan' } })).isError).toBeFalsy();
  });

  it('creating from a template that sets more: refused, saying so and how to go ahead', async () => {
    await runAt('full_access');
    const t = (await call('save_agent_template', { name: 'Wide open', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'full_access' } })).json;
    await runAt('auto');
    const r = await call('create_managed_agent', { project: 'Clubhouse', name: 'from-wide', templateId: t.id });
    expect(r.content[0].text).toBe('You run at Auto, so you can\'t create an agent at Full access: an agent never sets Access above its own. The template sets Full access. Pass settings.access at or below your level, or ask the user to create it.');
    expect(state.agents.has('new-from-wide')).toBe(false);
    const ok = await call('create_managed_agent', { project: 'Clubhouse', name: 'from-wide-lower', templateId: t.id, settings: { access: 'auto' } });
    expect(ok.isError).toBeFalsy();
  });

  it('a legacy flag is read as creation reads it, from the Default access, and one that isn\'t on/off is refused', async () => {
    const { setDefaultAccess } = await import('../../free-agent-settings');
    await runAt('auto');
    await setDefaultAccess('full_access');
    try {
      // On keeps a Default that is already on: Full access, above Auto.
      const on = await call('create_managed_agent', { project: 'Clubhouse', name: 'legacy-on', managed: false, settings: { freeAgentMode: true } });
      expect(on.content[0].text).toMatch(/^You run at Auto, so you can't create an agent at Full access/);
      expect(state.agents.has('new-legacy-on')).toBe(false);
      for (const freeAgentMode of ['x', 1]) {
        const odd = await call('create_managed_agent', { project: 'Clubhouse', name: 'legacy-odd', managed: false, settings: { freeAgentMode } });
        expect(odd.isError).toBe(true);
        expect(odd.content[0].text).toContain('freeAgentMode must be true or false');
      }
      expect(state.agents.has('new-legacy-odd')).toBe(false);
      // With nothing named, the Default access itself is checked.
      const bare = await call('create_managed_agent', { project: 'Clubhouse', name: 'bare', managed: false });
      expect(bare.content[0].text).toContain('The Default access for new agents sets Full access.');
    } finally {
      await setDefaultAccess('ask');
    }
  });

  it('a caller not running reads as Ask first', async () => {
    await runAt(null);
    expect((await call('create_managed_agent', { project: 'Clubhouse', name: 'auto-one', settings: { access: 'auto' } })).isError).toBe(true);
    expect((await call('create_managed_agent', { project: 'Clubhouse', name: 'ask-one', settings: { access: 'ask' } })).isError).toBeFalsy();
  });

  it('a template push that raises the level above the caller\'s is refused; one that leaves it alone or lowers it goes ahead', async () => {
    await runAt('auto');
    const t = (await call('save_agent_template', { name: 'Team', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'ask' } })).json;
    const base = { id: t.id, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] };
    const raised = await call('push_agent_template', { ...base, settings: { access: 'full_access' } });
    expect(raised.isError).toBe(true);
    expect(raised.content[0].text).toMatch(/^You run at Auto, so you can't push a template that sets agents at Full access/);
    expect((await call('push_agent_template', { ...base, settings: { access: 'auto' } })).isError).toBeFalsy();
    // A template already above the caller can still have its parts pushed: the level isn't changing.
    await runAt('full_access');
    const wide = (await call('save_agent_template', { name: 'Already open', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'full_access' } })).json;
    await runAt('auto');
    expect((await call('push_agent_template', { id: wide.id, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] })).isError).toBeFalsy();
  });

  it('a push that drops the level sends agents to the Default access, which is checked too', async () => {
    await runAt('auto');
    const t = (await call('save_agent_template', { name: 'Planned', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'plan' } })).json;
    const drop = { id: t.id, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: {} };
    // The Default access here is Ask first: above a caller at Plan.
    await runAt('plan');
    const r = await call('push_agent_template', drop);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^You run at Plan, so you can't push a template that sets agents at Ask first/);
    await runAt('auto');
    expect((await call('push_agent_template', drop)).isError).toBeFalsy();
  });

  it('dropping a level equal to the Default access is checked too: agents set lower would be raised to it', async () => {
    const { setDefaultAccess } = await import('../../free-agent-settings');
    await runAt('auto');
    const t = (await call('save_agent_template', { name: 'At the default', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { access: 'auto' } })).json;
    await setDefaultAccess('auto');
    try {
      await runAt(null);
      const r = await call('push_agent_template', { id: t.id, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: {} });
      expect(r.content[0].text).toBe('You run at Ask first, so you can\'t push a template that sets agents at Auto: an agent never sets Access above its own. Leaving the level out means the Default access for new agents, which sets Auto. Use Ask first or lower, or ask the user to set it.');
    } finally {
      await setDefaultAccess('ask');
    }
  });
});

describe('delete_agent (#3182)', () => {
  const lead = (): DurableAgentConfig => {
    const a: DurableAgentConfig = { id: 'lead', name: 'Lead', color: 'indigo', createdAt: '', worktreePath: '/w/lead' };
    state.agents.set(a.id, a);
    return a;
  };

  beforeEach(() => {
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: '/dispatcher-home', orchestrator: 'claude-code', runtime: 'chat' });
  });
  afterEach(() => { agentRegistry.untrack('dispatcher'); });

  it('is the Dispatcher\'s only', async () => {
    expect(getScopedToolList('dispatcher').map((t) => t.name)).toContain('delete_agent');
    lead();
    const r = await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', worktree: 'delete' }, 'some-agent');
    expect(r.isError).toBe(true);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it('waits for the user in Needs you, naming the agent and what happens to its helpers and worktree, then the same call goes through once', async () => {
    lead();
    const args = { project: 'Clubhouse', agent: 'Lead', helpers: 'dispose', worktree: 'delete' };
    const asked = await call('delete_agent', args);
    expect(asked.isError).toBe(true);
    expect(asked.content[0].text).toContain('needs the user\'s approval');
    expect(deleteAgent).not.toHaveBeenCalled();
    const [request] = listGrantRequests();
    expect(request).toMatchObject({ kind: 'call', agentId: 'dispatcher', toolName: 'delete_agent', actions: ['agent.dispose'] });
    expect(request.details).toContain(
      'Delete Lead in Clubhouse. It is stopped if it is running, and so are quick agents running in its worktree. '
      + 'Its worktree and branch are removed, unless it has uncommitted or unpushed work. '
      + 'Its helpers, and theirs, are disposed with their worktrees and branches, unless any has uncommitted or unpushed work.',
    );

    takeGrantRequest(request.requestId, true);
    const done = await call('delete_agent', args);
    expect(done.isError).toBeFalsy();
    expect(done.json).toMatchObject({ status: 'deleted', agent: 'Lead', worktree: 'removed' });
    expect(deleteAgent).toHaveBeenCalledTimes(1);
    expect(deleteAgent).toHaveBeenCalledWith('/proj', 'lead', { mode: 'force', helpers: 'dispose', forceHelpers: false, checkWorktree: true, forceWorktree: false });
    // Once: the next call asks again.
    expect((await call('delete_agent', args)).isError).toBe(true);
    expect(deleteAgent).toHaveBeenCalledTimes(1);
  });

  it('describes keeping files and helpers, and a forced delete, for the person asked', () => {
    expect(describeDeleteCall({ agent: 'Lead', project: 'Clubhouse', worktree: 'keep', helpers: 'keep' }))
      .toBe('Delete Lead in Clubhouse. It is stopped if it is running, and so are quick agents running in its worktree. Its files stay on disk. Its helpers stay as ordinary agents.');
    expect(describeDeleteCall({ agent: 'Lead', worktree: 'delete', helpers: 'dispose', force: true }))
      .toBe('Delete Lead. It is stopped if it is running, and so are quick agents running in its worktree. Its worktree and branch are removed, even with uncommitted or unpushed work. '
        + 'Its helpers, and theirs, are disposed with their worktrees and branches, even with uncommitted or unpushed work.');
    expect(describeDeleteCall({ agent: 'Lead', worktree: 'delete' })).toMatch(/If it has helpers, nothing is deleted\.$/);
  });

  it('asks about the live agent when a disposed helper\'s row has the same name, and deletes only that one', async () => {
    state.agents.set('old-lead', { id: 'old-lead', name: 'Lead', color: 'indigo', createdAt: '', parentAgentId: 'x', disposedAt: '2026-11-01T00:00:00.000Z' });
    lead();
    const args = { project: 'Clubhouse', agent: 'Lead', worktree: 'delete' };
    const asked = await call('delete_agent', args);
    expect(asked.content[0].text).toContain('needs the user\'s approval');
    takeGrantRequest(listGrantRequests()[0].requestId, true);
    await call('delete_agent', args);
    expect(deleteAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteAgent).mock.calls[0][1]).toBe('lead');
  });

  it('never acts on a disposed helper\'s row, by name or id', async () => {
    state.agents.set('old-lead', { id: 'old-lead', name: 'Old lead', color: 'indigo', createdAt: '', parentAgentId: 'x', disposedAt: '2026-11-01T00:00:00.000Z' });
    grantMock.granted = true;
    expect((await call('delete_agent', { project: 'Clubhouse', agent: 'Old lead', worktree: 'delete' })).content[0].text).toMatch(/No agent "Old lead"/);
    expect((await call('delete_agent', { project: 'Clubhouse', agent: 'old-lead', worktree: 'delete' })).content[0].text).toMatch(/No agent "old-lead"/);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  it('refuses an agent the grant check couldn\'t place, which was never asked about', async () => {
    lead();
    state.hiddenFromPeek.add('lead');
    const r = await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', worktree: 'delete' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No agent "Lead" in Clubhouse/);
    expect(listGrantRequests()).toHaveLength(0);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  describe('with the user\'s permission', () => {
    beforeEach(() => { grantMock.granted = true; lead(); });

    it('says which quick agents it stopped', async () => {
      vi.mocked(deleteAgent).mockResolvedValueOnce({ ok: true, message: 'Force deleted', deleted: true, stoppedQuickAgents: ['quick_1_a'] });
      const r = await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', worktree: 'delete' });
      expect(r.json).toMatchObject({ status: 'deleted', stoppedQuickAgents: ['quick_1_a'] });
    });

    it('maps the choices to the delete: keep files, keep helpers, force', async () => {
      await call('delete_agent', { project: 'Clubhouse', agent: 'lead', helpers: 'keep', worktree: 'keep', force: true });
      expect(deleteAgent).toHaveBeenCalledWith('/proj', 'lead', { mode: 'unregister', helpers: 'keep', forceHelpers: true, checkWorktree: true, forceWorktree: true });
    });

    it('returns a missing helper choice as a result with the helpers, and opens nothing', async () => {
      vi.mocked(deleteAgent).mockResolvedValueOnce({
        ok: false, message: 'Lead has 1 helper. Choose whether to dispose or keep it.', needsHelperChoice: { helpers: [{ id: 'h1', name: 'scout' }] },
      });
      const r = await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', worktree: 'delete' });
      expect(r.isError).toBe(true);
      expect(r.json).toEqual({
        status: 'refused', agent: 'Lead', message: 'Lead has 1 helper. Choose whether to dispose or keep it.',
        helpers: [{ id: 'h1', name: 'scout' }], next: 'Call again with helpers: dispose or keep.',
      });
    });

    it('returns helpers with work at risk as facts', async () => {
      vi.mocked(deleteAgent).mockResolvedValueOnce({
        ok: false, message: 'scout has work that disposing would lose, or couldn\'t be checked',
        helpers: { ok: false, message: 'x', blocked: [{ agentId: 'h1', name: 'scout', checks: { dirty: 2, unpushed: 1, unmerged: 1 } }] },
      });
      const r = await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', helpers: 'dispose', worktree: 'delete' });
      expect(r.isError).toBe(true);
      expect(r.json.blockedHelpers).toEqual([{ id: 'h1', name: 'scout', dirty: 2, unpushed: 1, unmerged: 1 }]);
      expect(r.json.next).toMatch(/force: true/);
    });

    it('returns a helper that failed part way, with the ones that were disposed', async () => {
      vi.mocked(deleteAgent).mockResolvedValueOnce({
        ok: false, message: 'Disposed 1 of 2 helpers',
        helpers: { ok: false, message: 'Disposed 1 of 2 helpers', helperIds: ['h2'], failed: [{ agentId: 'h1', name: 'scout', reason: 'EBUSY' }] },
      });
      const r = await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', helpers: 'dispose', worktree: 'delete' });
      expect(r.json).toMatchObject({ disposedHelpers: ['h2'], failedHelpers: [{ agentId: 'h1', name: 'scout', reason: 'EBUSY' }] });
    });

    it('returns unsaved work in its worktree as facts', async () => {
      vi.mocked(deleteAgent).mockResolvedValueOnce({
        ok: false, message: 'Lead\'s worktree has unsaved work that deleting it would lose. Nothing was changed.',
        worktree: {
          isValid: true, branch: 'lead/standby', hasRemote: true,
          uncommittedFiles: [{ path: 'a.ts', status: 'M', staged: false }],
          unpushedCommits: [],
        },
      });
      const r = await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', worktree: 'delete' });
      expect(r.isError).toBe(true);
      expect(r.json.worktree).toEqual({ branch: 'lead/standby', uncommittedFiles: 1, unpushedCommits: 0 });
      expect(r.json.next).toMatch(/worktree: keep/);
    });

    it('refuses bad arguments and deleting itself before anything runs', async () => {
      state.agents.set('dispatcher', { id: 'dispatcher', name: 'Dispatcher', color: 'indigo', createdAt: '' });
      expect((await call('delete_agent', { project: 'Clubhouse', agent: 'Lead' })).isError).toBe(true);
      expect((await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', worktree: 'shred' })).content[0].text).toMatch(/worktree must be one of delete, keep/);
      expect((await call('delete_agent', { project: 'Clubhouse', agent: 'Lead', worktree: 'delete', helpers: 'abandon' })).content[0].text).toMatch(/helpers must be one of dispose, keep/);
      expect((await call('delete_agent', { project: 'Clubhouse', agent: 'Nobody', worktree: 'delete' })).content[0].text).toMatch(/No agent "Nobody"/);
      expect((await call('delete_agent', { project: 'Clubhouse', agent: 'dispatcher', worktree: 'delete' })).content[0].text).toMatch(/can't delete yourself/);
      expect(deleteAgent).not.toHaveBeenCalled();
    });
  });
});


describe('setup authorization pins its scoped target through the write (#3467)', () => {
  const args = { project: 'Clubhouse', agent: 'Target', blocks: ['builtin-block-identity'], skills: [], mcps: [] };
  function target(id: string, name: string) {
    const config: DurableAgentConfig = { id, name, color: 'indigo', createdAt: '', worktreePath: `/w/${id}`, managed: { version: 1, blocks: [], skills: [], mcps: [] } };
    state.agents.set(id, config);
    return config;
  }
  async function approve() {
    expect((await call('set_agent_setup', args)).content[0].text).toContain('Needs you');
    const request = listGrantRequests().find((request) => request.agentId === 'dispatcher')!;
    expect(takeGrantRequest(request.requestId, true)).toBeTruthy();
  }
  beforeEach(() => {
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: state.base, orchestrator: 'claude-code', runtime: 'pty' });
  });
  afterEach(async () => {
    await updateAgentGrantChanges('dispatcher', () => undefined);
    agentRegistry.untrack('dispatcher');
    _resetGrantRequestsForTesting();
  });

  it('refuses permissions revoked during the final target lookup, after approval was consumed', async () => {
    const a = target('a', 'Target');
    await approve();
    state.beforeSetupPrepare = () => {
      vi.spyOn(setupAgentConfig, 'peekDurableConfigs').mockImplementationOnce(async () => {
        await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.configure', target: { kind: 'any' }, mode: 'off' }] }));
        return [...state.agents.values()];
      });
    };
    expect((await call('set_agent_setup', args)).isError).toBe(true);
    expect(a.managed!.blocks).toEqual([]);
  });

  it('never writes B when a name switches from approved A to B during the final lookup', async () => {
    const a = target('a', 'Target');
    const b = target('b', 'Other');
    await approve();
    state.beforeSetupPrepare = () => {
      vi.spyOn(setupAgentConfig, 'peekDurableConfigs').mockImplementationOnce(async () => {
        a.name = 'Other'; b.name = 'Target';
        return [...state.agents.values()];
      });
    };
    expect((await call('set_agent_setup', args)).isError).toBe(true);
    expect(a.managed!.blocks).toEqual([]);
    expect(b.managed!.blocks).toEqual([]);
  });

  it.each(['renamed', 'disposed'] as const)('checks the fresh record %s during preparation instead of writing its old object', async (change) => {
    const original = target('a', 'Target');
    await approve();
    let replacement: DurableAgentConfig | undefined;
    state.afterSetupPrepare = () => {
      replacement = { ...original,
        ...(change === 'renamed' ? { name: 'new-name' } : { disposedAt: '2026-11-14T00:00:00Z' }),
      };
      state.agents.set('a', replacement);
    };
    expect((await call('set_agent_setup', args)).isError).toBe(true);
    expect(state.agents.get('a')).toBe(replacement);
    expect(replacement!.managed!.blocks).toEqual([]);
    expect(original.managed!.blocks).toEqual([]);
  });

  it('requires a new approval when the same name resolves to another Ask-first target on retry', async () => {
    const a = target('a', 'Target');
    const b = target('b', 'Other');
    await approve();
    a.name = 'Other'; b.name = 'Target';
    expect((await call('set_agent_setup', args)).content[0].text).toContain('Needs you');
    expect(b.managed!.blocks).toEqual([]);
    expect(listGrantRequests().filter((request) => request.agentId === 'dispatcher')).toHaveLength(1);
  });

  it('checks local B named like foreign connected A’s id, rather than authorizing A and writing B', async () => {
    const a = target('connected-id', 'Foreign');
    a.orchestration = { connectToDispatcher: true };
    const b = target('b', 'connected-id');
    vi.spyOn(setupProjects, 'peekProjects').mockResolvedValue([
      { id: 'p1', name: 'Clubhouse', path: '/proj' }, { id: 'p2', name: 'Other', path: '/other' },
    ]);
    vi.spyOn(setupAgentConfig, 'peekDurableConfigs').mockImplementation(async (project) => project === '/other' ? [a] : [b]);
    const result = await call('set_agent_setup', { ...args, agent: 'connected-id' });
    expect(result.content[0].text).toContain('Needs you');
    expect(a.managed!.blocks).toEqual([]);
    expect(b.managed!.blocks).toEqual([]);
  });

  it.each(['hidden', 'missing', 'ambiguous'] as const)('fails closed for a %s target, without creating a request or writing', async (kind) => {
    const a = target('a', 'Target');
    if (kind === 'hidden') state.hiddenFromPeek.add('a');
    if (kind === 'missing') a.name = 'Other';
    if (kind === 'ambiguous') target('b', 'Target');
    expect((await call('set_agent_setup', args)).isError).toBe(true);
    expect(listGrantRequests()).toEqual([]);
    expect(a.managed!.blocks).toEqual([]);
  });
});


describe('template pushes respect per-consumer configuration approval (#3480)', () => {
  async function fixture(settings: Record<string, unknown> = {}) {
    const made = await call('save_agent_template', { name: `Push boundary ${path.basename(state.base)}`, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings });
    expect(made.isError, made.content[0].text).toBeFalsy();
    const template = made.json;
    const agent = managedAgent('consumer', { templateId: template.id, mcps: [CLUBHOUSE_MCP_PART_ID] });
    Object.assign(agent, settings);
    const args = { id: template.id, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID], agents: [agent.id] };
    return { agent, args };
  }
  async function confirmed(args: Record<string, unknown>) {
    const preview = await call('push_agent_template', args);
    expect(preview.json.status).toBe('needs_confirmation');
    return { ...args, confirm: preview.json.confirm };
  }
  function approve() {
    const request = listGrantRequests('dispatcher')[0];
    expect(request).toBeTruthy();
    expect(takeGrantRequest(request.requestId, true)).toBeTruthy();
  }
  beforeEach(() => {
    _resetGrantRequestsForTesting();
    agentRegistry.register('dispatcher', { projectPath: '/proj', orchestrator: 'claude-code', runtime: 'chat' });
    agentRegistry.setLaunchCap('dispatcher', { freeAgentMode: true, access: 'full_access' });
  });
  afterEach(async () => {
    await updateAgentGrantChanges('dispatcher', () => undefined);
    agentRegistry.untrack('dispatcher');
    _resetGrantRequestsForTesting();
  });

  it.each([
    [{ model: 'sonnet' }, { model: 'opus' }],
    [{ orchestrator: 'claude-code' }, { orchestrator: 'codex-cli' }],
    [{ effort: 'low' }, { effort: 'high' }],
  ])('refuses unconnected settings changes despite a tool-issued confirm token', async (before, after) => {
    const { agent, args } = await fixture(before);
    const input = await confirmed({ ...args, settings: after });
    const result = await call('push_agent_template', input);
    expect(result.json).toMatchObject({ status: 'pushed', applied: 0, failed: [{ agentId: agent.id, message: expect.stringContaining('require an existing connection') }] });
    expect(agent).toMatchObject(before);
    expect(agent.managed!.blocks).toEqual([]);
    expect(listGrantRequests('dispatcher')).toEqual([]);
  });

  it('asks for an unconnected setup, then uses the same confirm token only after approval', async () => {
    const { agent, args } = await fixture();
    const input = await confirmed(args);
    expect((await call('push_agent_template', input)).content[0].text).toContain('Needs you');
    expect(agent.managed!.blocks).toEqual([]);
    approve();
    const result = await call('push_agent_template', input);
    expect(result.json).toMatchObject({ status: 'pushed', applied: 1, failed: [] });
    expect(agent.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity]);
    expect((await call('push_agent_template', input)).content[0].text).toContain('already used');
  });

  it('does not reuse one exact-call approval with a different preview token', async () => {
    const { agent, args } = await fixture();
    const first = await confirmed(args);
    expect((await call('push_agent_template', first)).content[0].text).toContain('Needs you');
    approve();
    const different = await confirmed(args);
    expect((await call('push_agent_template', different)).content[0].text).toContain('Needs you');
    expect(agent.managed!.blocks).toEqual([]);
  });

  it('combines an Ask-first library write and consumer setup into one approval', async () => {
    const { agent, args } = await fixture();
    await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'template.write', target: { kind: 'any' }, mode: 'ask' }] }));
    const input = await confirmed(args);
    expect((await call('push_agent_template', input)).content[0].text).toContain('Needs you');
    expect(listGrantRequests('dispatcher')).toHaveLength(1);
    approve();
    const result = await call('push_agent_template', input);
    expect(result.json).toMatchObject({ status: 'pushed', applied: 1, failed: [] });
    expect(agent.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity]);
  });

  it('honors a saved Off choice for unconnected consumer configuration', async () => {
    const { agent, args } = await fixture();
    await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.configure', target: { kind: 'any' }, mode: 'off' }] }));
    expect((await call('push_agent_template', await confirmed(args))).isError).toBe(true);
    expect(agent.managed!.blocks).toEqual([]);
    expect(listGrantRequests('dispatcher')).toEqual([]);
  });

  it('keeps connected model and setup propagation without a new approval', async () => {
    const { agent, args } = await fixture({ model: 'sonnet' });
    agent.orchestration = { connectToDispatcher: true };
    const result = await call('push_agent_template', await confirmed({ ...args, settings: { model: 'opus' } }));
    expect(result.json).toMatchObject({ status: 'pushed', applied: 1, failed: [] });
    expect(agent.model).toBe('opus');
    expect(agent.managed!.blocks).toEqual([BUILTIN_BLOCK_IDS.identity]);
    expect(listGrantRequests('dispatcher')).toEqual([]);
  });

  it('keeps a connected consumer model when its pushed policy is refused (#3486)', async () => {
    const before = { model: 'sonnet', effort: 'low', orchestration: { orchestrate: true } };
    const { agent, args } = await fixture(before);
    const result = await call('push_agent_template', await confirmed({ ...args,
      settings: { model: 'opus', effort: 'high', orchestration: { orchestrate: false } },
    }));
    expect(result.json).toMatchObject({ status: 'pushed', applied: 0, failed: [{ agentId: agent.id, message: expect.stringContaining('Only the user changes existing connections') }] });
    expect(agent).toMatchObject(before);
  });

  it('applies the model and accepted policy together for a connected consumer (#3486)', async () => {
    const { agent, args } = await fixture({ model: 'sonnet', orchestration: { orchestrate: true, maxHelpers: 1 } });
    const result = await call('push_agent_template', await confirmed({ ...args,
      settings: { model: 'opus', orchestration: { orchestrate: true, maxHelpers: 2 } },
    }));
    expect(result.json).toMatchObject({ status: 'pushed', applied: 1, failed: [] });
    expect(agent).toMatchObject({ model: 'opus', orchestration: { orchestrate: true, maxHelpers: 2 } });
  });

  it('refuses the combined settings write if the consumer connection changes during preparation', async () => {
    const { agent, args } = await fixture({ model: 'sonnet', orchestration: { orchestrate: true, maxHelpers: 1 } });
    state.beforeSettingsPrepare = () => { agent.orchestration = { connectToDispatcher: false, maxHelpers: 1 }; };
    const result = await call('push_agent_template', await confirmed({ ...args,
      settings: { model: 'opus', orchestration: { orchestrate: true, maxHelpers: 2 } },
    }));
    expect(result.json).toMatchObject({ status: 'pushed', applied: 0, failed: [{ agentId: agent.id }] });
    expect(agent).toMatchObject({ model: 'sonnet', orchestration: { connectToDispatcher: false, maxHelpers: 1 } });
  });

  it('refuses model propagation if the connection is removed before the settings write', async () => {
    const { agent, args } = await fixture({ model: 'sonnet' });
    agent.orchestration = { connectToDispatcher: true };
    state.beforeSettingsPrepare = () => { agent.orchestration = { connectToDispatcher: false }; };
    const result = await call('push_agent_template', await confirmed({ ...args, settings: { model: 'opus' } }));
    expect(result.json).toMatchObject({ status: 'pushed', applied: 0, failed: [{ agentId: agent.id, message: expect.stringMatching(/changed|connection/) }] });
    expect(agent.model).toBe('sonnet');
  });

  it.each(['renamed', 'disposed', 'revoked'] as const)('refuses an approved setup when the consumer is %s before mutation', async (change) => {
    const { agent, args } = await fixture();
    const input = await confirmed(args);
    expect((await call('push_agent_template', input)).content[0].text).toContain('Needs you');
    approve();
    state.afterSetupPrepare = async () => {
      if (change === 'revoked') await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'agent.configure', target: { kind: 'any' }, mode: 'off' }] }));
      else state.agents.set(agent.id, { ...agent, ...(change === 'renamed' ? { name: 'different' } : { disposedAt: '2026-11-14T00:00:00Z' }) });
    };
    const result = await call('push_agent_template', input);
    expect(result.json).toMatchObject({ status: 'pushed', applied: 0, failed: [{ agentId: agent.id }] });
    expect(agent.managed!.blocks).toEqual([]);
    expect(state.agents.get(agent.id)!.managed!.blocks).toEqual([]);
  });

  it('recomputes library approval context when policy changes but library mode is still Ask first', async () => {
    const { agent, args } = await fixture();
    await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'template.write', target: { kind: 'any' }, mode: 'ask' }] }));
    const input = await confirmed(args);
    expect((await call('push_agent_template', input)).content[0].text).toContain('Needs you');
    approve();
    state.afterSetupPrepare = async () => {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [
        { action: 'template.write', target: { kind: 'any' }, mode: 'ask' },
        { action: 'agent.configure', target: { kind: 'any' }, mode: 'off' },
      ] }));
    };
    expect((await call('push_agent_template', input)).isError).toBe(true);
    expect(agent.managed!.blocks).toEqual([]);
    expect((await managedAgents().getTemplate(args.id)).setup.blocks).toEqual([]);
  });

  it('does not overwrite a connected consumer policy replaced during final preparation', async () => {
    const { agent, args } = await fixture({ orchestration: { maxHelpers: 2, control: 'hands-off' } });
    agent.orchestration = { ...agent.orchestration, connectToDispatcher: true };
    state.beforePolicyPrepare = () => {
      state.agents.set(agent.id, { ...agent, orchestration: { connectToDispatcher: true, maxHelpers: 8, control: 'ask-before-start' } });
    };
    const result = await call('push_agent_template', await confirmed({ ...args, settings: { orchestration: { maxHelpers: 4, control: 'hands-off' } } }));
    expect(result.json).toMatchObject({ status: 'pushed', applied: 0, failed: [{ agentId: agent.id, message: expect.stringMatching(/policy changed/i) }] });
    expect(state.agents.get(agent.id)!.orchestration).toMatchObject({ maxHelpers: 8, control: 'ask-before-start' });
  });

  it('explains that a preview can expire while Needs you is pending and requires a fresh approval', async () => {
    const { agent, args } = await fixture();
    const input = await confirmed(args);
    expect((await call('push_agent_template', input)).content[0].text).toContain('Needs you');
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + CONFIRM_TTL_MS + 1);
    try {
      approve();
      const expired = await call('push_agent_template', input);
      expect(expired.isError).toBe(true);
      expect(expired.content[0].text).toMatch(/expired.*waiting for Needs you/);
      expect(expired.content[0].text).toContain('approval must be requested again');
      expect(agent.managed!.blocks).toEqual([]);
      const retry = await confirmed(args);
      expect((await call('push_agent_template', retry)).content[0].text).toContain('Needs you');
      expect(agent.managed!.blocks).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('rechecks library permission at the template save boundary', async () => {
    const { agent, args } = await fixture();
    const input = await confirmed(args);
    expect((await call('push_agent_template', input)).content[0].text).toContain('Needs you');
    approve();
    state.afterSetupPrepare = async () => {
      await updateAgentGrantChanges('dispatcher', () => ({ changes: [{ action: 'template.write', target: { kind: 'any' }, mode: 'off' }] }));
    };
    expect((await call('push_agent_template', input)).isError).toBe(true);
    expect(agent.managed!.blocks).toEqual([]);
    expect((await managedAgents().getTemplate(args.id)).setup.blocks).toEqual([]);
  });

  it('fails closed for a hidden consumer rather than asking for an empty target', async () => {
    const { agent, args } = await fixture();
    const input = await confirmed(args);
    state.hiddenFromPeek.add(agent.id);
    expect((await call('push_agent_template', input)).isError).toBe(true);
    expect(listGrantRequests('dispatcher')).toEqual([]);
    expect(agent.managed!.blocks).toEqual([]);
  });
});
