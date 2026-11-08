/**
 * Per-direction permissions on a connection between two agents (#2969,
 * #2972, part of #2921; D129). The connection is the link (#3056): each
 * direction carries what its sender may do to the receiver, wherever the
 * connection came from (a canvas wire, a helper, the Dispatcher, a link an
 * agent or the user made). A canvas wire is one way to draw a connection,
 * not the place its permissions live.
 *
 * Kept in main (`connection-grants.json`), keyed by sender and receiver. An
 * address names the machine too once agents are reachable across machines
 * (#3056 Stage 6); today it's always this one.
 */

import type { GrantAction } from './agent-grants';

/** One end of a connection. `machineId` is unset for this machine. */
export interface AgentAddress {
  agentId: string;
  machineId?: string;
}

/** One direction of a connection: what `from` may do to `to`. */
export interface ConnectionDirection {
  from: AgentAddress;
  to: AgentAddress;
  /** The wire tools `from` may not use on `to`. Everything else its grants allow is allowed. */
  disabledTools: string[];
  /**
   * The user made this direction here (Make two-way on the Connections card),
   * so the store keeps it connected itself, with no other source needed.
   */
  link?: { createdAt: string };
  updatedAt: string;
}

/** The tools a wire from one agent to another offers its sender, by what they do. */
export const CONNECTION_TOOLS: ReadonlyArray<{ tool: string; action: GrantAction; label: string }> = [
  { tool: 'get_status', action: 'agent.read', label: 'See status' },
  { tool: 'read_output', action: 'agent.read', label: 'Read output' },
  { tool: 'check_connectivity', action: 'agent.read', label: 'Check it is reachable' },
  { tool: 'send_message', action: 'agent.message', label: 'Send messages' },
  { tool: 'send_file', action: 'agent.message', label: 'Send files' },
  { tool: 'clear_agent', action: 'agent.reset', label: 'Clear its context' },
  { tool: 'compact_agent', action: 'agent.reset', label: 'Compact its context' },
];

/**
 * What a new connection between two agents lets its sender do: read the other
 * agent and message it. Clearing or compacting it needs turning on (#2969).
 */
export const NEW_CONNECTION_DISABLED_TOOLS: readonly string[] = ['clear_agent', 'compact_agent'];

/** The key one direction is stored under. */
export function directionKey(from: AgentAddress, to: AgentAddress): string {
  return `${from.machineId ?? ''}/${from.agentId}>${to.machineId ?? ''}/${to.agentId}`;
}

/** A direction read back from disk: anything malformed is dropped; unknown tool names are kept (a newer build's). */
export function normalizeConnectionDirection(raw: unknown): ConnectionDirection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const address = (v: unknown): AgentAddress | null => {
    if (!v || typeof v !== 'object') return null;
    const a = v as Record<string, unknown>;
    if (typeof a.agentId !== 'string' || !a.agentId || a.agentId.length > 200) return null;
    return { agentId: a.agentId, ...(typeof a.machineId === 'string' && a.machineId && a.machineId.length <= 200 && { machineId: a.machineId }) };
  };
  const from = address(r.from);
  const to = address(r.to);
  if (!from || !to) return null;
  const disabledTools = Array.isArray(r.disabledTools)
    ? [...new Set(r.disabledTools.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 100))]
    : [];
  const link = r.link && typeof r.link === 'object' && typeof (r.link as { createdAt?: unknown }).createdAt === 'string'
    ? { createdAt: (r.link as { createdAt: string }).createdAt }
    : undefined;
  return { from, to, disabledTools, ...(link && { link }), updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString() };
}
