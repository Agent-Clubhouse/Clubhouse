import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveAgentInfo, UpdateStatus } from '../../shared/types';
import type { AgentRegistration } from './agent-registry';
import { APP_UPDATE_IDLE_WAIT_MS } from '../../shared/app-update';

const fake = vi.hoisted(() => ({
  status: {} as UpdateStatus,
  unsupported: null as string | null,
  readyProblem: null as string | null,
  enabled: true,
  live: [] as LiveAgentInfo[],
  registrations: new Map<string, AgentRegistration>(),
  listeners: new Set<() => void>(),
  apply: vi.fn(async (..._args: unknown[]) => {}),
  resolve: vi.fn(async (..._args: unknown[]) => ({ status: 'resolved', isWorking: false })),
  name: vi.fn(async () => ({ name: 'Builder' })),
}));
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }));
vi.mock('./auto-update-service', () => ({
  getStatus: () => ({ ...fake.status }),
  getSelfUpdateUnsupportedReason: () => fake.unsupported,
  getReadyUpdateProblem: () => fake.readyProblem,
  isNewerVersion: (a: string, b: string) => a !== b,
  onStatusChanged: (l: () => void) => { fake.listeners.add(l); return () => fake.listeners.delete(l); },
}));
vi.mock('./dispatcher/dispatcher-service', () => ({
  getDispatcherPath: () => '/dispatcher',
  getDispatcherState: () => ({ enabled: fake.enabled, agentId: 'dispatcher', chatAgentId: 'dispatcher-chat', config: { name: 'Dispatcher' } }),
}));
vi.mock('./agent-config', () => ({ getDurableConfig: fake.name }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: (id: string) => fake.registrations.get(id) } }));
vi.mock('./restart-session-service', () => ({ getLiveAgentsForUpdate: () => fake.live }));
vi.mock('./update-restart-service', () => ({ applyUpdateRestart: fake.apply, resolveAgentForUpdate: fake.resolve }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./grant-telemetry', () => ({ recordGrantRequest: vi.fn() }));
vi.mock('./agent-grants-service', () => ({ setAgentGrant: vi.fn() }));
vi.mock('./clubhouse-mcp/tools/helper-delivery', () => ({ deliverHelperUpdate: vi.fn() }));

import { _resetAppUpdateForTesting, answerAppUpdateRequest, cancelAppUpdate, getAppUpdateStatus, onAppUpdateChanged, requestAppUpdate } from './app-update-request';
import { answerGrantRequest } from './grant-request-answers';
import { _resetGrantRequestsForTesting, consumeCallApproval, callKey, listGrantRequests, peekGrantRequest } from './grant-requests';
import { runGrantCommand, type GrantRequestPlaces } from './mobile-grant-requests';

const places: GrantRequestPlaces = { projects: [], dispatcher: { projectId: '__dispatcher__', paths: ['/dispatcher'], agentId: 'dispatcher-chat', askingIds: ['dispatcher'] } };
const working = (id = 'builder'): LiveAgentInfo => ({ agentId: id, projectPath: '/project', orchestrator: 'claude-code', runtime: 'chat', isWorking: true, lastActivity: null, resumeStrategy: 'auto' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  _resetAppUpdateForTesting();
  _resetGrantRequestsForTesting();
  vi.clearAllMocks();
  fake.status = { state: 'ready', availableVersion: '1.1.0', downloadProgress: 100, error: null } as UpdateStatus;
  fake.unsupported = null;
  fake.readyProblem = null;
  fake.enabled = true;
  fake.live = [];
  fake.registrations.clear();
  fake.listeners.clear();
  fake.apply.mockResolvedValue(undefined);
  fake.resolve.mockImplementation(async () => { fake.live = []; return { status: 'resolved', isWorking: false }; });
  fake.name.mockResolvedValue({ name: 'Builder' });
});
afterEach(() => { _resetAppUpdateForTesting(); _resetGrantRequestsForTesting(); vi.useRealTimers(); });

describe('human-approved Clubhouse updates', () => {
  it('only records an approval, with the version and working agent names, and never starts a prompt or restart', async () => {
    fake.live = [working()];
    const pending = await requestAppUpdate();
    expect(pending.state).toBe('pending_approval');
    expect(listGrantRequests()).toMatchObject([{
      actions: ['app.update'], kind: 'call', agentId: 'dispatcher', update: { version: '1.1.0', workingAgents: [{ agentId: 'builder', name: 'Builder' }] },
    }]);
    expect(fake.apply).not.toHaveBeenCalled();
    expect(fake.resolve).not.toHaveBeenCalled();
    await expect(requestAppUpdate()).rejects.toMatchObject({ code: 'update_request_active' });
  });

  it('refuses unsupported, unready, disabled-Dispatcher and deauthorized requests without side effects', async () => {
    fake.unsupported = 'This is a development build.';
    await expect(requestAppUpdate()).rejects.toMatchObject({ code: 'update_unsupported', detail: fake.unsupported });
    fake.unsupported = null;
    fake.enabled = false;
    await expect(requestAppUpdate()).rejects.toMatchObject({ code: 'dispatcher_unavailable' });
    fake.enabled = true;
    fake.status.state = 'downloading';
    await expect(requestAppUpdate()).rejects.toMatchObject({ code: 'update_not_ready' });
    fake.status.state = 'ready';
    await expect(requestAppUpdate(() => { throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect(listGrantRequests()).toEqual([]);
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('serializes competing requests while agent names are read', async () => {
    let finish!: (name: { name: string }) => void;
    fake.live = [working()];
    fake.name.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const first = requestAppUpdate();
    await expect(requestAppUpdate()).rejects.toMatchObject({ code: 'update_request_active' });
    finish({ name: 'Builder' });
    await first;
    expect(listGrantRequests()).toHaveLength(1);
  });

  it('does not advertise a missing installer as ready or record an unsafe approval', async () => {
    fake.readyProblem = 'The downloaded installer is missing.';
    expect(getAppUpdateStatus()).toMatchObject({ state: 'available', reason: fake.readyProblem });
    await expect(requestAppUpdate()).rejects.toMatchObject({ code: 'update_not_ready', detail: fake.readyProblem });
    expect(listGrantRequests()).toEqual([]);
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('a generic desktop Allow cannot approve an update', async () => {
    const pending = await requestAppUpdate();
    expect(await answerGrantRequest(pending.requestId, true)).toMatchObject({ ok: false, error: expect.stringContaining('Choose Restart now') });
    expect(peekGrantRequest(pending.requestId)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('a generic older-phone Allow cannot approve, but an explicit phone choice uses the same approval once', async () => {
    const pending = await requestAppUpdate();
    const command = { version: 1 as const, epoch: 'e', commandId: 'c', type: 'grant.answer' as const, requestId: pending.requestId, answer: 'allow_once' as const };
    const deps = { viewer: 'phone', assertAuthorized: vi.fn() };
    await expect(runGrantCommand(command, places, deps)).rejects.toMatchObject({ code: 'grant_answer_failed' });
    await runGrantCommand({ ...command, updateMode: 'when_idle' }, places, deps);
    expect(getAppUpdateStatus().request?.state).toBe('waiting_for_idle');
    expect(consumeCallApproval(callKey('dispatcher', 'request_app_update', { version: '1.1.0' }))).toBe(false);
    await expect(runGrantCommand({ ...command, updateMode: 'now' }, places, deps)).rejects.toMatchObject({ code: 'grant_request_not_found' });
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('cancels from the normal decline or the explicit cancel command, without installing', async () => {
    const pending = await requestAppUpdate();
    expect(await answerGrantRequest(pending.requestId, false)).toEqual({ ok: true });
    expect(getAppUpdateStatus().request?.state).toBe('cancelled');
    const next = await requestAppUpdate();
    answerAppUpdateRequest(next.requestId, true, 'when_idle');
    cancelAppUpdate(next.requestId);
    await vi.advanceTimersByTimeAsync(APP_UPDATE_IDLE_WAIT_MS + 1000);
    expect(getAppUpdateStatus().request?.state).toBe('cancelled');
    expect(fake.apply).not.toHaveBeenCalled();
    expect(() => cancelAppUpdate('missing')).toThrow('update_request_not_found');
  });

  it('does not consume an update approval if phone authorization is revoked while loading its answer', async () => {
    const pending = await requestAppUpdate();
    const assertAuthorized = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('revoked'); });
    await expect(runGrantCommand({
      version: 1, epoch: 'e', commandId: 'c', type: 'grant.answer', requestId: pending.requestId, answer: 'allow_once', updateMode: 'now',
    }, places, { viewer: 'phone', assertAuthorized })).rejects.toThrow('revoked');
    expect(peekGrantRequest(pending.requestId)).not.toBeNull();
    expect(getAppUpdateStatus().request?.state).toBe('pending_approval');
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('never interrupts while waiting for idle and fails after 30 minutes', async () => {
    fake.live = [working()];
    const pending = await requestAppUpdate();
    answerAppUpdateRequest(pending.requestId, true, 'when_idle');
    await vi.advanceTimersByTimeAsync(APP_UPDATE_IDLE_WAIT_MS + 1000);
    expect(getAppUpdateStatus().request).toMatchObject({ state: 'failed', error: expect.stringContaining('30 minutes') });
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('restarts through the shared capture/shutdown path only after all agents are idle', async () => {
    fake.live = [working()];
    const pending = await requestAppUpdate();
    answerAppUpdateRequest(pending.requestId, true, 'when_idle');
    await vi.advanceTimersByTimeAsync(1250);
    expect(fake.apply).not.toHaveBeenCalled();
    fake.live = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.apply).toHaveBeenCalledTimes(1);
    expect(fake.apply).toHaveBeenCalledWith({ agentNames: {} }, expect.any(Function));
  });

  it('restart now uses bounded interrupt then stop, and refuses cancellation once begun', async () => {
    fake.live = [working()];
    fake.resolve.mockImplementationOnce(async () => ({ status: 'timeout', isWorking: true }));
    const pending = await requestAppUpdate();
    answerAppUpdateRequest(pending.requestId, true, 'now');
    expect(() => cancelAppUpdate(pending.requestId)).toThrow('update_restart_started');
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.resolve.mock.calls).toEqual([['builder', 'interrupt'], ['builder', 'kill']]);
    expect(fake.apply).toHaveBeenCalledTimes(1);
  });

  it('does not install when stopping fails', async () => {
    fake.live = [working()];
    fake.resolve.mockResolvedValue({ status: 'timeout', isWorking: true });
    const pending = await requestAppUpdate();
    answerAppUpdateRequest(pending.requestId, true, 'now');
    await vi.advanceTimersByTimeAsync(250);
    expect(getAppUpdateStatus().request?.state).toBe('failed');
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('refuses newly working or replaced agents rather than silently extending the approval', async () => {
    fake.live = [working()];
    fake.registrations.set('builder', { runtime: 'chat', orchestrator: 'claude-code', projectPath: '/project' });
    const pending = await requestAppUpdate();
    fake.registrations.set('builder', { runtime: 'chat', orchestrator: 'claude-code', projectPath: '/project' });
    expect(answerAppUpdateRequest(pending.requestId, true, 'now').ok).toBe(false);
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('fails safely if a new agent starts between approval and restart', async () => {
    const pending = await requestAppUpdate();
    answerAppUpdateRequest(pending.requestId, true, 'now');
    fake.live = [working('new-agent')];
    await vi.advanceTimersByTimeAsync(250);
    expect(getAppUpdateStatus().request?.state).toBe('failed');
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('binds approval and the idle wait to the reviewed update version', async () => {
    const pending = await requestAppUpdate();
    fake.status.availableVersion = '1.2.0';
    expect(answerAppUpdateRequest(pending.requestId, true, 'now').ok).toBe(false);
    expect(getAppUpdateStatus().request?.error).toContain('changed');
    fake.status.availableVersion = '1.1.0';
    const next = await requestAppUpdate();
    answerAppUpdateRequest(next.requestId, true, 'when_idle');
    fake.status.availableVersion = '1.2.0';
    await vi.advanceTimersByTimeAsync(250);
    expect(getAppUpdateStatus().request?.state).toBe('failed');
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('reports an apply error rather than claiming success', async () => {
    fake.apply.mockRejectedValue(new Error('Installer refused'));
    const pending = await requestAppUpdate();
    answerAppUpdateRequest(pending.requestId, true, 'now');
    await vi.advanceTimersByTimeAsync(250);
    expect(getAppUpdateStatus().request).toMatchObject({ state: 'failed', error: 'Installer refused' });
  });

  it('expires pending approvals and never schedules a restart', async () => {
    await requestAppUpdate();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1);
    expect(getAppUpdateStatus().request).toMatchObject({ state: 'failed', error: expect.stringContaining('expired') });
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('reports updater state and progress, including unsupported builds and download failures', () => {
    const changed = vi.fn();
    const off = onAppUpdateChanged(changed);
    fake.status = { ...fake.status, state: 'idle', availableVersion: null, downloadProgress: 0 };
    expect(getAppUpdateStatus()).toMatchObject({ state: 'none', currentVersion: '1.0.0', availableVersion: null, request: null });
    fake.status = { ...fake.status, state: 'checking', availableVersion: '1.1.0' };
    expect(getAppUpdateStatus().state).toBe('available');
    fake.status.state = 'downloading';
    fake.status.downloadProgress = 42.5;
    expect(getAppUpdateStatus()).toMatchObject({ state: 'downloading', downloadProgress: 42.5 });
    for (const listener of fake.listeners) listener();
    expect(changed).toHaveBeenCalledTimes(1);
    fake.status.state = 'error';
    fake.status.error = 'Download failed';
    expect(getAppUpdateStatus()).toMatchObject({ state: 'available', reason: 'Download failed' });
    fake.unsupported = 'This build cannot update itself.';
    expect(getAppUpdateStatus()).toMatchObject({ state: 'unsupported', reason: fake.unsupported });
    off();
    expect(fake.listeners.size).toBe(0);
  });
});
