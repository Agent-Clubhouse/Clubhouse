import { IPC } from '../../shared/ipc-channels';
import { setChannelPolicy } from './ipc-broadcast';

/**
 * Frame interval (~60 fps). PTY data chunks are concatenated within this
 * window so the renderer receives at most one IPC message per agent per frame.
 */
const PTY_DATA_INTERVAL_MS = 16;

/**
 * Hook events are semantically distinct and cannot be merged, but can be
 * queued and flushed in bursts to reduce IPC round-trips.
 */
const HOOK_EVENT_INTERVAL_MS = 50;

/**
 * Register the default throttle policies for high-frequency IPC channels.
 * Called once during app initialization before any IPC handlers are registered.
 */
export function registerDefaultBroadcastPolicies(): void {
  // PTY data: batch by concatenating data strings per agent
  // Call shape: broadcastToAllWindows(IPC.PTY.DATA, agentId, data)
  setChannelPolicy(IPC.PTY.DATA, {
    intervalMs: PTY_DATA_INTERVAL_MS,
    merge: true,
    keyFn: (agentId) => String(agentId),
    mergeFn: (existing, incoming) => [
      existing[0], // agentId (unchanged)
      (existing[1] as string) + (incoming[1] as string), // concatenate data
    ],
  });

  // Hook events: queue per agent and flush in bursts
  // Call shape: broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, hookEvent)
  setChannelPolicy(IPC.AGENT.HOOK_EVENT, {
    intervalMs: HOOK_EVENT_INTERVAL_MS,
    merge: false,
    keyFn: (agentId) => String(agentId),
  });
}
