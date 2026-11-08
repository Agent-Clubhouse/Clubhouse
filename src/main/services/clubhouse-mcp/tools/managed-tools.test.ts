import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';

const state = vi.hoisted(() => ({
  base: '',
  agents: new Map<string, DurableAgentConfig>(),
  running: new Set<string>(),
  restartOrigins: [] as string[],
}));

vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../dispatcher-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => id === 'dispatcher',
}));
vi.mock('../../project-store', () => ({ peekProjects: async () => [{ id: 'p1', name: 'Clubhouse', path: '/proj' }] }));
vi.mock('../../agent-config', () => ({
  listDurable: async () => [...state.agents.values()],
  getDurableConfig: async (_p: string, id: string) => state.agents.get(id) ?? null,
  createDurable: async (_p: string, name: string, color: string, model?: string, _worktree?: boolean, orchestrator?: string) => {
    const a: DurableAgentConfig = { id: `new-${name}`, name, color, createdAt: '', worktreePath: `/w/${name}`, ...(model && { model }), ...(orchestrator && { orchestrator: orchestrator as never }) };
    state.agents.set(a.id, a);
    return a;
  },
  deleteUnregister: async (_p: string, id: string) => { state.agents.delete(id); },
}));
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
import { getAgentGrantChanges } from '../../agent-grants-store';

const call = async (name: string, args: Record<string, unknown>, caller = 'dispatcher') => {
  const r = await callTool(caller, name, args);
  return { ...r, json: (() => { try { return JSON.parse(r.content[0].text ?? 'null'); } catch { return null; } })() };
};

beforeEach(async () => {
  state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-tools-'));
  state.agents = new Map();
  state.running = new Set();
  state.restartOrigins = [];
  vi.mocked(restartManagedAgent).mockClear();
  _resetSettingsAuditForTesting(false);
  _resetForTesting();
  _resetConfirmTokensForTesting();
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
    expect(managed.json).toMatchObject({ name: 'builder-made', managed: true, status: 'sleeping' });
    expect(state.agents.get(managed.json.id)!.managed).toMatchObject({ updatedBy: 'Dispatcher' });
    const plain = await call('create_managed_agent', { project: 'Clubhouse', name: 'plain-one', managed: false, settings: { model: 'opus' } });
    expect(plain.json).toMatchObject({ name: 'plain-one', managed: false, status: 'sleeping' });
    expect(state.agents.get(plain.json.id)!.managed).toBeUndefined();
    expect(state.agents.get(plain.json.id)!.model).toBe('opus');
    const mixed = await call('create_managed_agent', { project: 'Clubhouse', name: 'mixed', managed: false, templateId: 'builtin-template-helper' });
    expect(mixed.isError).toBe(true);
    expect(state.agents.has('new-mixed')).toBe(false);
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
