import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';

const state = vi.hoisted(() => ({ base: '', agents: new Map<string, DurableAgentConfig>() }));

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
        isRunning: () => false,
      });
      return svc;
    },
    statusFor: async () => ({ managed: true, running: false, waiting: false, changes: [], cliChanged: false }),
    restartManagedAgent: vi.fn(async () => ({ resumed: true })),
  };
});

import { callTool, _resetForTesting } from '../tool-registry';
import { registerManagedTools } from './managed-tools';
import { managedAgents } from '../../managed-agents';
import { _resetSettingsAuditForTesting } from '../../settings-audit';

const call = async (name: string, args: Record<string, unknown>, caller = 'dispatcher') => {
  const r = await callTool(caller, name, args);
  return { ...r, json: (() => { try { return JSON.parse(r.content[0].text ?? 'null'); } catch { return null; } })() };
};

beforeEach(async () => {
  state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-tools-'));
  state.agents = new Map();
  _resetSettingsAuditForTesting(false);
  _resetForTesting();
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
    const wrong = await call('update_agent_part', { ...args, confirm: 'nope' });
    expect(wrong.json.status).toBe('needs_confirmation');
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
    expect(set.json).toMatchObject({ blocks: ['builtin-block-identity'] });
    expect(state.agents.get('a')!.managed!.blocks).toEqual(['builtin-block-identity']);
  });

  it('says plainly when the project or agent is unknown', async () => {
    const r = await call('get_agent_setup', { project: 'Nope', agent: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No registered project matches/);
  });
});
