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

  it('push keeps the template\'s settings when the call leaves them out', async () => {
    const t = (await call('save_agent_template', { name: 'Settings stay', blocks: [], mcps: [CLUBHOUSE_MCP_PART_ID], settings: { model: 'opus', orchestration: { maxHelpers: 2 } } })).json;
    const preview = await call('push_agent_template', { id: t.id, blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] });
    expect(preview.json.changes).toEqual([expect.objectContaining({ kind: 'add', id: BUILTIN_BLOCK_IDS.identity })]);
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
