/**
 * What a new agent-to-agent wire lets its sender do (#2969, part of #2921).
 * A wire goes one way: its sender holds the tools, so each direction has its
 * own list. By default a sender may read the other agent, message it and wake
 * it (the maintainer's defaults, 2026-11-09); clearing or compacting it needs
 * the user to turn those tools on. The list is saved in the connection store
 * (D129), wake with it when the wire is drawn (`start`), and kept on the
 * canvas wire too, so an older build reading a new wire grants nothing more.
 */
export { NEW_CONNECTION_DISABLED_TOOLS as NEW_AGENT_WIRE_DISABLED_TOOLS } from './connection-grants';
import { NEW_CONNECTION_DISABLED_TOOLS as NEW_AGENT_WIRE_DISABLED_TOOLS } from './connection-grants';

/**
 * The tools a wire about to be drawn starts with off: the default for a new
 * agent-to-agent pair, nothing for any other target, and nothing for a pair
 * that already has a binding (a helper or Dispatcher wire, or a wire drawn
 * again), whose own list must not change.
 */
export function newWireDisabledTools(
  existing: ReadonlyArray<{ agentId: string; targetId: string }>,
  agentId: string,
  targetId: string,
  targetKind: string,
): string[] | undefined {
  if (targetKind !== 'agent') return undefined;
  if (existing.some((b) => b.agentId === agentId && b.targetId === targetId)) return undefined;
  return [...NEW_AGENT_WIRE_DISABLED_TOOLS];
}
