import { IPC } from '../../shared/ipc-channels';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';

/**
 * Broadcast an agent exit event to both the renderer (via IPC) and the annex
 * event bus. These two notifications must always be paired — calling them
 * individually risks one side missing the exit if a code path forgets one.
 *
 * @param agentId  - The agent whose process exited.
 * @param exitCode - The process exit code.
 * @param lastOutput - Optional last PTY output for renderer diagnostics.
 */
export function broadcastAgentExit(agentId: string, exitCode: number, lastOutput?: string): void {
  if (lastOutput !== undefined) {
    broadcastToAllWindows(IPC.PTY.EXIT, agentId, exitCode, lastOutput);
  } else {
    broadcastToAllWindows(IPC.PTY.EXIT, agentId, exitCode);
  }
  annexEventBus.emitPtyExit(agentId, exitCode);
}
