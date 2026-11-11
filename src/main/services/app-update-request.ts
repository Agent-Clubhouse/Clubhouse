import { app } from 'electron';
import { APP_UPDATE_IDLE_WAIT_MS, type AppUpdateMode, type AppUpdateRequest, type AppUpdateStatus } from '../../shared/app-update';
import { GRANT_REQUEST_DETAILS_MAX, type GrantRequestAnswer } from '../../shared/grant-requests';
import * as updater from './auto-update-service';
import { getDispatcherState, getDispatcherPath } from './dispatcher/dispatcher-service';
import { getDurableConfig } from './agent-config';
import { agentRegistry, type AgentRegistration } from './agent-registry';
import { getLiveAgentsForUpdate } from './restart-session-service';
import { applyUpdateRestart, resolveAgentForUpdate } from './update-restart-service';
import { callKey, consumeCallApproval, finishGrantAnswer, onGrantRequestsChanged, peekGrantRequest, recordGrantRequest, takeGrantRequest } from './grant-requests';
import { MobileControlError } from './mobile-control';
import { appLog } from './log-service';
import { recordGrantRequest as recordAnswer } from './grant-telemetry';
import { currentSettingsOrigin } from './settings-audit';

let request: AppUpdateRequest | null = null;
let reviewed = new Map<string, AgentRegistration | undefined>();
let timer: ReturnType<typeof setTimeout> | null = null;
let offRequests: (() => void) | null = null;
const listeners = new Set<() => void>();
let closing = false;
let creating = false;

function emit(): void { for (const listener of listeners) listener(); }
function clearTimer(): void { if (timer) clearTimeout(timer); timer = null; }

export function getAppUpdateStatus(): AppUpdateStatus {
  const status = updater.getStatus();
  const reason = updater.getSelfUpdateUnsupportedReason();
  const readyProblem = status.state === 'ready' ? updater.getReadyUpdateProblem() : null;
  const availableVersion = status.availableVersion && updater.isNewerVersion(status.availableVersion, app.getVersion()) ? status.availableVersion : null;
  return {
    state: reason ? 'unsupported' : status.state === 'ready' && !readyProblem ? 'ready' : status.state === 'downloading' ? 'downloading' : availableVersion ? 'available' : 'none',
    currentVersion: app.getVersion(),
    availableVersion,
    downloadProgress: Math.max(0, Math.min(100, status.downloadProgress)),
    reason: reason ?? readyProblem ?? status.error,
    request: request ? { ...request } : null,
  };
}

export function onAppUpdateChanged(listener: () => void): () => void {
  listeners.add(listener);
  const off = updater.onStatusChanged(listener);
  return () => { listeners.delete(listener); off(); };
}

function active(): boolean {
  return !!request && ['pending_approval', 'waiting_for_idle', 'restarting'].includes(request.state);
}

function closeApproval(allow: boolean): void {
  if (!request) return;
  closing = true;
  try {
    const row = takeGrantRequest(request.requestId, allow);
    if (row) {
      consumeCallApproval(callKey(row.agentId, row.toolName!, JSON.parse(row.argumentsText!)));
      finishGrantAnswer(row.requestId);
      recordAnswer({ agentId: row.agentId, kind: row.kind, outcome: allow ? 'allowed' : 'declined', actions: row.actions });
      appLog('update:session-resume', 'info', allow ? 'Update request approved' : 'Update request cancelled', {
        meta: { requestId: row.requestId, surface: currentSettingsOrigin().surface },
      });
    }
  } finally { closing = false; }
}

function fail(message: string): void {
  clearTimer();
  closeApproval(false);
  if (request) request = { ...request, state: 'failed', expiresAt: null, error: message };
  appLog('update:session-resume', 'warn', 'Requested update did not restart', { meta: { reason: message } });
  emit();
}

function readyReason(version?: string): string | null {
  const unsupported = updater.getSelfUpdateUnsupportedReason();
  if (unsupported) return unsupported;
  const status = updater.getStatus();
  if (status.state !== 'ready' || !status.availableVersion) return 'The update is not ready to install.';
  if (version && status.availableVersion !== version) return 'The available update changed. Request it again to review the new version.';
  const problem = updater.getReadyUpdateProblem();
  if (problem) return problem;
  if (!getDispatcherState().enabled) return 'Turn on the Dispatcher to request an update from your phone. You can still update from the desktop banner.';
  return null;
}

/** Asking never downloads, interrupts, stops or installs anything. */
export async function requestAppUpdate(assertAuthorized: () => void = () => {}): Promise<AppUpdateRequest> {
  const unsupported = updater.getSelfUpdateUnsupportedReason();
  if (unsupported) throw new MobileControlError('update_unsupported', 409, 'rejected', unsupported);
  const dispatcher = getDispatcherState();
  if (!dispatcher.enabled || !dispatcher.agentId || !dispatcher.chatAgentId) {
    throw new MobileControlError('dispatcher_unavailable', 409, 'rejected', 'Turn on the Dispatcher to request an update from your phone. You can still update from the desktop banner.');
  }
  if (creating || active()) throw new MobileControlError('update_request_active', 409, 'rejected', 'An update request is already in progress.');
  const status = updater.getStatus();
  if (status.state !== 'ready' || !status.availableVersion) throw new MobileControlError('update_not_ready', 409, 'rejected', 'Wait until the update is ready to install.');
  creating = true;
  try {
    const live = getLiveAgentsForUpdate().filter((agent) => agent.isWorking);
    const registrations = new Map(live.map((agent) => [agent.agentId, agentRegistry.get(agent.agentId)]));
    const workingAgents = await Promise.all(live.map(async (agent) => ({
      agentId: agent.agentId, name: (await getDurableConfig(agent.projectPath, agent.agentId))?.name ?? agent.agentId,
    })));
    assertAuthorized();
    const changed = readyReason(status.availableVersion);
    if (changed) throw new MobileControlError('update_not_ready', 409, 'rejected', changed);
    if (!offRequests) offRequests = onGrantRequestsChanged((change) => {
      if (!closing && change.kind === 'closed' && request?.state === 'pending_approval' && change.requestIds.includes(request.requestId)) {
        fail(change.reason === 'expired' ? 'The update approval expired. Request the update again.' : 'The update request was withdrawn.');
      }
    });
    const args = { version: status.availableVersion };
    const detail = workingAgents.length
      ? `Working agents that Restart now would interrupt: ${workingAgents.map((agent) => `${agent.name} (${agent.agentId})`).join(', ')}.`
      : 'No agents are currently working.';
    if (detail.length > GRANT_REQUEST_DETAILS_MAX) throw new MobileControlError('update_approval_capacity', 409, 'rejected', 'There are too many working agents to review in one approval. Update Clubhouse from the desktop.');
    const recorded = recordGrantRequest(callKey(dispatcher.agentId, 'request_app_update', args), {
      kind: 'call', agentId: dispatcher.agentId, agentName: dispatcher.config?.name ?? 'Dispatcher', projectPath: getDispatcherPath(),
      actions: ['app.update'], where: 'the app', toolName: 'request_app_update', detail,
      argumentsText: JSON.stringify(args), details: detail, update: { version: status.availableVersion, workingAgents },
    });
    if (!recorded.ok) throw new MobileControlError('update_approval_capacity', 409, 'rejected', 'The Dispatcher already has too many approvals waiting. Answer one first.');
    reviewed = registrations;
    request = {
      requestId: recorded.request.requestId, state: 'pending_approval', version: status.availableVersion,
      expiresAt: recorded.request.expiresAt, error: null,
    };
    emit();
    return { ...request };
  } finally { creating = false; }
}

export function cancelAppUpdate(requestId: string): AppUpdateRequest {
  if (!request || request.requestId !== requestId) throw new MobileControlError('update_request_not_found', 404, 'rejected', 'That update request is no longer available.');
  if (request.state === 'restarting') throw new MobileControlError('update_restart_started', 409, 'rejected', 'Restart has already started and cannot be cancelled.');
  clearTimer();
  closeApproval(false);
  request = { ...request, state: 'cancelled', expiresAt: null, error: null };
  emit();
  return { ...request };
}

async function restart(mode: AppUpdateMode, id: string): Promise<void> {
  if (!request || request.requestId !== id || !active()) return;
  const reason = readyReason(request.version);
  if (reason) { fail(reason); return; }
  if (mode === 'when_idle') {
    if (Date.now() >= Date.parse(request.expiresAt!)) { fail('Agents did not become idle within 30 minutes. Nothing was interrupted.'); return; }
    if (getLiveAgentsForUpdate().some((agent) => agent.isWorking)) {
      timer = setTimeout(() => { void restart(mode, id).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err))); }, 1000);
      timer.unref?.();
      return;
    }
  }
  request = { ...request, state: 'restarting', expiresAt: null };
  emit();
  try {
    if (mode === 'now') {
      for (const agent of getLiveAgentsForUpdate().filter((agent) => agent.isWorking)) {
        if (!reviewed.has(agent.agentId) || reviewed.get(agent.agentId) !== agentRegistry.get(agent.agentId)) {
          throw new Error('Another agent started working after this request. Request the update again to review it.');
        }
        const interrupted = await resolveAgentForUpdate(agent.agentId, 'interrupt');
        if (interrupted.status !== 'resolved') {
          if (reviewed.get(agent.agentId) !== agentRegistry.get(agent.agentId)) throw new Error('An agent restarted after approval. Request the update again.');
          const stopped = await resolveAgentForUpdate(agent.agentId, 'kill');
          if (stopped.status !== 'resolved') throw new Error(stopped.message ?? 'An agent could not be stopped. Nothing was installed.');
        }
      }
    }
    if (getLiveAgentsForUpdate().some((agent) => agent.isWorking)) throw new Error('An agent is still working. Request the update again.');
    const changed = readyReason(request.version);
    if (changed) throw new Error(changed);
    const version = request.version;
    await applyUpdateRestart({ agentNames: {} }, () => {
      const reason = readyReason(version);
      if (reason) throw new Error(reason);
      if (getLiveAgentsForUpdate().some((agent) => agent.isWorking)) throw new Error('An agent started working before shutdown. Request the update again.');
    });
    // A real successful apply exits. Returning means it failed or was cancelled locally.
    fail(updater.getStatus().error ?? 'The updater returned without restarting. Update Clubhouse from the desktop.');
  } catch (err) {
    // telemetry-exempt: fail logs the failure and publishes it to the person.
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Called only by the user's existing grant-answer surfaces, never by an agent tool. */
export function answerAppUpdateRequest(requestId: string, allow: boolean, mode?: AppUpdateMode): GrantRequestAnswer {
  const row = peekGrantRequest(requestId);
  if (!row?.update || !request || request.requestId !== requestId || request.state !== 'pending_approval') {
    return { ok: false, error: 'This request has expired or was already answered.' };
  }
  if (!allow) { cancelAppUpdate(requestId); return { ok: true }; }
  if (mode !== 'now' && mode !== 'when_idle') return { ok: false, error: 'Choose Restart now or Restart when idle to approve this update.' };
  const reason = readyReason(request.version);
  if (reason) { fail(reason); return { ok: false, error: reason }; }
  if (mode === 'now' && getLiveAgentsForUpdate().some((agent) => agent.isWorking
    && (!reviewed.has(agent.agentId) || reviewed.get(agent.agentId) !== agentRegistry.get(agent.agentId)))) {
    fail('Another agent started working after this request. Request the update again to review it.');
    return { ok: false, error: request.error! };
  }
  closeApproval(true);
  request = { ...request, state: mode === 'now' ? 'restarting' : 'waiting_for_idle',
    expiresAt: mode === 'now' ? null : new Date(Date.now() + APP_UPDATE_IDLE_WAIT_MS).toISOString() };
  emit();
  // Let the answer receipt leave before shutdown starts. The request's restarting event is still best effort.
  timer = setTimeout(() => { void restart(mode, requestId).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err))); }, 250);
  timer.unref?.();
  return { ok: true };
}

export function _resetAppUpdateForTesting(opts: { keepListeners?: boolean } = {}): void {
  clearTimer();
  offRequests?.();
  offRequests = null;
  request = null;
  reviewed.clear();
  creating = false;
  if (!opts.keepListeners) listeners.clear();
}
