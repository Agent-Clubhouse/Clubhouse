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
 * - An agent with no config here, a quick agent, follows its project.
 * - A caller that isn't running is refused. The bridge only lets running agents in,
 *   so that takes something calling callTool directly.
 */

import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { isMcpEnabled, isMcpOnAtAppLevel } from '../mcp-settings';
import { notifyToolGateChange } from './orchestration-gate';
import type { DurableAgentConfig } from '../../../shared/types';

/** The one tool a helper keeps without MCP. */
export const HELPER_REPORT_TOOL = 'message_parent';

export type McpCallAccess = 'open' | 'report_only' | 'closed';

interface Caller {
  mcpOverride: boolean | undefined;
  helper: boolean;
}

const callers = new Map<string, Caller>();
/** What each caller last resolved to, so a change refreshes its tool list once. */
const lastAccess = new Map<string, McpCallAccess>();

/** What an agent running in `projectPath` may call now. `projectPath` is undefined for one that isn't running. */
export function mcpCallAccess(agentId: string, projectPath: string | undefined): McpCallAccess {
  if (projectPath === undefined) return 'closed';
  if (isDispatcherPath(projectPath)) return isMcpOnAtAppLevel() ? 'open' : 'closed';
  const caller = callers.get(agentId);
  if (isMcpEnabled(projectPath, caller?.mcpOverride)) return 'open';
  return caller?.helper ? 'report_only' : 'closed';
}

/** Record a running agent's config. Null is an agent with none, a quick one. Its tool list refreshes if its access moved. */
export function setMcpCaller(agentId: string, projectPath: string, config: Pick<DurableAgentConfig, 'mcpOverride' | 'parentAgentId'> | null | undefined): void {
  callers.set(agentId, { mcpOverride: config?.mcpOverride, helper: !!config?.parentAgentId });
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
