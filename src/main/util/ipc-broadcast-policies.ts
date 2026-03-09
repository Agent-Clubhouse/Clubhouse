import { IPC } from '../../shared/ipc-channels';
import { setChannelPolicy } from './ipc-broadcast';

/**
 * Frame interval (~60 fps). PTY data chunks are concatenated within this
 * window so the renderer receives at most one IPC message per agent per frame.
 */
const PTY_DATA_INTERVAL_MS = 16;

/**
 * Hook events are semantically distinct and cannot be merged into one, but
 * can be batched into an array and sent as a single IPC message per flush
 * to avoid N-events × M-windows multiplicative IPC overhead.
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

  // Hook events: batch per agent into an array and flush as a single IPC message
  // Call shape: broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, hookEvent)
  // Flush shape: sendToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, hookEvent | hookEvent[])
  setChannelPolicy(IPC.AGENT.HOOK_EVENT, {
    intervalMs: HOOK_EVENT_INTERVAL_MS,
    merge: true,
    keyFn: (agentId) => String(agentId),
    mergeFn: (existing, incoming) => {
      const batch = Array.isArray(existing[1]) ? existing[1] : [existing[1]];
      batch.push(incoming[1]);
      return [existing[0], batch];
    },
  });
}
