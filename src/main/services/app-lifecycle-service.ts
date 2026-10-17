/**
 * The app's lifecycle coordinator, wired to the real runtimes (#2053). Quit
 * (shutdown-guard), the confirmed update restart and plain restart
 * (app-handlers) and the updater's exit paths (auto-update-service, through
 * setApplyLifecycle) all await this one instance.
 */

import { createAppLifecycle } from '../app-lifecycle';
import * as ptyManager from './pty-manager';
import * as headlessManager from './headless-manager';
import { stopAllChatRuntimes } from './agent-runtime';
import { flushAllTranscripts } from './agent-runtime/chat-transcript';
import { whenCheckpointsIdle } from './agent-runtime/checkpoint-tracker';
import { setLaunchesBlocked, awaitPendingSessionCaptures } from './agent-system';
import { restoreAll } from './config-pipeline';
import { appLog } from './log-service';

export const appLifecycle = createAppLifecycle({
  setLaunchesBlocked: (blocked) => setLaunchesBlocked(blocked),
  runtimes: [
    // Sends each CLI's exit command, SIGKILLs stragglers after its grace period.
    { name: 'pty', run: () => ptyManager.killAll() },
    // Closes drivers and settles pending permissions; resolves once each end is written.
    { name: 'chat', run: () => stopAllChatRuntimes() },
    // SIGTERM, then SIGKILL; resolves once each process has closed.
    { name: 'headless', run: () => headlessManager.killAll() },
  ],
  drains: [
    // Session ids written by PTY exit callbacks (the #2027 runtime-switch barrier).
    { name: 'session captures', run: () => awaitPendingSessionCaptures() },
    { name: 'chat transcripts', run: () => flushAllTranscripts() },
    { name: 'checkpoints', run: () => whenCheckpointsIdle() },
  ],
  restoreConfig: () => restoreAll(),
  onStepError: (phase, name, error) => {
    appLog('core:shutdown', 'error', `Lifecycle ${phase} step failed: ${name}`, {
      meta: { phase, step: name, error: error instanceof Error ? error.message : String(error) },
    });
  },
  onPhase: (phase, reason) => {
    appLog('core:shutdown', 'info', `Lifecycle phase: ${phase}`, { meta: { phase, reason } });
  },
});
