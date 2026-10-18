import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { IPC } from '../../../../shared/ipc-channels';
import type { DurableAgentConfig, HelperDisposeChecks } from '../../../../shared/types';
import type { ResolvedOrchestrationPolicy } from '../../../../shared/orchestration-policy';

const PROJECT = path.join(process.cwd(), 'dispose-tools-project');
const OTHER_PROJECT = path.join(process.cwd(), 'dispose-tools-other');

const mocks = vi.hoisted(() => ({
  agents: [] as DurableAgentConfig[],
  checks: new Map<string, HelperDisposeChecks>(),
  /** Checks disposeHelper sees after the stop, when they differ. */
  checksAfterStop: new Map<string, HelperDisposeChecks>(),
  control: 'hands-off' as string,
  running: new Set<string>(),
  broadcast: vi.fn(),
  mainWindowSend: vi.fn(),
  hasMainWindow: true,
  killAgent: vi.fn(async (..._args: unknown[]) => undefined),
  disposeHelper: vi.fn(),
  setHelperHandoff: vi.fn(),
}));

function clean(): HelperDisposeChecks {
  return { dirty: 0, unpushed: 0, unmerged: 0 };
}

vi.mock('../../agent-config', () => ({
  // Every seeded agent lives in PROJECT.
  listHelpers: vi.fn(async (p: string, parentId: string, opts: { includeDisposed?: boolean } = {}) =>
    p !== PROJECT ? [] : mocks.agents.filter((a) => a.parentAgentId === parentId && (opts.includeDisposed || !a.disposedAt))),
  getDisposeChecks: vi.fn(async (_p: string, id: string) => mocks.checks.get(id) ?? clean()),
  getWorktreeStatus: vi.fn(async (_p: string, id: string) => ({
    isValid: true,
    branch: `${id}/standby`,
    uncommittedFiles: Array.from({ length: mocks.checks.get(id)?.dirty ?? 0 }, (_, i) => ({ path: `src/file${i}.ts`, status: 'M', staged: false })),
    unpushedCommits: [],
    hasRemote: true,
  })),
  disposeHelper: mocks.disposeHelper,
  setHelperHandoff: mocks.setHelperHandoff,
}));

vi.mock('../../../ipc/window-handlers', () => ({
  findMainWindow: () => (mocks.hasMainWindow ? { webContents: { send: mocks.mainWindowSend } } : undefined),
}));

vi.mock('../../orchestration-policy', () => ({
  withAgentLock: vi.fn((_p: string, _id: string, fn: () => Promise<unknown>) => fn()),
  getOrchestrationPolicy: vi.fn(async (_p: string, id: string) => (
    mocks.agents.some((a) => a.id === id)
      ? { orchestrate: true, access: 'same', control: mocks.control, maxHelpers: 5 } as unknown as ResolvedOrchestrationPolicy
      : null
  )),
}));

vi.mock('../../agent-system', () => ({
  isAgentRunning: vi.fn((id: string) => mocks.running.has(id)),
  killAgent: mocks.killAgent,
}));

vi.mock('../../project-store', () => ({
  list: vi.fn(async () => [{ id: 'proj_1', name: 'p', path: PROJECT }]),
}));

vi.mock('../../../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mocks.broadcast(...args),
}));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));

import { registerHelperDisposeTools } from './helper-dispose-tools';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { setOrchestrationEnabled, _resetOrchestrationGateForTesting } from '../orchestration-gate';
import { agentRegistry } from '../../agent-registry';
import { withAgentLock } from '../../orchestration-policy';
import { _resetDisposeRequestsForTesting, takeDisposeRequest } from '../../helper-dispose-requests';

function agent(id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name: id, color: 'blue', createdAt: '2026-10-18T00:00:00.000Z', ...extra };
}

function register(id: string, projectPath = PROJECT): void {
  agentRegistry.register(id, { projectPath, orchestrator: 'claude-code', runtime: 'pty' });
  setOrchestrationEnabled(id, true);
}

async function call(tool: string, args: Record<string, unknown>, caller = 'orch') {
  const result = await callTool(caller, tool, args);
  const text = result.content[0].text ?? '';
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { result, text, json };
}

beforeEach(() => {
  _resetDisposeRequestsForTesting();
  vi.clearAllMocks();
  _resetForTesting();
  _resetOrchestrationGateForTesting();
  for (const id of agentRegistry.getAllRegistrations().keys()) agentRegistry.untrack(id);
  mocks.agents = [
    agent('orch'),
    agent('helper', { parentAgentId: 'orch', disposable: true }),
    agent('other_orch'),
    agent('their_helper', { parentAgentId: 'other_orch' }),
    agent('plain'),
  ];
  mocks.checks.clear();
  mocks.checksAfterStop.clear();
  mocks.control = 'hands-off';
  mocks.running.clear();
  mocks.hasMainWindow = true;
  mocks.disposeHelper.mockImplementation(async (_p: string, id: string, opts: { force?: boolean } = {}) => {
    const checks = mocks.checksAfterStop.get(id) ?? mocks.checks.get(id) ?? clean();
    if (checks.error || (!opts.force && (checks.dirty > 0 || checks.unpushed > 0))) {
      return { ok: false, message: `${id} has work that disposing would lose`, checks };
    }
    return { ok: true, message: 'Disposed', checks };
  });
  mocks.setHelperHandoff.mockImplementation(async (_p: string, id: string, _parent: string, h: { how: string; note: string }) => {
    const record = { ...h, at: '2026-10-18T02:00:00.000Z' };
    const row = mocks.agents.find((a) => a.id === id);
    if (row) row.handoff = record as DurableAgentConfig['handoff'];
    return record;
  });
  registerHelperDisposeTools();
  register('orch');
  register('other_orch');
});

describe('gating', () => {
  it('lists the tools only for agents with orchestration on, and refuses them otherwise', async () => {
    expect(getScopedToolList('orch').map((t) => t.name)).toEqual(expect.arrayContaining(['hand_off', 'dispose_helper']));
    setOrchestrationEnabled('orch', false);
    expect(getScopedToolList('orch').map((t) => t.name)).not.toContain('dispose_helper');
    const { result, text } = await call('dispose_helper', { helper: 'helper' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/Orchestration is turned off/);
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });
});

describe('dispose_helper', () => {
  it('disposes a clean helper: stops it first, then refreshes the rail', async () => {
    mocks.running.add('helper');
    const { result, json } = await call('dispose_helper', { helper: 'helper' });
    expect(result.isError).toBe(false);
    expect(json).toMatchObject({ status: 'disposed', helper: { id: 'helper' }, forced: false });
    expect(mocks.killAgent).toHaveBeenCalledWith('helper', PROJECT, undefined, 'agent_tool', { waitForExit: true });
    expect(mocks.killAgent.mock.invocationCallOrder[0]).toBeLessThan(mocks.disposeHelper.mock.invocationCallOrder[0]);
    expect(mocks.disposeHelper).toHaveBeenCalledWith(PROJECT, 'helper', { force: false, expectedParentId: 'orch' });
    expect(withAgentLock).toHaveBeenCalledWith(PROJECT, 'orch', expect.any(Function));
    expect(mocks.broadcast).toHaveBeenCalledWith(IPC.WINDOW.REQUEST_DURABLE_RELOAD, 'proj_1');
  });

  it('holds a helper with work at risk and returns the facts, changing nothing', async () => {
    mocks.running.add('helper');
    mocks.checks.set('helper', { dirty: 2, unpushed: 3, unmerged: 4 });
    const { result, json } = await call('dispose_helper', { helper: 'helper' });
    expect(result.isError).toBe(false);
    expect(json).toMatchObject({
      status: 'held',
      reason: 'work-at-risk',
      canForce: true,
      uncommittedFiles: 2,
      uncommittedPaths: ['src/file0.ts', 'src/file1.ts'],
      unpushedCommits: 3,
      unmergedCommits: 4,
      errors: [],
    });
    expect(mocks.killAgent).not.toHaveBeenCalled();
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });

  it('force disposes a helper with work at risk', async () => {
    mocks.checks.set('helper', { dirty: 1, unpushed: 1, unmerged: 1 });
    const { json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(json).toMatchObject({ status: 'disposed', forced: true, uncommittedFiles: 1, unpushedCommits: 1 });
    expect(mocks.disposeHelper).toHaveBeenCalledWith(PROJECT, 'helper', { force: true, expectedParentId: 'orch' });
  });

  it('reports the facts and forced from the re-check after the stop', async () => {
    mocks.running.add('helper');
    mocks.checks.set('helper', { dirty: 1, unpushed: 0, unmerged: 0 });
    // The helper committed and pushed before it stopped: nothing was lost after all.
    mocks.checksAfterStop.set('helper', { dirty: 0, unpushed: 0, unmerged: 5 });
    const { json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(json).toMatchObject({ status: 'disposed', forced: false, uncommittedFiles: 0, unpushedCommits: 0, unmergedCommits: 5 });
    expect(json).not.toHaveProperty('uncommittedPaths');
  });

  it('reports a forced loss the re-check found even when the pre-check was clean', async () => {
    mocks.running.add('helper');
    mocks.checksAfterStop.set('helper', { dirty: 3, unpushed: 1, unmerged: 1 });
    const { json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(json).toMatchObject({ status: 'disposed', forced: true, uncommittedFiles: 3, unpushedCommits: 1 });
  });

  it('says the worktree folder is gone when the helper was released while git ran', async () => {
    mocks.disposeHelper.mockResolvedValueOnce({ ok: false, message: 'released', worktreeRemoved: true });
    const { result, text } = await call('dispose_helper', { helper: 'helper' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/worktree folder was already removed/);
    expect(text).toMatch(/not marked disposed/);
    expect(mocks.broadcast).toHaveBeenCalledWith(IPC.WINDOW.REQUEST_DURABLE_RELOAD, 'proj_1');
  });

  it('refuses when the helper was released before the dispose re-read', async () => {
    mocks.disposeHelper.mockResolvedValueOnce({ ok: false, message: 'helper is no longer a helper of this agent' });
    const { result, text } = await call('dispose_helper', { helper: 'helper' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/no longer a helper/);
    expect(mocks.broadcast).not.toHaveBeenCalledWith(IPC.WINDOW.REQUEST_DURABLE_RELOAD, expect.anything());
  });

  it('force can not override a check that could not run', async () => {
    mocks.running.add('helper');
    mocks.checks.set('helper', { dirty: 0, unpushed: 0, unmerged: null, error: "couldn't check, git failed" });
    const { result, json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(result.isError).toBe(false);
    expect(json).toMatchObject({ status: 'held', reason: 'check-failed', canForce: false, errors: ["couldn't check, git failed"] });
    expect(mocks.killAgent).not.toHaveBeenCalled();
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });

  it('force can not override a creation another window owns', async () => {
    mocks.checks.set('helper', { dirty: 0, unpushed: 0, unmerged: null, error: 'it is still being created in another Clubhouse window' });
    const { json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(json).toMatchObject({ status: 'held', canForce: false, errors: [expect.stringMatching(/another Clubhouse window/)] });
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });

  it('holds when the check after the stop fails, and says the helper was stopped', async () => {
    mocks.running.add('helper');
    mocks.checksAfterStop.set('helper', { dirty: 0, unpushed: 0, unmerged: null, error: "couldn't check, disk gone" });
    const { json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(json).toMatchObject({ status: 'held', reason: 'check-failed', canForce: false, stopped: true });
    expect(mocks.broadcast).not.toHaveBeenCalledWith(IPC.WINDOW.REQUEST_DURABLE_RELOAD, expect.anything());
  });

  it('under ask-everything refuses force and sends the dispose to the user', async () => {
    mocks.control = 'ask-everything';
    mocks.running.add('helper');
    mocks.checks.set('helper', { dirty: 1, unpushed: 0, unmerged: 2 });
    const { result, json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(result.isError).toBe(false);
    expect(json).toMatchObject({ status: 'sent-to-user', delivered: true, forceRefused: true, uncommittedFiles: 1, unmergedCommits: 2 });
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
    expect(mocks.killAgent).not.toHaveBeenCalled();
    // Only the main window gets it, never every window.
    expect(mocks.broadcast).not.toHaveBeenCalledWith(IPC.AGENT.HELPER_DISPOSE_REQUEST, expect.anything());
    expect(mocks.mainWindowSend).toHaveBeenCalledWith(IPC.AGENT.HELPER_DISPOSE_REQUEST, {
      projectPath: PROJECT,
      orchestratorId: 'orch',
      helperId: 'helper',
      helperName: 'helper',
      checks: { dirty: 1, unpushed: 0, unmerged: 2 },
      forceRequested: true,
    });
    // Recorded, so the user's answer can be reported to this orchestrator once (#2232).
    expect(takeDisposeRequest(PROJECT, 'helper', 'someone-else')).toBe(false);
    expect(takeDisposeRequest(PROJECT, 'helper', 'orch')).toBe(true);
    expect(takeDisposeRequest(PROJECT, 'helper', 'orch')).toBe(false);
  });

  it('under ask-everything a clean dispose also goes to the user', async () => {
    mocks.control = 'ask-everything';
    const { json } = await call('dispose_helper', { helper: 'helper' });
    expect(json).toMatchObject({ status: 'sent-to-user' });
    expect(json).not.toHaveProperty('forceRefused');
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });

  it('under ask-everything with no main window says the user could not be asked', async () => {
    mocks.control = 'ask-everything';
    mocks.hasMainWindow = false;
    const { json } = await call('dispose_helper', { helper: 'helper' });
    expect(json).toMatchObject({ status: 'sent-to-user', delivered: false, message: expect.stringMatching(/ask the user directly/) });
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
    // Nothing was sent, so there is nothing to answer.
    expect(takeDisposeRequest(PROJECT, 'helper', 'orch')).toBe(false);
  });

  it('accepts the helper by name', async () => {
    mocks.agents.find((a) => a.id === 'helper')!.name = 'Docs Writer';
    const { json } = await call('dispose_helper', { helper: 'docs writer' });
    expect(json).toMatchObject({ status: 'disposed', helper: { id: 'helper', name: 'Docs Writer' } });
  });

  it.each([
    ['another orchestrator\'s helper', 'their_helper'],
    ['a top-level agent', 'plain'],
    ['the orchestrator itself', 'orch'],
    ['an unknown agent', 'nobody'],
  ])('refuses %s', async (_label, target) => {
    const { result, text } = await call('dispose_helper', { helper: target, force: true });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/not one of your helpers/);
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
    expect(mocks.killAgent).not.toHaveBeenCalled();
  });

  it('refuses a caller running in another project', async () => {
    agentRegistry.register('orch', { projectPath: OTHER_PROJECT, orchestrator: 'claude-code', runtime: 'pty' });
    const { result, text } = await call('dispose_helper', { helper: 'helper' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/not one of your helpers/);
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });

  it('never disposes a helper that has helpers of its own', async () => {
    mocks.agents.push(agent('grandchild', { parentAgentId: 'helper' }));
    const { json } = await call('dispose_helper', { helper: 'helper', force: true });
    expect(json).toMatchObject({ status: 'held', reason: 'has-helpers', canForce: false });
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });

  it('answers plainly for a helper already disposed', async () => {
    mocks.agents.find((a) => a.id === 'helper')!.disposedAt = '2026-10-18T01:00:00.000Z';
    const { json } = await call('dispose_helper', { helper: 'helper' });
    expect(json).toMatchObject({ status: 'disposed', message: expect.stringMatching(/already disposed/) });
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
  });
});

describe('hand_off', () => {
  it('records the handoff on the helper and does not dispose', async () => {
    const { result, json } = await call('hand_off', { helper: 'helper', how: 'merged', note: '  PR #12 merged  ' });
    expect(result.isError).toBe(false);
    expect(mocks.setHelperHandoff).toHaveBeenCalledWith(PROJECT, 'helper', 'orch', { how: 'merged', note: 'PR #12 merged' });
    expect(json).toMatchObject({ status: 'handed-off', handoff: { how: 'merged', note: 'PR #12 merged' } });
    expect(mocks.agents.find((a) => a.id === 'helper')?.handoff).toMatchObject({ how: 'merged' });
    expect(mocks.disposeHelper).not.toHaveBeenCalled();
    expect(mocks.killAgent).not.toHaveBeenCalled();
  });

  it('rejects an unknown how', async () => {
    const { result, text } = await call('hand_off', { helper: 'helper', how: 'emailed' });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/pushed, merged, copied/);
    expect(mocks.setHelperHandoff).not.toHaveBeenCalled();
  });

  it('refuses another orchestrator\'s helper and a non-helper', async () => {
    for (const target of ['their_helper', 'plain']) {
      const { result } = await call('hand_off', { helper: target, how: 'pushed' });
      expect(result.isError).toBe(true);
    }
    expect(mocks.setHelperHandoff).not.toHaveBeenCalled();
  });

  it('is refused while orchestration is off', async () => {
    setOrchestrationEnabled('orch', false);
    const { result } = await call('hand_off', { helper: 'helper', how: 'pushed' });
    expect(result.isError).toBe(true);
    expect(mocks.setHelperHandoff).not.toHaveBeenCalled();
  });
});
