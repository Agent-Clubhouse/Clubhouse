import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./clubhouse-mcp/tools/helper-tools', () => ({ approveHelperStart: vi.fn(), declineHelperStart: vi.fn() }));
vi.mock('./helper-dispose-decisions', async (importOriginal) => ({
  ...await importOriginal<typeof import('./helper-dispose-decisions')>(),
  disposeHelperForUser: vi.fn(),
  reportDisposeDecision: vi.fn(),
}));
vi.mock('./agent-config', () => ({ getDurableConfig: vi.fn() }));

import { buildMobileHelperRequests, runHelperCommand } from './mobile-helper-requests';
import { _resetStartRequestsForTesting, recordStartRequest, takeStartRequest } from './helper-start-requests';
import { _resetDisposeRequestsForTesting, listDisposeRequests, recordDisposeRequest } from './helper-dispose-requests';
import { approveHelperStart, declineHelperStart } from './clubhouse-mcp/tools/helper-tools';
import { disposeHelperForUser, reportDisposeDecision } from './helper-dispose-decisions';
import * as agentConfig from './agent-config';
import { MobileControlError } from './mobile-control';
import type { DurableAgentConfig, HelperDisposeChecks } from '../../shared/types';

const projects = [{ id: 'proj', path: '/p' }];
const agent = (id: string, name: string, extra: Partial<DurableAgentConfig> = {}) => ({ id, name, color: 'blue', createdAt: '2026-01-01', ...extra }) as DurableAgentConfig;
const agents = { proj: [agent('orch', 'Planner'), agent('helper', 'Docs', { parentAgentId: 'orch' })] };
const clean: HelperDisposeChecks = { dirty: 0, unpushed: 0, unmerged: 0 };

function disposeRequest(checks: HelperDisposeChecks = clean, forceRequested = false, at = Date.parse('2026-10-26T10:00:00Z')) {
  recordDisposeRequest('/p', 'helper', 'orch', { projectPath: '/p', orchestratorId: 'orch', helperId: 'helper', helperName: 'Docs', checks, forceRequested }, at);
  return listDisposeRequests()[0].requestId;
}

function startRequest(at = Date.parse('2026-10-26T09:00:00Z')) {
  const result = recordStartRequest('/p', 'orch', 'Planner (old name)', { name: 'impl-ipc', task: 'Wire the IPC', model: 'opus' }, at);
  if (!result.ok) throw new Error('not recorded');
  return result.request.requestId;
}

const deps = () => ({ assertAuthorized: vi.fn(), reloadProject: vi.fn() });
const command = (type: 'helper.approve' | 'helper.decline', requestId: string, force?: boolean) =>
  ({ version: 1 as const, commandId: 'c', epoch: 'e', type, requestId, ...(force === undefined ? {} : { force }) }) as Parameters<typeof runHelperCommand>[0];

async function rejection(promise: Promise<unknown>): Promise<MobileControlError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(MobileControlError);
  return err as MobileControlError;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-26T12:00:00Z'));
  vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(agents.proj[1]);
  vi.mocked(reportDisposeDecision).mockResolvedValue({ ok: true, delivered: true, message: 'Reported' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  _resetStartRequestsForTesting();
  _resetDisposeRequestsForTesting();
});

describe('buildMobileHelperRequests', () => {
  it('lists starts and disposes, oldest first, with the desktop Needs you lines', () => {
    const disposeId = disposeRequest({ dirty: 2, unpushed: 1, unmerged: 3 }, true);
    const startId = startRequest();
    expect(buildMobileHelperRequests(projects, agents)).toEqual([
      {
        requestId: startId, kind: 'start', projectId: 'proj',
        requester: { agentId: 'orch', name: 'Planner' }, helper: { agentId: null, name: 'impl-ipc' },
        requestedAt: '2026-10-26T09:00:00.000Z', expiresAt: '2026-10-27T09:00:00.000Z',
        summary: 'Wants to start the helper impl-ipc',
        start: { task: 'Wire the IPC', persona: null, model: 'opus', access: null, branchFrom: null },
      },
      {
        requestId: disposeId, kind: 'dispose', projectId: 'proj',
        requester: { agentId: 'orch', name: 'Planner' }, helper: { agentId: 'helper', name: 'Docs' },
        requestedAt: '2026-10-26T10:00:00.000Z', expiresAt: null,
        summary: 'Planner asked to dispose this helper (forced). 2 uncommitted files, 1 unpushed commit, 3 unmerged commits.',
        dispose: { uncommittedFiles: 2, unpushedCommits: 1, unmergedCommits: 3, checkError: null, forceRequested: true, workAtRisk: true, canDispose: true },
      },
    ]);
  });

  it('marks a dispose whose check failed as not disposable', () => {
    disposeRequest({ dirty: 0, unpushed: 0, unmerged: null, error: 'its remote has never been fetched' });
    const [only] = buildMobileHelperRequests(projects, agents);
    expect(only.dispose).toMatchObject({ checkError: 'its remote has never been fetched', canDispose: false, workAtRisk: false });
    expect(only.summary).toBe('Planner asked to dispose this helper. Its remote has never been fetched.');
  });

  it('leaves out unregistered projects and helpers that are gone or disposed', () => {
    disposeRequest();
    startRequest();
    expect(buildMobileHelperRequests([], agents)).toEqual([]);
    expect(buildMobileHelperRequests(projects, { proj: [agent('orch', 'Planner')] }).map((r) => r.kind)).toEqual(['start']);
    const disposed = { proj: [agent('orch', 'Planner'), agent('helper', 'Docs', { disposedAt: '2026-10-26T11:00:00Z' } as Partial<DurableAgentConfig>)] };
    expect(buildMobileHelperRequests(projects, disposed).map((r) => r.kind)).toEqual(['start']);
  });

  it('names an orchestrator in another project from that project\'s agents', () => {
    recordDisposeRequest('/far', 'farhelper', 'orch', { projectPath: '/far', orchestratorId: 'orch', helperId: 'farhelper', helperName: 'Far', checks: clean, forceRequested: false });
    const both = [...projects, { id: 'far', path: '/far' }];
    const [dispose] = buildMobileHelperRequests(both, {
      ...agents,
      far: [agent('orch', 'Same id, wrong project'), agent('farhelper', 'Far', { parentAgentId: 'orch', parentProjectPath: '/p' })],
    });
    expect(dispose).toMatchObject({ projectId: 'far', requester: { agentId: 'orch', name: 'Planner' }, helper: { agentId: 'farhelper', name: 'Far' } });
    expect(dispose.summary).toMatch(/^Planner asked/);
  });

  it('names the project a start in another project would go to (#2515)', () => {
    recordStartRequest('/p', 'orch', 'Planner', { name: 'api', task: 't', project: '/far' });
    recordStartRequest('/p', 'orch', 'Planner', { name: 'web', task: 't', project: '/gone/site' });
    const [far, gone] = buildMobileHelperRequests([...projects, { id: 'far', path: '/far', name: 'far', displayName: 'Far Away' }], agents);
    expect(far).toMatchObject({ kind: 'start', projectId: 'proj', summary: 'Wants to start the helper api in Far Away' });
    expect(gone.summary).toBe('Wants to start the helper web in site');
  });

  it('names an orchestrator it cannot find as the desktop does', () => {
    disposeRequest();
    startRequest();
    const [start, dispose] = buildMobileHelperRequests(projects, { proj: [agents.proj[1]] });
    expect(start.requester.name).toBe('Planner (old name)');
    expect(dispose.requester.name).toBe('An orchestrator');
  });
});

describe('runHelperCommand: starts', () => {
  it('approves through the desktop path and returns the new helper', async () => {
    const id = startRequest();
    vi.mocked(approveHelperStart).mockResolvedValue({ ok: true, message: 'Starting impl-ipc', helperId: 'durable_new' });
    const d = deps();
    expect(await runHelperCommand(command('helper.approve', id), d)).toEqual({ requestId: id, kind: 'start', approved: true, helperId: 'durable_new' });
    expect(approveHelperStart).toHaveBeenCalledWith('/p', id);
    expect(d.assertAuthorized).toHaveBeenCalled();
  });

  it('reports a refusal that leaves the request waiting as blocked, with the desktop sentence', async () => {
    const id = startRequest();
    vi.mocked(approveHelperStart).mockResolvedValue({ ok: false, message: 'Wake Planner to approve this start.' });
    const err = await rejection(runHelperCommand(command('helper.approve', id), deps()));
    expect(err).toMatchObject({ code: 'helper_start_blocked', statusCode: 409, outcome: 'rejected', detail: 'Wake Planner to approve this start.' });
  });

  it('reports a used-up start that failed as refused', async () => {
    const id = startRequest();
    vi.mocked(approveHelperStart).mockImplementation(async (p, r) => { takeStartRequest(p, r); return { ok: false, message: 'Couldn’t start impl-ipc' }; });
    expect(await rejection(runHelperCommand(command('helper.approve', id), deps()))).toMatchObject({ code: 'helper_start_refused', outcome: 'failed' });
  });

  it('declines', async () => {
    const id = startRequest();
    vi.mocked(declineHelperStart).mockResolvedValue({ ok: true, message: 'Declined' });
    expect(await runHelperCommand(command('helper.decline', id), deps())).toEqual({ requestId: id, kind: 'start', declined: true });
    vi.mocked(declineHelperStart).mockResolvedValue({ ok: false, message: 'gone' });
    expect(await rejection(runHelperCommand(command('helper.decline', id), deps()))).toMatchObject({ code: 'helper_request_not_found', statusCode: 404 });
  });

  it('stops before acting when authorization changed', async () => {
    const id = startRequest();
    const d = deps();
    d.assertAuthorized.mockImplementation(() => { throw new MobileControlError('authorization_revoked', 403); });
    expect(await rejection(runHelperCommand(command('helper.approve', id), d))).toMatchObject({ code: 'authorization_revoked' });
    expect(approveHelperStart).not.toHaveBeenCalled();
  });
});

describe('runHelperCommand: disposes', () => {
  it('refuses an unknown request, or one whose helper moved to another parent', async () => {
    expect(await rejection(runHelperCommand(command('helper.approve', 'hdispose_nope'), deps()))).toMatchObject({ code: 'helper_request_not_found' });
    const id = disposeRequest();
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(agent('helper', 'Docs', { parentAgentId: 'someone-else' }));
    expect(await rejection(runHelperCommand(command('helper.approve', id), deps()))).toMatchObject({ code: 'helper_request_not_found' });
    expect(disposeHelperForUser).not.toHaveBeenCalled();
  });

  it('disposes a clean helper, reloads the rail and tells the orchestrator', async () => {
    const id = disposeRequest();
    vi.mocked(disposeHelperForUser).mockResolvedValue({ ok: true, message: 'Disposed', stopped: true });
    const d = deps();
    expect(await runHelperCommand(command('helper.approve', id), d)).toEqual({ requestId: id, kind: 'dispose', approved: true, stopped: true });
    expect(disposeHelperForUser).toHaveBeenCalledWith('/p', 'helper', { force: false, seen: clean });
    expect(d.reloadProject).toHaveBeenCalledWith('/p');
    expect(reportDisposeDecision).toHaveBeenCalledWith('/p', 'helper', 'disposed');
  });

  it('needs force when work is at risk, as Dispose anyway', async () => {
    const atRisk = { dirty: 2, unpushed: 1, unmerged: 0 };
    const id = disposeRequest(atRisk);
    expect(await rejection(runHelperCommand(command('helper.approve', id), deps()))).toMatchObject({ code: 'helper_work_at_risk', statusCode: 409 });
    expect(disposeHelperForUser).not.toHaveBeenCalled();
    vi.mocked(disposeHelperForUser).mockResolvedValue({ ok: true, message: 'Disposed' });
    expect(await runHelperCommand(command('helper.approve', id, true), deps())).toMatchObject({ approved: true, stopped: false });
    expect(disposeHelperForUser).toHaveBeenCalledWith('/p', 'helper', { force: true, seen: atRisk });
  });

  it('never disposes a helper whose check failed', async () => {
    const id = disposeRequest({ dirty: 0, unpushed: 0, unmerged: null, error: 'git failed' });
    const err = await rejection(runHelperCommand(command('helper.approve', id, true), deps()));
    expect(err).toMatchObject({ code: 'helper_check_failed' });
    expect(err.detail).toContain('couldn’t be checked');
    expect(disposeHelperForUser).not.toHaveBeenCalled();
  });

  it('reissues the request with the new facts when more is at risk than the phone was shown', async () => {
    const id = disposeRequest();
    const worse = { dirty: 3, unpushed: 0, unmerged: 0 };
    vi.mocked(disposeHelperForUser).mockResolvedValue({ ok: false, changed: true, stopped: true, message: 'Docs saved more work before it stopped', checks: worse });
    const err = await rejection(runHelperCommand(command('helper.approve', id), deps()));
    expect(err).toMatchObject({ code: 'helper_work_changed', detail: 'Docs saved more work before it stopped. Review what would be lost and confirm again. Docs is stopped.' });
    const [next] = listDisposeRequests();
    expect(next.requestId).not.toBe(id);
    expect(next.request.checks).toEqual(worse);
    expect(reportDisposeDecision).not.toHaveBeenCalled();
  });

  it('maps a check that fails on approve', async () => {
    const id = disposeRequest();
    vi.mocked(disposeHelperForUser).mockResolvedValue({ ok: false, message: 'Docs wasn’t disposed (git failed)', checks: { ...clean, error: 'git failed' } });
    expect(await rejection(runHelperCommand(command('helper.approve', id), deps()))).toMatchObject({ code: 'helper_check_failed' });
    expect(listDisposeRequests()[0].request.checks.error).toBe('git failed');
  });

  it('maps work that appeared since the request to Dispose anyway', async () => {
    const id = disposeRequest();
    vi.mocked(disposeHelperForUser).mockResolvedValue({ ok: false, message: 'Docs has work that disposing would lose', checks: { dirty: 1, unpushed: 0, unmerged: 0 } });
    expect(await rejection(runHelperCommand(command('helper.approve', id), deps()))).toMatchObject({ code: 'helper_work_at_risk', detail: 'Docs has work that disposing would lose.' });
    expect(listDisposeRequests()[0].requestId).not.toBe(id);
  });

  it('reports a dispose that failed for another reason', async () => {
    const id = disposeRequest();
    vi.mocked(disposeHelperForUser).mockResolvedValue({ ok: false, message: 'Agent not found' });
    expect(await rejection(runHelperCommand(command('helper.approve', id), deps()))).toMatchObject({ code: 'helper_dispose_failed', outcome: 'failed', detail: 'Agent not found.' });
  });

  it('declines and tells the orchestrator', async () => {
    const id = disposeRequest();
    expect(await runHelperCommand(command('helper.decline', id), deps())).toEqual({ requestId: id, kind: 'dispose', declined: true });
    expect(reportDisposeDecision).toHaveBeenCalledWith('/p', 'helper', 'declined');
    vi.mocked(reportDisposeDecision).mockResolvedValue({ ok: false, delivered: false, message: 'No dispose request' });
    expect(await rejection(runHelperCommand(command('helper.decline', id), deps()))).toMatchObject({ code: 'helper_request_not_found' });
  });
});
