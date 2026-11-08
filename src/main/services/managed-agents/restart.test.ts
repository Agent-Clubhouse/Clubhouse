import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../../shared/types';

const state = vi.hoisted(() => ({ agents: new Map<string, DurableAgentConfig>(), running: new Set<string>() }));
const spawnAgent = vi.hoisted(() => vi.fn(async () => undefined));
const killAgent = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../project-store', () => ({ peekProjects: async () => [] }));
vi.mock('../agent-config', () => ({
  getDurableConfig: async (_p: string, id: string) => state.agents.get(id) ?? null,
  peekDurableConfigs: async () => [...state.agents.values()],
  setManagedSetup: async () => undefined,
}));
const deliver = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('./delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery')>()),
  deliverManagedSetup: deliver,
}));
const queueExcludes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./git-excludes', () => ({ queueManagedExcludes: queueExcludes }));
vi.mock('../agent-system', () => ({
  isAgentRunning: (id: string) => state.running.has(id),
  killAgent,
  spawnAgent,
}));

import { deliverForSpawn, forgetDelivery, recordMcpStartProblems, restartManagedAgent, statusFor } from './index';
import type { OrchestratorProvider } from '../../orchestrators/types';

function add(id: string, managed: boolean): void {
  state.agents.set(id, {
    id, name: id, color: 'indigo', createdAt: '', worktreePath: `/w/${id}`,
    ...(managed && { managed: { version: 1, blocks: [], skills: [], mcps: [] } }),
  });
}

beforeEach(() => {
  state.agents.clear();
  state.running.clear();
  spawnAgent.mockClear();
  killAgent.mockClear();
});

describe('restartManagedAgent', () => {
  it('refuses an agent that isn\'t managed, even when it is running', async () => {
    add('plain', false);
    state.running.add('plain');
    await expect(restartManagedAgent('/p', 'plain')).rejects.toMatchObject({ code: 'not_managed' });
    expect(killAgent).not.toHaveBeenCalled();
  });

  it('never starts a sleeping agent', async () => {
    add('sleepy', true);
    await expect(restartManagedAgent('/p', 'sleepy')).rejects.toThrow(/isn't running/);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it('stops and starts a running managed agent', async () => {
    add('worker', true);
    state.running.add('worker');
    await restartManagedAgent('/p', 'worker', { fresh: true });
    expect(killAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'worker', resume: false }));
  });
});

describe('restart outcome (#2819)', () => {
  it('says when there was no conversation to resume', async () => {
    add('fresh-one', true);
    state.running.add('fresh-one');
    expect(await restartManagedAgent('/p', 'fresh-one')).toEqual({ resumed: false, noSession: true });
  });

  it('resumes when there is a session, and asking for fresh is not a surprise', async () => {
    add('resumer', true);
    state.agents.get('resumer')!.lastSessionId = 's1';
    state.running.add('resumer');
    expect(await restartManagedAgent('/p', 'resumer')).toEqual({ resumed: true });
    expect(await restartManagedAgent('/p', 'resumer', { fresh: true })).toEqual({ resumed: false });
  });
});

describe('delivery failure status (#2819)', () => {
  const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', localSettingsFile: 'settings.local.json' } } as unknown as OrchestratorProvider;

  it('reports a failed delivery as waiting with the reason until a delivery succeeds', async () => {
    add('broken', true);
    state.running.add('broken');
    deliver.mockRejectedValueOnce(new Error('disk full'));
    await expect(deliverForSpawn('/p', state.agents.get('broken')!, provider)).rejects.toThrow('disk full');
    expect(await statusFor('/p', 'broken')).toMatchObject({
      waiting: true, deliveryFailed: 'disk full', changes: ["Setup couldn't be written: disk full"],
    });
    deliver.mockResolvedValueOnce(null);
    await deliverForSpawn('/p', state.agents.get('broken')!, provider);
    expect(await statusFor('/p', 'broken')).toMatchObject({ waiting: false });
    expect((await statusFor('/p', 'broken')).deliveryFailed).toBeUndefined();
  });
});

describe('a setup saved before the Clubhouse MCP part was required (D69)', () => {
  const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json' }, writeInstructions: async () => {} } as unknown as OrchestratorProvider;

  it('shows no changes waiting after a start, before or after its first save adds the part', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createAssetCatalogStore } = await import('../asset-catalog/store');
    const { createManagedStateStore } = await import('./state-store');
    const { createManagedAgentsService } = await import('./service');
    const { _setManagedAgentsForTesting } = await import('./index');
    const { _resetSettingsAuditForTesting } = await import('../settings-audit');
    const { CLUBHOUSE_MCP_PART_ID } = await import('../../../shared/managed-agents-types');
    const actual = await vi.importActual<typeof import('./delivery')>('./delivery');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-old-setup-'));
    _resetSettingsAuditForTesting(false);
    const svc = createManagedAgentsService({
      catalog: createAssetCatalogStore({ dir: path.join(root, 'catalog') }),
      state: createManagedStateStore(path.join(root, 'managed')),
      listProjects: async () => [],
      listAgents: async () => [],
      getAgent: async (_p, id) => state.agents.get(id) ?? null,
      setManagedSetup: async () => undefined,
      isRunning: (id) => state.running.has(id),
    });
    await svc.ensureBuiltins();
    _setManagedAgentsForTesting(svc);
    try {
      const worktreePath = path.join(root, 'wt');
      fs.mkdirSync(worktreePath);
      state.agents.set('old', { id: 'old', name: 'old', color: 'indigo', createdAt: '', worktreePath, managed: { version: 1, blocks: [], skills: [], mcps: [] } });
      state.running.add('old');
      deliver.mockImplementationOnce(actual.deliverManagedSetup as never);
      await deliverForSpawn('/p', state.agents.get('old')!, provider);
      expect(await statusFor('/p', 'old')).toMatchObject({ waiting: false, changes: [] });
      // The first save writes the part in; the session still has what it needs.
      state.agents.get('old')!.managed = { version: 1, blocks: [], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] };
      expect(await statusFor('/p', 'old')).toMatchObject({ waiting: false, changes: [] });
    } finally {
      _setManagedAgentsForTesting(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the managed exclude block (D16, D97)', () => {
  it('refreshes the project\'s blocks after every delivery', async () => {
    add('excl', true);
    queueExcludes.mockClear();
    const provider = { id: 'claude-code', conventions: {} } as unknown as OrchestratorProvider;
    await deliverForSpawn('/p', state.agents.get('excl')!, provider);
    expect(queueExcludes).toHaveBeenCalledWith('/p');
  });
});

describe('MCP start problems in the status (#2896, D95)', () => {
  it('reports what a running session\'s servers lack, by name, and forgets it when the agent stops', async () => {
    add('mcp-user', true);
    state.running.add('mcp-user');
    recordMcpStartProblems('mcp-user', [{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }]);
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toEqual([{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }]);
    state.running.delete('mcp-user');
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toBeUndefined();
    state.running.add('mcp-user');
    recordMcpStartProblems('mcp-user', []);
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toBeUndefined();
    recordMcpStartProblems('mcp-user', [{ server: 'jira', missingEnv: ['JIRA_URL'] }]);
    forgetDelivery('mcp-user');
    expect((await statusFor('/p', 'mcp-user')).mcpProblems).toBeUndefined();
  });
});
