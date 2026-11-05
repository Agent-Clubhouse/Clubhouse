/**
 * MCP call gate: the one check on every new tool call and tool list, by the
 * caller's effective Clubhouse MCP. tool-registry asks it at the entry of callTool
 * and getScopedToolList, before any lookup, so wires, group projects, browser,
 * plugin and global tools and call_wire_tool's inner call are all covered. A call
 * already running finishes. Nothing here stops an agent.
 *
 * Effective is isMcpEnabled(projectPath, the agent's own `mcpOverride`), read live,
 * so an app or project change applies to the next call. The override comes from the
 * agent's config, kept here so the check stays synchronous: set at spawn and
 * refreshed from orchestration-policy's MCP listeners, as dispatcher-gate is.
 *
 * - The Dispatcher follows MCP at app level. Its own override doesn't count.
 * - A helper is read with its raw `mcpOverride`, not clubhouseMcpOverride, which
 *   forces its bridge on so it can start. Without MCP it keeps only message_parent:
 *   it must be able to report (#2610), and delivery goes through the parent's
 *   runtime, not the parent's MCP.
 * - A quick agent has no config and follows its project.
 * - A durable agent whose row is missing has no override, so it follows its project too.
 * - An agent whose config couldn't be read at start is refused until a read
 *   succeeds. Its override is unknown, and so is whether it's a helper, so it can't
 *   keep message_parent either, and a parent may not hear from that helper.
 * - Anything else this doesn't know is refused, running or not. The bridge only lets
 *   running agents in, so that takes something calling callTool directly.
 *
 * spawnAgent sets this before it sets the agent's nonce, and the bridge refuses
 * everything without one, so no call can arrive before it.
 */

import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { isMcpEnabled, isMcpOnAtAppLevel } from '../mcp-settings';
import { notifyToolGateChange } from './orchestration-gate';
import type { DurableAgentConfig } from '../../../shared/types';

/** The one tool a helper keeps without MCP. */
export const HELPER_REPORT_TOOL = 'message_parent';

export type McpCallAccess = 'open' | 'report_only' | 'closed';

export type McpCallerKind = 'quick' | 'durable' | 'helper' | 'unreadable';

interface Caller {
  kind: McpCallerKind;
  /** The agent's own raw setting. A helper's is read as saved, not forced on. */
  mcpOverride?: boolean;
}

const callers = new Map<string, Caller>();
/** What each caller last resolved to, so a change refreshes its tool list once. */
const lastAccess = new Map<string, McpCallAccess>();

/** What an agent running in `projectPath` may call now. `projectPath` is undefined for one that isn't running. */
export function mcpCallAccess(agentId: string, projectPath: string | undefined): McpCallAccess {
  if (projectPath === undefined) return 'closed';
  if (isDispatcherPath(projectPath)) return isMcpOnAtAppLevel() ? 'open' : 'closed';
  const caller = callers.get(agentId);
  if (!caller || caller.kind === 'unreadable') return 'closed';
  if (isMcpEnabled(projectPath, caller.mcpOverride)) return 'open';
  return caller.kind === 'helper' ? 'report_only' : 'closed';
}

/** A quick agent is starting: it has no config, and never gets one. */
export function setMcpCallerQuick(agentId: string, projectPath: string): void {
  recordCaller(agentId, projectPath, { kind: 'quick' });
}

/**
 * Record a durable agent's config, or a missing row as null. Its tool list refreshes
 * if its access moved. For a quick agent this only refreshes: its kind doesn't change.
 */
export function setMcpCaller(agentId: string, projectPath: string, config: Pick<DurableAgentConfig, 'mcpOverride' | 'parentAgentId'> | null | undefined): void {
  if (callers.get(agentId)?.kind === 'quick') {
    recordCaller(agentId, projectPath, { kind: 'quick' });
    return;
  }
  recordCaller(agentId, projectPath, { kind: config?.parentAgentId ? 'helper' : 'durable', mcpOverride: config?.mcpOverride });
}

/** A durable agent whose config couldn't be read at start: closed until setMcpCaller has one. */
export function setMcpCallerUnreadable(agentId: string, projectPath: string): void {
  recordCaller(agentId, projectPath, { kind: 'unreadable' });
}

/** What this running agent was recorded as, for counting what a change would close. */
export function mcpCallerKind(agentId: string): McpCallerKind | undefined {
  return callers.get(agentId)?.kind;
}

function recordCaller(agentId: string, projectPath: string, caller: Caller): void {
  callers.set(agentId, caller);
  const access = mcpCallAccess(agentId, projectPath);
  const before = lastAccess.get(agentId);
  lastAccess.set(agentId, access);
  if (before !== undefined && before !== access) notifyToolGateChange(agentId);
}

/** The agent stopped. */
export function forgetMcpCaller(agentId: string): void {
  callers.delete(agentId);
  lastAccess.delete(agentId);
}

/** For testing: forget every agent. */
export function _resetMcpCallGateForTesting(): void {
  callers.clear();
  lastAccess.clear();
}
