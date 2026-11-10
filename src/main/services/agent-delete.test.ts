import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const registrations = vi.hoisted(() => new Map<string, { projectPath: string; cwd?: string }>());
vi.mock('./agent-registry', () => ({ agentRegistry: { getAllRegistrations: () => registrations } }));
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
const gate = vi.hoisted(() => ({ open: new Map<string, { crossProject: boolean; control?: string }>() }));
vi.mock('./clubhouse-mcp/orchestration-gate', () => ({
  isOrchestrationEnabled: (id: string) => gate.open.has(id),
  isCrossProjectEnabled: (id: string) => gate.open.get(id)?.crossProject === true,
  orchestrationControl: (id: string) => gate.open.get(id)?.control,
  setOrchestrationEnabled: vi.fn((id: string, on: boolean, o: { crossProject?: boolean; control?: string } = {}) => {
    if (on) gate.open.set(id, { crossProject: !!o.crossProject, ...(o.control && { control: o.control }) });
    else gate.open.delete(id);
  }),
}));

import * as agentConfig from './agent-config';
import { isAgentRunning, killAgent } from './agent-system';
import { listHelpersEverywhere } from './helper-index';
import { settleHelpers } from './orchestration-policy';
import { deleteAgent, isDeleteRefusal } from './agent-delete';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import type { Classification, TelemetryRuntime } from '../telemetry/types';
import { ATTR } from '../../shared/telemetry/attributes';

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
  registrations.clear();
  gate.open.clear();
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
    vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'force' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Lead has 2 helpers. Choose whether to dispose or keep them.');
    expect(result.needsHelperChoice).toEqual({ helpers: [{ id: 'h1', name: 'scout' }, { id: 'h2', name: 'fixer' }] });
    expect(calls).toEqual(['lock:orch']);
  });

  it('dispose: disposes the helpers in every project, then stops and deletes the orchestrator', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
    vi.mocked(isAgentRunning).mockReturnValue(true);
    const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
    expect(result).toEqual({
      ok: true, message: 'Force deleted', deleted: true,
      helpers: { ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'] },
    });
    expect(listHelpersEverywhere).toHaveBeenCalledWith(PROJECT, 'orch', { recursive: true });
    expect(settleHelpers).toHaveBeenCalledWith(PROJECT, 'orch', 'dispose', undefined);
    expect(killAgent).toHaveBeenCalledWith('orch', PROJECT, undefined, 'user', { waitForExit: true, throwOnFailure: true });
    expect(calls).toEqual(['lock:orch', 'settle:dispose', 'kill:orch', 'delete:force']);
  });

  it('a stop that fails throws before anything is deleted, and the gate opens again (#3199)', async () => {
    gate.open.set('orch', { crossProject: false });
    vi.mocked(isAgentRunning).mockReturnValue(true);
    vi.mocked(killAgent).mockRejectedValueOnce(new Error('Timed out waiting for agent exit'));
    await expect(deleteAgent(PROJECT, 'orch', { mode: 'force' })).rejects.toThrow('Timed out waiting for agent exit');
    expect(agentConfig.deleteForce).not.toHaveBeenCalled();
    expect(gate.open.has('orch')).toBe(true);
  });

  it('dispose: helpers with work at risk stop it before the orchestrator is touched', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
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
    vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
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
    vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
    await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose', forceHelpers: true });
    expect(settleHelpers).toHaveBeenCalledWith(PROJECT, 'orch', 'dispose', true);
  });

  it('keep: releases the helpers, then deletes', async () => {
    vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
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

  describe('quick agents in its worktree', () => {
    const wt = orchestrator.worktreePath;
    beforeEach(() => {
      registrations.set('quick_1_child', { projectPath: PROJECT, cwd: wt });
      registrations.set('quick_2_nested', { projectPath: PROJECT, cwd: `${wt}/packages/web` });
      registrations.set('quick_3_root', { projectPath: PROJECT, cwd: PROJECT });
      registrations.set('quick_4_sibling', { projectPath: PROJECT, cwd: `${wt}-other` });
      registrations.set('quick_5_exited', { projectPath: PROJECT, cwd: wt });
      registrations.set('durable_6_inside', { projectPath: PROJECT, cwd: wt });
      vi.mocked(isAgentRunning).mockImplementation((id: string) => id !== 'quick_5_exited');
    });

    it('stops the running ones before the agent, waiting for each to exit, and says which', async () => {
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force' });
      expect(calls).toEqual(['lock:orch', 'kill:quick_1_child', 'kill:quick_2_nested', 'kill:orch', 'delete:force']);
      expect(killAgent).toHaveBeenCalledWith('quick_1_child', PROJECT, undefined, 'user', { waitForExit: true });
      expect(result.stoppedQuickAgents).toEqual(['quick_1_child', 'quick_2_nested']);
    });

    it('stops them when the files stay on disk too, as the dialog does', async () => {
      await deleteAgent(PROJECT, 'orch', { mode: 'unregister' });
      expect(calls).toEqual(['lock:orch', 'kill:quick_1_child', 'kill:quick_2_nested', 'kill:orch', 'delete:unregister']);
    });

    it('leaves them running when the helpers stop the delete', async () => {
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
      vi.mocked(settleHelpers).mockResolvedValueOnce({ ok: false, message: 'blocked', blocked: [] });
      await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      expect(killAgent).not.toHaveBeenCalled();
    });

    it('stops none for an agent with no worktree', async () => {
      vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce({ ...orchestrator, worktreePath: undefined } as never);
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'unregister' });
      expect(calls).toEqual(['lock:orch', 'kill:orch', 'delete:unregister']);
      expect(result.stoppedQuickAgents).toBeUndefined();
    });
  });

  describe('checkWorktree: callers with no dialog', () => {
    const dirty: WorktreeStatus = {
      ...clean,
      uncommittedFiles: [{ path: 'src/a.ts', status: 'M', staged: false }],
      unpushedCommits: [{ hash: 'h', shortHash: 'h', subject: 'wip', author: 'a', date: 'd' }],
    };

    it('refuses to remove a worktree with unsaved work before the helpers are touched', async () => {
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
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

  describe('the orchestration gate while helpers settle', () => {
    beforeEach(() => {
      gate.open.set('orch', { crossProject: true, control: 'ask-before-start' });
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
    });

    it('is closed while the helpers settle, so it can\'t start another, and stays closed once it is deleted', async () => {
      let openDuringSettle: boolean | undefined;
      vi.mocked(settleHelpers).mockImplementationOnce(async () => {
        openDuringSettle = gate.open.has('orch');
        return { ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'] };
      });
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      expect(result.ok).toBe(true);
      expect(openDuringSettle).toBe(false);
      expect(gate.open.has('orch')).toBe(false);
    });

    it('opens again, as it was, when the helpers stop the delete', async () => {
      vi.mocked(settleHelpers).mockResolvedValueOnce({ ok: false, message: 'blocked', blocked: [{ agentId: 'h1', name: 'scout', checks: { dirty: 1, unpushed: 0, unmerged: 0 } }] });
      await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      expect(gate.open.get('orch')).toEqual({ crossProject: true, control: 'ask-before-start' });
    });

    it('opens again when the delete itself fails or throws', async () => {
      vi.mocked(agentConfig.deleteForce).mockResolvedValueOnce({ ok: false, message: 'locked' });
      await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      expect(gate.open.has('orch')).toBe(true);
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
      vi.mocked(settleHelpers).mockRejectedValueOnce(new Error('git died'));
      await expect(deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' })).rejects.toThrow('git died');
      expect(gate.open.has('orch')).toBe(true);
    });

    it('settles a helper whose start was already under way when the gate closed', async () => {
      vi.mocked(listHelpersEverywhere).mockReset();
      vi.mocked(listHelpersEverywhere)
        .mockResolvedValueOnce(helperRows as never)
        .mockResolvedValueOnce([{ projectPath: PROJECT, config: { id: 'h3', name: 'late', color: 'teal', createdAt: 'x', parentAgentId: 'orch' } }] as never)
        .mockResolvedValue([]);
      vi.mocked(settleHelpers)
        .mockResolvedValueOnce({ ok: true, message: 'Disposed 2 helper(s)', helperIds: ['h1', 'h2'] })
        .mockResolvedValueOnce({ ok: true, message: 'Disposed 1 helper(s)', helperIds: ['h3'] });
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      expect(settleHelpers).toHaveBeenCalledTimes(2);
      expect(result.helpers?.helperIds).toEqual(['h1', 'h2', 'h3']);
      expect(result.ok).toBe(true);
    });
  });

  describe('work written after the first worktree check', () => {
    const dirty: WorktreeStatus = { ...clean, uncommittedFiles: [{ path: 'notes.md', status: '??', staged: false }] };

    beforeEach(() => {
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
      registrations.set('quick_1_child', { projectPath: PROJECT, cwd: orchestrator.worktreePath });
      vi.mocked(isAgentRunning).mockReturnValue(true);
      // Clean before anything stops; the agent wrote a file while it stopped.
      vi.mocked(agentConfig.getWorktreeStatus).mockResolvedValueOnce(clean).mockResolvedValueOnce(dirty);
    });

    it('refuses with the facts once everything has stopped, and loses nothing', async () => {
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose', checkWorktree: true });
      expect(result.ok).toBe(false);
      expect(result.message).toBe('Lead\'s worktree has unsaved work that deleting it would lose. Its helpers were settled and it was stopped, but nothing was deleted.');
      expect(result.worktree).toBe(dirty);
      expect(result.helpers).toMatchObject({ ok: true, helperIds: ['h1', 'h2'] });
      expect(result.stoppedQuickAgents).toEqual(['quick_1_child']);
      expect(calls).toEqual(['lock:orch', 'settle:dispose', 'kill:quick_1_child', 'kill:orch']);
      expect(agentConfig.getWorktreeStatus).toHaveBeenCalledTimes(2);
      expect(agentConfig.deleteForce).not.toHaveBeenCalled();
      expect(isDeleteRefusal(result)).toBe(true);
    });

    it('deletes anyway with forceWorktree', async () => {
      const result = await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose', checkWorktree: true, forceWorktree: true });
      expect(result.ok).toBe(true);
      expect(agentConfig.deleteForce).toHaveBeenCalled();
    });

    it('isn\'t checked again for a caller with a dialog, who chose already', async () => {
      await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      expect(agentConfig.getWorktreeStatus).not.toHaveBeenCalled();
      expect(agentConfig.deleteForce).toHaveBeenCalled();
    });
  });

  describe('telemetry: one clubhouse.agent.delete flow per call', () => {
    type Flow = { name: string; attrs: unknown[]; outcome?: Classification };
    let flows: Flow[];
    beforeEach(() => {
      flows = [];
      setProducingRuntime({
        level: 'standard',
        flow: (name: string, opts: { attrs?: unknown[] }, fn: () => unknown, extras?: { classify?: (r: unknown) => Classification }) => {
          const f: Flow = { name, attrs: [...(opts.attrs ?? [])] };
          flows.push(f);
          return Promise.resolve(fn()).then((r) => { f.outcome = extras?.classify ? extras.classify(r) : 'ok'; return r; });
        },
        step: (_n: string, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
        count: vi.fn(),
      } as unknown as TelemetryRuntime);
    });
    afterEach(() => setProducingRuntime(null));

    it('records refusals as skipped, a part-way helper failure and a failed delete as delete_failed', async () => {
      // A deleted agent, and one that needs a helper choice.
      await deleteAgent(PROJECT, 'orch', { mode: 'unregister' });
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
      await deleteAgent(PROJECT, 'orch', { mode: 'force' });
      // Helpers with work at risk.
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
      vi.mocked(settleHelpers).mockResolvedValueOnce({ ok: false, message: 'blocked', blocked: [{ agentId: 'h1', name: 'scout', checks: { dirty: 1, unpushed: 0, unmerged: 0 } }] });
      await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      // Unsaved work in its worktree.
      vi.mocked(agentConfig.getWorktreeStatus).mockResolvedValueOnce({ ...clean, unpushedCommits: [{ hash: 'h', shortHash: 'h', subject: 's', author: 'a', date: 'd' }] });
      await deleteAgent(PROJECT, 'orch', { mode: 'force', checkWorktree: true });
      // A helper that failed part way.
      vi.mocked(listHelpersEverywhere).mockResolvedValueOnce(helperRows as never);
      vi.mocked(settleHelpers).mockResolvedValueOnce({ ok: false, message: 'Disposed 1 of 2 helpers', helperIds: ['h2'], failed: [{ agentId: 'h1', name: 'scout', reason: 'EBUSY' }] });
      await deleteAgent(PROJECT, 'orch', { mode: 'force', helpers: 'dispose' });
      // The delete itself failed.
      vi.mocked(agentConfig.deleteForce).mockResolvedValueOnce({ ok: false, message: 'locked' });
      await deleteAgent(PROJECT, 'orch', { mode: 'force' });

      const force = ATTR.deleteMode('force');
      expect(flows).toEqual([
        { name: 'clubhouse.agent.delete', attrs: [ATTR.deleteMode('unregister')], outcome: 'ok' },
        { name: 'clubhouse.agent.delete', attrs: [force], outcome: { outcome: 'skipped' } },
        { name: 'clubhouse.agent.delete', attrs: [force], outcome: { outcome: 'skipped' } },
        { name: 'clubhouse.agent.delete', attrs: [force], outcome: { outcome: 'skipped' } },
        { name: 'clubhouse.agent.delete', attrs: [force], outcome: { error: 'delete_failed' } },
        { name: 'clubhouse.agent.delete', attrs: [force], outcome: { error: 'delete_failed' } },
      ]);
    });
  });
});
