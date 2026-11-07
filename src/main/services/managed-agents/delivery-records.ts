/**
 * What each running managed agent's session started with (D9), in memory.
 * Kept apart from the service so agent-config and the agent registry can
 * free a record without importing the managed-agents service.
 */
import type { DeliveryRecord } from './delivery';

export const delivered = new Map<string, DeliveryRecord>();
/** Agents whose last delivery failed, with the reason, until a delivery succeeds. */
export const failedDeliveries = new Map<string, string>();

/** The agent is gone (deleted, or a helper disposed): drop everything kept for it. */
export function forgetDelivery(agentId: string): void {
  delivered.delete(agentId);
  failedDeliveries.delete(agentId);
}

/**
 * Its session ended, so nothing runs what it started with: drop the text
 * Preview's "Running now" showed (D79). The fingerprint and CLI stay, since
 * a restart reads them right after the stop.
 */
export function dropRunningSnapshot(agentId: string): void {
  const record = delivered.get(agentId);
  if (!record?.snapshot) return;
  const { snapshot: _dropped, ...rest } = record;
  delivered.set(agentId, rest);
}
