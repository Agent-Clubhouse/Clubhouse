import { IPC } from '../../shared/ipc-channels';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import type { QuickAgentRun } from './quick-agent-events';

type ExitListener = (agentId: string, exitCode: number, quickRun?: QuickAgentRun) => void;
const exitListeners = new Set<ExitListener>();

/**
 * Register a listener that fires on every agent exit (always active, unlike annex bus).
 * Returns an unsubscribe function.
 */
export function onAgentExit(fn: ExitListener): () => void {
  exitListeners.add(fn);
  return () => { exitListeners.delete(fn); };
}

/**
 * Broadcast an agent exit event to both the renderer (via IPC) and the annex
 * event bus. These two notifications must always be paired — calling them
 * individually risks one side missing the exit if a code path forgets one.
 *
 * @param agentId  - The agent whose process exited.
 * @param exitCode - The process exit code.
 * @param lastOutput - Optional last PTY output for renderer diagnostics.
 * @param quickRun - The quick run captured when the process started, if known.
 */
export function broadcastAgentExit(agentId: string, exitCode: number, lastOutput?: string, quickRun?: QuickAgentRun): void {
  if (lastOutput !== undefined) {
    broadcastToAllWindows(IPC.PTY.EXIT, agentId, exitCode, lastOutput);
  } else {
    broadcastToAllWindows(IPC.PTY.EXIT, agentId, exitCode);
  }
  annexEventBus.emitPtyExit(agentId, exitCode);
  for (const fn of exitListeners) {
    try { fn(agentId, exitCode, quickRun); } catch { /* ignore */ }
  }
}
