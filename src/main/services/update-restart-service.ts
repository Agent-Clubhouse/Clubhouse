import { UPDATE_AGENT_ACTION_TIMEOUT_MS, type UpdateAgentAction, type UpdateAgentActionResult } from '../../shared/types';
import * as autoUpdateService from './auto-update-service';
import { captureSessionState, clearPendingResume, getLiveAgentsForUpdate, markAgentStoppedForUpdate } from './restart-session-service';
import { closeAgentWork, closeLaunches } from './launch-gate';
import * as ptyManager from './pty-manager';
import * as headlessManager from './headless-manager';
import { cancelAppShutdown, runAppShutdown } from './app-shutdown';
import { getAgentRuntime } from './agent-runtime';
import { appLog } from './log-service';

type RestartAgentMeta = Map<string, { kind: 'durable' | 'quick'; mission?: string; model?: string; worktreePath?: string; permissionMode?: import('../../shared/types').FreeAgentPermissionMode }>;
export type RestartData = { agentNames: Record<string, string>; agentMeta?: Record<string, unknown> };

export async function captureAndShutDown(data: RestartData, validate?: () => void): Promise<void> {
  const agentNames = new Map(Object.entries(data.agentNames));
  const agentMeta = data.agentMeta ? new Map(Object.entries(data.agentMeta)) as RestartAgentMeta : undefined;
  await captureSessionState(agentNames, agentMeta);
  validate?.();
  await runAppShutdown('update', undefined, validate);
}

let updateRestart: Promise<void> | null = null;

/** Desktop and remote approvals join the same capture, shutdown and apply. */
export function applyUpdateRestart(data?: RestartData, validate?: () => void): Promise<void> {
  if (updateRestart) return updateRestart;
  if (autoUpdateService.getStatus().state !== 'ready') return Promise.reject(new Error('No update ready to apply'));
  const run = (async () => {
    try {
      if (validate) { closeLaunches('restarting'); closeAgentWork(); validate(); }
      if (data) await captureAndShutDown(data, validate);
      else await runAppShutdown('update', undefined, validate);
      validate?.();
      if (validate) {
        await autoUpdateService.applyUpdate(undefined, { requireApplied: true });
        // A successful installer exits. Returning must not leave a stale resume file.
        await clearPendingResume();
      } else await autoUpdateService.applyUpdate();
    } catch (err) {
      if (validate) await clearPendingResume();
      throw err;
    } finally {
      cancelAppShutdown();
      updateRestart = null;
    }
  })();
  updateRestart = run;
  return run;
}

export function resolveAgentForUpdate(agentId: string, action: UpdateAgentAction): Promise<UpdateAgentActionResult> {
  const startedAt = Date.now();
  const before = getLiveAgentsForUpdate().find((agent) => agent.agentId === agentId);
  const runtime = getAgentRuntime(agentId);
  const meta = {
    agentId, action, runtime: before?.runtime ?? runtime?.kind ?? 'unknown',
    provider: before?.orchestrator ?? 'unknown', workingBefore: before?.isWorking ?? false,
  };
  appLog('update:session-resume', 'info', 'Update gate action started', {
    meta: { ...meta, durationMs: 0, result: 'started', workingAfter: meta.workingBefore },
  });
  const undoStop = action === 'kill' ? markAgentStoppedForUpdate(agentId) : undefined;

  return new Promise((resolve) => {
    let completed = false;
    let settled = false;
    const working = () => getLiveAgentsForUpdate().some((agent) => agent.agentId === agentId && agent.isWorking);
    const finish = (status: UpdateAgentActionResult['status']) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(poll);
      const isWorking = working();
      appLog('update:session-resume', status === 'resolved' ? 'info' : 'warn', 'Update gate action finished', {
        meta: { ...meta, durationMs: Date.now() - startedAt, result: status, workingAfter: isWorking },
      });
      if (status === 'resolved') resolve({ status, isWorking });
      else resolve({
        status, isWorking,
        message: action === 'interrupt'
          ? status === 'timeout'
            ? 'The agent did not become idle in time. Choose Stop now to end it without resuming after restart.'
            : 'Could not interrupt the agent. Try again or choose Stop now.'
          : status === 'timeout'
            ? 'Stopping took too long. Try Stop now again. This agent will not resume after restart.'
            : 'Could not stop the agent. Try Stop now again.',
      });
    };
    const check = () => {
      const stopped = runtime?.kind === 'pty' ? !runtime.isRunning()
        : !runtime ? !headlessManager.isHeadless(agentId) && !ptyManager.isRunning(agentId) : true;
      if (!settled && completed && (action === 'kill' ? stopped : !working())) finish('resolved');
    };
    const deadline = setTimeout(() => finish('timeout'), UPDATE_AGENT_ACTION_TIMEOUT_MS);
    const poll = setInterval(check, 250);
    void Promise.resolve().then(async () => {
      if (!runtime && headlessManager.isHeadless(agentId)) {
        headlessManager.kill(agentId);
      } else if (action === 'interrupt') {
        if (runtime) await runtime.interrupt();
        else ptyManager.write(agentId, '\x03');
      } else {
        if (runtime) await runtime.stop({ graceful: false, throwOnFailure: true });
        else ptyManager.kill(agentId);
      }
    }).then(() => { completed = true; check(); }, () => {
      undoStop?.();
      finish('error');
    });
  });
}
