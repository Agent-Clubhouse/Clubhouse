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
}));

vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../agent-system', async (original) => ({
  ...await original<typeof import('../../agent-system')>(),
  resolveOrchestrator: async (_projectPath: string, cli?: string) => ({
    id: cli ?? 'claude-code',
    displayName: 'Test CLI',
    checkAvailability: async () => ({ available: state.available }),
    conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md' },
  }),
}));
vi.mock('../dispatcher-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => id === 'dispatcher',
}));
vi.mock('../../project-store', () => ({ peekProjects: async () => [{ id: 'p1', name: 'Clubhouse', path: '/proj' }] }));
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
  setOrchestrationConfig: async (_p: string, id: string, policy: DurableAgentConfig['orchestration']) => {
    state.agents.get(id)!.orchestration = policy;
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
vi.mock('../../managed-agents', async () => {
  const { createManagedAgentsService } = await import('../../managed-agents/service');
  const { createAssetCatalogStore } = await import('../../asset-catalog/store');
  const { createManagedStateStore } = await import('../../managed-agents/state-store');
  let svc: ReturnType<typeof createManagedAgentsService> | null = null;
  return {
    managedAgents: () => {
      svc ??= createManagedAgentsService({
        catalog: createAssetCatalogStore({ dir: path.join(state.base, 'catalog') }),
        state: createManagedStateStore(path.join(state.base, 'managed')),
        listProjects: async () => [{ path: '/proj', name: 'Clubhouse' }],
        listAgents: async () => [...state.agents.values()],
        getAgent: async (_p, id) => state.agents.get(id) ?? null,
        setManagedSetup: async (_p, id, setup) => { const a = state.agents.get(id)!; if (setup) a.managed = setup; else delete a.managed; },
        isRunning: (id) => state.running.has(id),
      });
      return svc;
    },
    statusFor: async (_p: string, id: string) => ({ managed: !!state.agents.get(id)?.managed, running: state.running.has(id), waiting: false, changes: [], cliChanged: false }),
    restartManagedAgent: vi.fn(async () => {
      // What the restart (and its spawn) runs under: never the Dispatcher's write grant.
      const { currentSettingsOrigin } = await import('../../settings-audit');
      state.restartOrigins.push(currentSettingsOrigin().surface);
      return { resumed: true };
    }),
  };
});

import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { CONFIRM_TTL_MS, registerManagedTools, _resetConfirmTokensForTesting } from './managed-tools';
import { managedAgents, restartManagedAgent } from '../../managed-agents';
import { _resetSettingsAuditForTesting } from '../../settings-audit';
import { CLUBHOUSE_MCP_PART_ID, CLUBHOUSE_PART_ALWAYS_ON } from '../../../../shared/managed-agents-types';
import { BUILTIN_BLOCK_IDS } from '../../managed-agents/builtins';
import { getAgentGrantChanges, updateAgentGrantChanges } from '../../agent-grants-store';
import { deleteAgent } from '../../agent-delete';
import { agentRegistry } from '../../agent-registry';
import { listGrantRequests, takeGrantRequest, _resetGrantRequestsForTesting } from '../../grant-requests';
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
    const set = await call('set_agent_setup', { project: 'Clubhouse', agent: 'release-lead', blocks: ['builtin-block-identity'], skills: [], mcps: [] });
    expect(set.json).toMatchObject({ blocks: ['builtin-block-identity'], mcps: [CLUBHOUSE_MCP_PART_ID], note: CLUBHOUSE_PART_ALWAYS_ON });
    expect(state.agents.get('a')!.managed!.blocks).toEqual(['builtin-block-identity']);
    expect(state.agents.get('a')!.managed!.mcps).toEqual([CLUBHOUSE_MCP_PART_ID]);
    // Naming it gives no note.
    const kept = await call('set_agent_setup', { project: 'Clubhouse', agent: 'release-lead', blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    expect(kept.json).not.toHaveProperty('note');
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
        status: 'pushed', applied: 0, failed: [{ agentId: target.id, message: expect.stringContaining('connection.bootstrap') }],
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
    expect(restartManagedAgent).toHaveBeenLastCalledWith('/proj', 'worker', { fresh: undefined, whenTurnEnds: true });
    await call('restart_agent', { project: 'Clubhouse', agent: 'worker', now: true, fresh: true });
    expect(restartManagedAgent).toHaveBeenLastCalledWith('/proj', 'worker', { fresh: true, whenTurnEnds: false });
    expect(state.restartOrigins).toEqual(['mcp', 'mcp']);
  });

  it('says when there was no conversation to resume', async () => {
    managedAgent('newbie');
    state.running.add('newbie');
    vi.mocked(restartManagedAgent).mockResolvedValueOnce({ resumed: false, noSession: true });
    expect((await call('restart_agent', { project: 'Clubhouse', agent: 'newbie', now: true })).json).toEqual({
      status: 'restarted', resumed: false, note: 'There was no conversation to resume, so it started a new one.',
    });
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
