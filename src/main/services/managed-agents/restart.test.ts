import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
const instructionsPattern = vi.hoisted(() => vi.fn(async (): Promise<string | null> => '/CLAUDE.md'));
vi.mock('./delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery')>()),
  deliverManagedSetup: deliver,
  instructionsExcludePattern: instructionsPattern,
}));
const replaceExclusions = vi.hoisted(() => vi.fn(async () => {}));
const removeExclusions = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../git-exclude-manager', () => ({ addExclusions: vi.fn(async () => {}), replaceExclusions, removeExclusions }));
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

describe('the managed exclude block (D16)', () => {
  const provider = { id: 'claude-code', conventions: { configDir: '.claude', skillsDir: 'skills', mcpConfigFile: '.mcp.json', legacyInstructionsFile: 'CLAUDE.md', localSettingsFile: 'settings.local.json' } } as unknown as OrchestratorProvider;

  beforeEach(() => {
    replaceExclusions.mockClear();
    removeExclusions.mockClear();
    instructionsPattern.mockClear();
  });

  it('lists only what Clubhouse alone writes: never the root files a person may have too (D76)', async () => {
    add('excl', true);
    const agent = state.agents.get('excl')!;
    await deliverForSpawn('/p', agent, provider);
    await vi.waitFor(() => expect(replaceExclusions).toHaveBeenCalledTimes(1));
    const [, tag, patterns] = replaceExclusions.mock.calls[0] as unknown as [string, string, string[]];
    expect(tag).toBe('clubhouse-managed-claude-code');
    // No skills delivered in this worktree, so only Clubhouse's own bookkeeping files.
    expect(patterns).toEqual(['/.clubhouse-managed-excludes.json', '/.clubhouse-before-managed/']);
    for (const rootFile of ['CLAUDE.md', '/CLAUDE.md', '.mcp.json', '.claude/settings.local.json']) expect(patterns).not.toContain(rootFile);
    expect(instructionsPattern).not.toHaveBeenCalled();
    // The dead old-format blocks are cleaned up.
    await vi.waitFor(() => expect(removeExclusions.mock.calls.map((c) => (c as unknown as [string, string])[1]).sort()).toEqual(['clubhouse-managed-backup', 'clubhouse-mode']));
  });

  /** A worktree with a managed-skills manifest listing `names` in each of `roots`. */
  function worktreeWith(roots: Record<string, string[]>): string {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-excludes-'));
    for (const [rel, names] of Object.entries(roots)) {
      fs.mkdirSync(path.join(wt, rel), { recursive: true });
      fs.writeFileSync(path.join(wt, rel, '.clubhouse-managed-skills.json'), JSON.stringify({ skills: names }));
    }
    return wt;
  }

  it('excludes exactly the skill folders Clubhouse delivered, across the project\'s managed agents (D73)', async () => {
    add('one', true);
    add('two', true);
    add('plain', false);
    state.agents.get('one')!.worktreePath = worktreeWith({ '.claude/skills': ['build', 'test'] });
    state.agents.get('two')!.worktreePath = worktreeWith({ '.claude/skills': ['notes', 'build', '../escape', '*'] });
    state.agents.get('plain')!.worktreePath = worktreeWith({ '.claude/skills': ['theirs'] });
    await deliverForSpawn('/p', state.agents.get('one')!, provider);
    await vi.waitFor(() => expect(replaceExclusions).toHaveBeenCalledTimes(1));
    const [, , patterns] = replaceExclusions.mock.calls[0] as unknown as [string, string, string[]];
    expect(patterns.filter((p) => p.includes('skills'))).toEqual([
      '/.claude/skills/.clubhouse-managed-skills.json', '/.claude/skills/build/', '/.claude/skills/notes/', '/.claude/skills/test/',
    ]);
  });

  it('excludes Codex\'s delivered .agents/skills folders, and the old .codex/skills ones until that folder is cleaned up', async () => {
    add('excl-codex', true);
    add('later', true);
    state.agents.get('excl-codex')!.worktreePath = worktreeWith({ '.agents/skills': ['build'] });
    // Not started since the move: its old delivery is still there.
    state.agents.get('later')!.worktreePath = worktreeWith({ '.codex/skills': ['ship'] });
    const codex = { id: 'codex-cli', conventions: { configDir: '.codex', skillsDir: 'skills', skillsRoot: '.agents/skills', previousSkillsRoots: ['.codex/skills'], mcpConfigFile: '.codex/config.toml', legacyInstructionsFile: 'AGENTS.md', localSettingsFile: 'config.toml' } } as unknown as OrchestratorProvider;
    await deliverForSpawn('/p', state.agents.get('excl-codex')!, codex);
    await vi.waitFor(() => expect(replaceExclusions).toHaveBeenCalledTimes(1));
    const [, tag, patterns] = replaceExclusions.mock.calls[0] as unknown as [string, string, string[]];
    expect(tag).toBe('clubhouse-managed-codex-cli');
    expect(patterns.filter((p) => p.includes('skills'))).toEqual([
      '/.agents/skills/.clubhouse-managed-skills.json', '/.agents/skills/build/',
      '/.codex/skills/.clubhouse-managed-skills.json', '/.codex/skills/ship/',
    ]);
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
