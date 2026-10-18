/**
 * The app's one shutdown (#2053): quit, the update restart and the app
 * restart all run it before the process ends. The update and restart paths
 * end with app.exit(), which skips before-quit, so they await it directly.
 *
 * 1. Close launches (and on quit, stop timers and servers).
 * 2. Stop every runtime together: terminals, chat sessions, headless runs.
 * 3. Finish session ids, chat transcripts, checkpoints and config writes.
 * 4. Restore the MCP and hooks config agents changed.
 *
 * Every step is bounded; a failure or timeout is logged and the next step runs.
 */
import { createShutdownCoordinator, type ShutdownCoordinator, type ShutdownTask } from '../shutdown-guard';
import { appLog } from './log-service';
import { closeLaunches, reopenLaunches } from './launch-gate';
import * as ptyManager from './pty-manager';
import * as headlessManager from './headless-manager';
import { stopAllChatAgents } from './agent-runtime/chat-spawn';
import { flushAllTranscripts } from './agent-runtime/chat-transcript';
import { whenCheckpointsIdle } from './agent-runtime/checkpoint-tracker';
import { whenSessionCapturesSettled } from './session-capture-barrier';
import { flushAllAgentConfigs } from './agent-config';
import { groupProjectRegistry } from './group-project-registry';
import { flushAllBulletinBoards } from './group-project-bulletin';
import { restoreAll } from './config-pipeline';
import { shutdownCompleted, shutdownStarted, shutdownStep } from '../telemetry/lifecycle';

/** Past each driver's own close grace (ACP: 2s session close, then 5s). */
const CHAT_STOP_TIMEOUT_MS = 10_000;
/** killAll sends the exit command and SIGKILLs after 2s. */
const PTY_STOP_TIMEOUT_MS = 5_000;
/** headlessManager.stopAll is bounded at 7s itself. */
const HEADLESS_STOP_TIMEOUT_MS = 8_000;
const PERSIST_TIMEOUT_MS = 5_000;
const RESTORE_TIMEOUT_MS = 5_000;

export type ShutdownReason = 'quit' | 'update' | 'restart';

let beginHook: (() => void) | undefined;
let reason: ShutdownReason = 'quit';

/**
 * Timers and servers to stop when a quit begins. Set once at startup. Not run
 * for the update and app restarts: app.exit() ends them, and an update that
 * fails to apply leaves the app running with them.
 */
export function setShutdownBegin(hook: () => void): void {
  beginHook = hook;
}

function task(step: ShutdownTask['step'], label: string, run: () => Promise<void>, timeoutMs: number): ShutdownTask {
  return { step, label, run, timeoutMs };
}

const coordinator: ShutdownCoordinator = createShutdownCoordinator({
  plan: () => ({
    begin: () => {
      closeLaunches(reason === 'quit' ? 'quitting' : 'restarting');
      appLog('core:shutdown', 'info', 'Shutting down: stopping agents, saving sessions, restoring configs', { meta: { reason } });
      if (reason === 'quit') beginHook?.();
    },
    stop: [
      task('pty_kill_all', 'kill PTY sessions', () => ptyManager.killAll(), PTY_STOP_TIMEOUT_MS),
      task('chat_stop', 'stop chat sessions', stopAllChatAgents, CHAT_STOP_TIMEOUT_MS),
      task('headless_stop', 'stop headless runs', () => headlessManager.stopAll(), HEADLESS_STOP_TIMEOUT_MS),
    ],
    persist: [
      // Session ids first: they are config writes the flush below must include.
      task('session_capture', 'save session ids', whenSessionCapturesSettled, PERSIST_TIMEOUT_MS),
      task('transcript_flush', 'flush chat transcripts', flushAllTranscripts, PERSIST_TIMEOUT_MS),
      task('checkpoint_drain', 'finish checkpoints', whenCheckpointsIdle, PERSIST_TIMEOUT_MS),
      task('agent_config_flush', 'flush agent configs', flushAllAgentConfigs, PERSIST_TIMEOUT_MS),
      task('group_project_flush', 'flush group projects', () => groupProjectRegistry.flush(), PERSIST_TIMEOUT_MS),
      task('bulletin_flush', 'flush bulletin boards', flushAllBulletinBoards, PERSIST_TIMEOUT_MS),
    ],
    restore: [
      task('config_restore', 'restore agent configs', restoreAll, RESTORE_TIMEOUT_MS),
    ],
  }),
  telemetry: { started: () => shutdownStarted(), step: shutdownStep, completed: () => shutdownCompleted() },
  onCleanupError: (operation, error) => {
    appLog('core:shutdown', 'error', `Failed to ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  },
});

/**
 * Run the shutdown, or join the one already running. `after` runs last,
 * inside the shutdown span (quit applies a pending update there).
 */
export function runAppShutdown(why: ShutdownReason, after?: ShutdownTask[]): Promise<void> {
  if (!coordinator.started) reason = why;
  return coordinator.run(after);
}

/**
 * The app didn't end after all (an update that failed to apply, the dev
 * restart): accept launches again so agents can be woken. They stay asleep
 * until then.
 */
export function cancelAppShutdown(): void {
  coordinator.reset();
  reopenLaunches();
}
