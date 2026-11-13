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
   * Tools that stay off unless turned on here. On this computer that's wake
   * ({@link WAKE_TOOL}, #3215), so a direction saved before the switch existed
   * reads as off. Across machines wake is on unless it's in `disabledTools` (D232).
   */
  enabledTools?: string[];
  /**
   * The Dispatcher set these tools, on a link it made (#3215), so it may change
   * them again. Any other write clears it: then they're the user's.
   */
  setBy?: 'dispatcher';
  /** The agent that last set this direction's switches. A user edit clears it. */
  setByAgent?: string;
  /**
   * The user made this direction here (Make two-way on the Connections card),
   * so the store keeps it connected itself, with no other source needed.
   */
  link?: { createdAt: string };
  /** Last source inspection from the network sender, used to protect its local switches. */
  agentToolsProtected?: boolean;
  /** Agent-created network sources, identified by creator and its machine. */
  agentLinks?: Array<{ agentId: string; machineId: string; createdAt: string; name?: string; removedAt?: string; removedByUser?: boolean }>;
  updatedAt: string;
}

/** Agent sources still holding a direction; removed sources are retained as sync tombstones. */
export function activeAgentLinks(direction: Pick<ConnectionDirection, 'agentLinks'> | undefined): NonNullable<ConnectionDirection['agentLinks']> {
  return (direction?.agentLinks ?? []).filter((link) => !link.removedAt);
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

/** Wake: a switch of its own on each direction, beside the connection tools (D232 across machines, #3215 here). */
export const WAKE_TOOL = 'wake_agent';

/** The wake switch, as the connection tools are described. */
export const WAKE_SWITCH: { tool: string; action: GrantAction; label: string } = { tool: WAKE_TOOL, action: 'agent.wake', label: 'Wake it' };

/** Every switch a direction has: the connection tools, then wake. */
export const CONNECTION_SWITCHES: ReadonlyArray<{ tool: string; action: GrantAction; label: string }> = [...CONNECTION_TOOLS, WAKE_SWITCH];

/**
 * Whether a direction between two agents on this computer lets its sender
 * wake the receiver (#3215): a saved direction only when turned on there, so
 * one saved before the switch can't. With nothing saved, its source's starting
 * switches decide (`sourceEnabled`, the live binding's, #3214); none: off.
 */
export function localWakeOn(
  direction: Pick<ConnectionDirection, 'disabledTools' | 'enabledTools'> | undefined,
  sourceEnabled: readonly string[] = [],
): boolean {
  if (!direction) return sourceEnabled.includes(WAKE_TOOL);
  return !!direction.enabledTools?.includes(WAKE_TOOL) && !direction.disabledTools.includes(WAKE_TOOL);
}

/** One direction's switches read back: the tools its sender may use, and the ones turned off. */
export interface DirectionTools {
  allowed: string[];
  disabled: string[];
}

/**
 * The switches of a direction between two agents on this computer, in
 * {@link CONNECTION_SWITCHES} order. No entry reads as its source's tools
 * (`sourceDisabled` and `sourceEnabled`, the live binding's lists).
 */
export function localDirectionTools(
  direction: Pick<ConnectionDirection, 'disabledTools' | 'enabledTools'> | undefined,
  sourceDisabled: readonly string[] = [],
  sourceEnabled: readonly string[] = [],
): DirectionTools {
  const disabledTools = direction?.disabledTools ?? sourceDisabled;
  const wake = localWakeOn(direction, sourceEnabled);
  const out: DirectionTools = { allowed: [], disabled: [] };
  for (const { tool } of CONNECTION_SWITCHES) {
    const on = tool === WAKE_TOOL ? wake : !disabledTools.includes(tool);
    (on ? out.allowed : out.disabled).push(tool);
  }
  return out;
}

/**
 * A direction's lists from the tools to allow on it, on this computer: every
 * connection tool left out is turned off, and wake is on only when named.
 */
export function localToolsFromAllow(allow: readonly string[]): { disabledTools: string[]; enabledTools: string[] } {
  return {
    disabledTools: CONNECTION_TOOLS.map((t) => t.tool).filter((t) => !allow.includes(t)),
    enabledTools: allow.includes(WAKE_TOOL) ? [WAKE_TOOL] : [],
  };
}

/**
 * What a new connection between two agents leaves off: clearing or compacting
 * the other agent needs turning on (#2969). The only things it does to the
 * other agent are send to it and wake it (the maintainer, 2026-11-09).
 */
export const NEW_CONNECTION_DISABLED_TOOLS: readonly string[] = ['clear_agent', 'compact_agent'];

/** The switches a new connection on this computer turns on: wake, off unless named (#3215). */
export const NEW_CONNECTION_ENABLED_TOOLS: readonly string[] = [WAKE_TOOL];

/** One direction's starting switches: the connection tools off, and the switches on (wake). */
export interface StartingSwitches {
  readonly disabledTools: readonly string[];
  readonly enabledTools: readonly string[];
}

/** A new connection: read, message and wake; clear and compact off. */
export const NEW_CONNECTION_SWITCHES: StartingSwitches = { disabledTools: NEW_CONNECTION_DISABLED_TOOLS, enabledTools: NEW_CONNECTION_ENABLED_TOOLS };

/** Every switch on, wake included. */
export const EVERY_SWITCH_ON: StartingSwitches = { disabledTools: [], enabledTools: [WAKE_TOOL] };

/**
 * What each direction of a connection Clubhouse makes itself starts with
 * (#3214, #3281, #3333). Every direction starts like a new connection:
 * read, message and wake, with clear and compact off. Saved switches win.
 */
export const AUTOMATIC_CONNECTION_SWITCHES: {
  readonly parentToHelper: StartingSwitches;
  readonly helperToParent: StartingSwitches;
  readonly dispatcherToAgent: StartingSwitches;
  readonly agentToDispatcher: StartingSwitches;
  readonly orchestratorLink: StartingSwitches;
} = {
  parentToHelper: NEW_CONNECTION_SWITCHES,
  helperToParent: NEW_CONNECTION_SWITCHES,
  dispatcherToAgent: NEW_CONNECTION_SWITCHES,
  agentToDispatcher: NEW_CONNECTION_SWITCHES,
  orchestratorLink: NEW_CONNECTION_SWITCHES,
};

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
  const toolList = (v: unknown): string[] => (Array.isArray(v)
    ? [...new Set(v.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 100))]
    : []);
  const disabledTools = toolList(r.disabledTools);
  const enabledTools = toolList(r.enabledTools);
  const link = r.link && typeof r.link === 'object' && typeof (r.link as { createdAt?: unknown }).createdAt === 'string'
    ? { createdAt: (r.link as { createdAt: string }).createdAt }
    : undefined;
  const agentLinks = Array.isArray(r.agentLinks) ? r.agentLinks.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.agentId !== 'string' || !item.agentId || item.agentId.length > 200 || typeof item.machineId !== 'string' || !item.machineId || item.machineId.length > 200 || typeof item.createdAt !== 'string') return [];
    return [{ agentId: item.agentId, machineId: item.machineId, createdAt: item.createdAt, ...(typeof item.name === 'string' && item.name.length <= 200 && { name: item.name }), ...(typeof item.removedAt === 'string' && !Number.isNaN(Date.parse(item.removedAt)) && { removedAt: item.removedAt }), ...(item.removedByUser === true && { removedByUser: true }) }];
  }).slice(0, 50) : [];
  return {
    from, to, disabledTools,
    ...(agentLinks.length > 0 && { agentLinks }),
    ...(typeof r.agentToolsProtected === 'boolean' && { agentToolsProtected: r.agentToolsProtected }),
    ...(enabledTools.length > 0 && { enabledTools }),
    ...(r.setBy === 'dispatcher' && { setBy: 'dispatcher' as const }),
    ...(typeof r.setByAgent === 'string' && r.setByAgent.length > 0 && r.setByAgent.length <= 200 && { setByAgent: r.setByAgent }),
    ...(link && { link }),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
  };
}
