/**
 * Shared utilities for identifying assistant agents.
 * Used across main and renderer processes.
 */

/** Check if an agent ID belongs to the Clubhouse Assistant. */
export function isAssistantAgent(agentId: string): boolean {
  return agentId.startsWith('assistant_');
}
