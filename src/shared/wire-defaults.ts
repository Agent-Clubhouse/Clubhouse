/**
 * What a new agent-to-agent wire lets its sender do (#2969, part of #2921).
 * A wire goes one way: its sender holds the tools, so each direction has its
 * own list. By default a sender may read the other agent and message it;
 * clearing or compacting it needs the user to turn those tools on in the
 * wire's permissions. The list is the wire's `disabledTools`, which every
 * build already honours, so an older build reading a new wire grants nothing
 * more, and wires saved before this keep exactly what they had.
 */
export const NEW_AGENT_WIRE_DISABLED_TOOLS: readonly string[] = ['clear_agent', 'compact_agent'];
