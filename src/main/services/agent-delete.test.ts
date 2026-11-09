import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HelperCascadeResult, WorktreeStatus } from '../../shared/types';

const calls: string[] = [];

vi.mock('./agent-config', () => ({
  getDurableConfig: vi.fn(),
  getWorktreeStatus: vi.fn(),
  deleteCommitAndPush: vi.fn(async () => { calls.push('delete:commit-push'); return { ok: true, message: 'Committed and pushed' }; }),
  deleteWithCleanupBranch: vi.fn(async () => { calls.push('delete:cleanup-branch'); return { ok: true, message: 'Cleanup branch pushed' }; }),
  deleteSaveAsPatch: vi.fn(async () => { calls.push('delete:save-patch'); return { ok: true, message: 'Patch saved' }; }),
  deleteForce: vi.fn(async () => { calls.push('delete:force'); return { ok: true, message: 'Force deleted' }; }),
  deleteUnregister: vi.fn(async () => { calls.push('delete:unregister'); return { ok: true, message: 'Removed from agents list (files left on disk)' }; }),
}));
vi.mock('./agent-system', () => ({
  isAgentRunning: vi.fn(() => false),
  killAgent: vi.fn(async (id: string) => { calls.push(`kill:${id}`); }),
}));
vi.mock('./helper-index', () => ({ listHelpersEverywhere: vi.fn(async () => []) }));
vi.mock('./orchestration-policy', () => ({
  settleHelpers: vi.fn(),
  withAgentLock: vi.fn((_p: string, id: string, fn: () => Promise<unknown>) => { calls.push(`lock:${id}`); return fn(); }),
}));
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherPath: (p: string) => p === '/dispatcher',
  isDispatcherIdentityAgentId: (id: string) => id === 'disp',
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import * as agentConfig from './agent-config';
import { isAgentRunning, killAgent } from './agent-system';
import { listHelpersEverywhere } from './helper-index';
import { settleHelpers } from './orchestration-policy';
import { deleteAgent } from './agent-delete';

const PROJECT = '/projects/app';
const OTHER = '/projects/site';
const orchestrator = { id: 'orch', name: 'Lead', color: 'indigo', createdAt: 'x', worktreePath: '/projects/app/.clubhouse/agents/lead', branch: 'lead/standby' };
const helperRows = [
  { projectPath: PROJECT, config: { id: 'h1', name: 'scout', color: 'blue', createdAt: 'x', parentAgentId: 'orch' } },
  { projectPath: OTHER, config: { id: 'h2', name: 'fixer', color: 'red', createdAt: 'x', parentAgentId: 'orch', parentProjectPath: PROJECT } },
];
const clean: WorktreeStatus = { isValid: true, branch: 'lead/standby', uncommittedFiles: [], unpushedCommits: [], hasRemote: true };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(orchestrator as never);
  vi.mocked(agentConfig.getWorktreeStatus).mockResolvedValue(clean);
  vi.mocked(listHelpersEverywhere).mockResolvedValue([]);
  vi.mocked(isAgentRunning).mockReturnValue(false);
  vi.mocked(settleHelpers).mockImplementation(async (_p, _id, choice) => {
    calls.push(`settle:${choice}`);
    return { ok: true, message: choice === 'dispose' ? 'Disposed 2 helper(s)' : 'Kept 2 helper(s)', helperIds: ['h1', 'h2'] };
  });
});

describe('deleteAgent (#3182)', () => {
  it('deletes an agent with no helpers in the chosen mode, under its lock', async () => {
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'force' });
    expect(result).toEqual({ ok: true, message: 'Force deleted', deleted: true });
    expect(calls).toEqual(['lock:orch', 'delete:force']);
    expect(settleHelpers).not.toHaveBeenCalled();
  });

  it('without a helper choice, lists the helpers and changes nothing', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValue(helperRows as never);
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'force' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Lead has 2 helpers. Choose whether to dispose or keep them.');
    expect(result.needsHelperChoice).toEqual({ helpers: [{ id: 'h1', name: 'scout' }, { id: 'h2', name: 'fixer' }] });
    expect(calls).toEqual(['lock:orch']);
  });

  it('dispose: disposes the helpers in every project, then stops and deletes the orchestrator', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValue(helperRows as never);
    vi.mocked(isAgentRunning).mockReturnValue(true);
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
    expect(result).toEqual({
      ok: true, message: 'Force deleted', deleted: true,
      helpers: { ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'] },
    });
    expect(listHelpersEverywhere).toHaveBeenCalledWith(PROJECT, 'orch', { recursive: true });
    expect(settleHelpers).toHaveBeenCalledWith(PROJECT, 'orch', 'dispose', undefined);
    expect(killAgent).toHaveBeenCalledWith('orch', PROJECT, undefined, 'user', { waitForExit: true });
    expect(calls).toEqual(['lock:orch', 'settle:dispose', 'kill:orch', 'delete:force']);
  });

  it('dispose: helpers with work at risk stop it before the orchestrator is touched', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValue(helperRows as never);
    vi.mocked(isAgentRunning).mockReturnValue(true);
    const blocked: HelperCascadeResult = {
      ok: false,
      message: 'scout has work that disposing would lose, or couldn\'t be checked',
      blocked: [{ agentId: 'h1', name: 'scout', checks: { dirty: 3, unpushed: 0, unmerged: 0 } }],
    };
    vi.mocked(settleHelpers).mockResolvedValueOnce(blocked);
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
    expect(result).toEqual({ ok: false, message: blocked.message, helpers: blocked });
    expect(killAgent).not.toHaveBeenCalled();
    expect(agentConfig.deleteForce).not.toHaveBeenCalled();
  });

  it('dispose: a helper that failed part way keeps the orchestrator', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValue(helperRows as never);
    const partial: HelperCascadeResult = {
      ok: false, message: 'Disposed 1 of 2 helpers', helperIds: ['h2'],
      failed: [{ agentId: 'h1', name: 'scout', reason: 'EBUSY' }],
    };
    vi.mocked(settleHelpers).mockResolvedValueOnce(partial);
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
    expect(result).toEqual({ ok: false, message: 'Disposed 1 of 2 helpers', helpers: partial });
    expect(agentConfig.deleteForce).not.toHaveBeenCalled();
  });

  it('passes forceHelpers through to the dispose', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValue(helperRows as never);
    await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose', forceHelpers: true });
    expect(settleHelpers).toHaveBeenCalledWith(PROJECT, 'orch', 'dispose', true);
  });

  it('keep: releases the helpers, then deletes', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValue(helperRows as never);
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'unregister', helpers: 'keep' });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['lock:orch', 'settle:keep', 'delete:unregister']);
  });

  it('save-patch writes to the given file', async () => {
    await deleteAgent(PROJECT, 'orch', { mode: 'save-patch', savePath: '/tmp/lead.patch' });
    expect(agentConfig.deleteSaveAsPatch).toHaveBeenCalledWith(PROJECT, 'orch', '/tmp/lead.patch');
  });

  it('refuses save-patch with no file, an unknown mode, the Dispatcher, and a missing agent without changing anything', async () => {
    expect(await deleteAgent(PROJECT, 'orch', { mode: 'save-patch' })).toEqual({ ok: false, message: 'save-patch needs a file to save to' });
    expect((await deleteAgent(PROJECT, 'orch', { mode: 'shred' as never })).message).toMatch(/Unknown delete mode/);
    expect(await deleteAgent('/dispatcher', 'x', { mode: 'force' })).toEqual({ ok: false, message: 'The Dispatcher can\'t be deleted.' });
    expect(await deleteAgent(PROJECT, 'disp', { mode: 'force' })).toEqual({ ok: false, message: 'The Dispatcher can\'t be deleted.' });
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce(undefined as never);
    expect(await deleteAgent(PROJECT, 'gone', { mode: 'force' })).toEqual({ ok: false, message: 'Agent not found' });
    expect(calls.filter((c) => !c.startsWith('lock:'))).toEqual([]);
  });

  describe('checkWorktree: callers with no dialog', () => {
    const dirty: WorktreeStatus = {
      ...clean,
      uncommittedFiles: [{ path: 'src/a.ts', status: 'M', staged: false }],
      unpushedCommits: [{ hash: 'h', shortHash: 'h', subject: 'wip', author: 'a', date: 'd' }],
    };

    it('refuses to remove a worktree with unsaved work before the helpers are touched', async () => {
      vi.mocked(listHelpersEverywhere).mockResolvedValue(helperRows as never);
      vi.mocked(agentConfig.getWorktreeStatus).mockResolvedValue(dirty);
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose', checkWorktree: true });
      expect(result.ok).toBe(false);
      expect(result.message).toBe('Lead\'s worktree has unsaved work that deleting it would lose. Nothing was changed.');
      expect(result.worktree).toBe(dirty);
      expect(settleHelpers).not.toHaveBeenCalled();
      expect(agentConfig.deleteForce).not.toHaveBeenCalled();
    });

    it('forceWorktree deletes it anyway', async () => {
      vi.mocked(agentConfig.getWorktreeStatus).mockResolvedValue(dirty);
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', checkWorktree: true, forceWorktree: true });
      expect(result.ok).toBe(true);
      expect(agentConfig.deleteForce).toHaveBeenCalled();
    });

    it('a check that couldn\'t run refuses even with forceWorktree', async () => {
      vi.mocked(agentConfig.getWorktreeStatus).mockResolvedValue({ ...clean, checkError: 'git couldn\'t read it: fatal: bad object' });
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', checkWorktree: true, forceWorktree: true });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/couldn't be checked .* even with force/);
      expect(agentConfig.deleteForce).not.toHaveBeenCalled();
    });

    it('leaving the files on disk needs no check', async () => {
      vi.mocked(agentConfig.getWorktreeStatus).mockResolvedValue(dirty);
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'unregister', checkWorktree: true });
      expect(result.ok).toBe(true);
      expect(agentConfig.getWorktreeStatus).not.toHaveBeenCalled();
    });
  });
});
