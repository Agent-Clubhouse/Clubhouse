/**
 * The built-in Assistant was removed, but restart-session state written by an
 * older version may still list its ephemeral `assistant_*` agents. Those must
 * never be resumed.
 */

/** Check if an agent ID belongs to the (removed) Clubhouse Assistant. */
export function isAssistantAgent(agentId: string): boolean {
  return agentId.startsWith('assistant_');
}
