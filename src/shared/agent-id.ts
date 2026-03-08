/**
 * Centralized agent ID generation.
 *
 * Both the renderer (agentStore) and the main process (annex-server) must use
 * the same scheme so that map look-ups, event routing, and cleanup never fail
 * due to an ID mismatch.
 */
export function generateQuickAgentId(): string {
  const suffix = globalThis.crypto.randomUUID().slice(0, 8);
  return `quick_${Date.now()}_${suffix}`;
}
