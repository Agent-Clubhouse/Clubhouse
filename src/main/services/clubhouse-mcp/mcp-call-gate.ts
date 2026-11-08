/**
 * MCP call gate: the one check on every new tool call and tool list, by who
 * the caller is. tool-registry asks it at the entry of callTool and
 * getScopedToolList, before any lookup, so wires, group projects, browser,
 * plugin and global tools and call_wire_tool's inner call are all covered. A
 * call already running finishes. Nothing here stops an agent.
 *
 * The Clubhouse MCP always runs, and no setting turns it off for an app, a
 * project or an agent, so a caller this knows is open:
 *
 * - The Dispatcher, a quick agent, a durable agent and a helper are open.
 * - A durable agent whose row is missing is open too, as before.
 * - An agent whose config couldn't be read at start is refused until a read
 *   succeeds: whether it's a helper is unknown, so its tools can't be scoped.
 * - Anything else this doesn't know is refused, running or not. The bridge only lets
 *   running agents in, so that takes something calling callTool directly.
 *
 * spawnAgent sets this before it sets the agent's nonce, and the bridge refuses
 * everything without one, so no call can arrive before it.
 */

import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { notifyToolGateChange } from './orchestration-gate';
import type { DurableAgentConfig } from '../../../shared/types';

export type McpCallAccess = 'open' | 'closed';

export type McpCallerKind = 'quick' | 'durable' | 'helper' | 'unreadable';

const callers = new Map<string, McpCallerKind>();
/** A helper's orchestrator, for the grant check's `parent` (#2968). */
const parents = new Map<string, string>();
/** What each caller last resolved to, so a change refreshes its tool list once. */
const lastAccess = new Map<string, McpCallAccess>();

/** What an agent running in `projectPath` may call now. `projectPath` is undefined for one that isn't running. */
export function mcpCallAccess(agentId: string, projectPath: string | undefined): McpCallAccess {
  if (projectPath === undefined) return 'closed';
  if (isDispatcherPath(projectPath)) return 'open';
  const kind = callers.get(agentId);
  return !kind || kind === 'unreadable' ? 'closed' : 'open';
}

/** A quick agent is starting: it has no config, and never gets one. */
export function setMcpCallerQuick(agentId: string, projectPath: string): void {
  recordCaller(agentId, projectPath, 'quick');
}

/**
 * Record a durable agent's config, or a missing row as null. Its tool list refreshes
 * if its access moved. For a quick agent this only refreshes: its kind doesn't change.
 */
export function setMcpCaller(agentId: string, projectPath: string, config: Pick<DurableAgentConfig, 'parentAgentId'> | null | undefined): void {
  if (callers.get(agentId) === 'quick') {
    recordCaller(agentId, projectPath, 'quick');
    return;
  }
  if (config?.parentAgentId) parents.set(agentId, config.parentAgentId);
  else parents.delete(agentId);
  recordCaller(agentId, projectPath, config?.parentAgentId ? 'helper' : 'durable');
}

/** A durable agent whose config couldn't be read at start: closed until setMcpCaller has one. */
export function setMcpCallerUnreadable(agentId: string, projectPath: string): void {
  recordCaller(agentId, projectPath, 'unreadable');
}

/** A running helper's orchestrator, or undefined. */
export function mcpCallerParent(agentId: string): string | undefined {
  return parents.get(agentId);
}

/** What this running agent was recorded as. */
export function mcpCallerKind(agentId: string): McpCallerKind | undefined {
  return callers.get(agentId);
}

function recordCaller(agentId: string, projectPath: string, kind: McpCallerKind): void {
  callers.set(agentId, kind);
  const access = mcpCallAccess(agentId, projectPath);
  const before = lastAccess.get(agentId);
  lastAccess.set(agentId, access);
  if (before !== undefined && before !== access) notifyToolGateChange(agentId);
}

/** The agent stopped. */
export function forgetMcpCaller(agentId: string): void {
  callers.delete(agentId);
  parents.delete(agentId);
  lastAccess.delete(agentId);
}

/** For testing: forget every agent. */
export function _resetMcpCallGateForTesting(): void {
  callers.clear();
  parents.clear();
  lastAccess.clear();
}
