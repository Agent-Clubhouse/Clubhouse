/**
 * Agent MCP connection events. The bridge server reports each completed
 * handshake here; consumers (group-project lifecycle) subscribe without
 * importing the server itself.
 */

export type AgentConnectedListener = (agentId: string) => void;

const listeners = new Set<AgentConnectedListener>();

/** Subscribe to completed agent MCP handshakes. Returns an unsubscribe function. */
export function onAgentMcpConnected(listener: AgentConnectedListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by the bridge server when an agent finishes the MCP handshake. */
export function emitAgentMcpConnected(agentId: string): void {
  for (const listener of listeners) {
    try {
      listener(agentId);
    } catch {
      // telemetry-exempt: a failing listener must not break the bridge
    }
  }
}
