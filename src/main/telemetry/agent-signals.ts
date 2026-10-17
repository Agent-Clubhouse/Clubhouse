/**
 * Stateless agent signals (spec §4.4): hook events, tool calls, hook-path
 * permissions, Clubhouse MCP tool calls and CLI binary lookup. Imports only
 * the facade, so orchestrator and server modules can use it without an
 * import cycle through the agent registry.
 */
import { ATTR } from '../../shared/telemetry/attributes';
import { isTelemetryActive, replaySpan, tel } from './facade';

type Orchestrator = Parameters<typeof ATTR.orchestrator>[0];

// --- Hooks and tools ----------------------------------------------------------

const BUILTIN_TOOLS = new Set([
  'Bash', 'Edit', 'MultiEdit', 'Write', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Agent', 'Task',
  'TodoWrite', 'NotebookEdit', 'shell', 'apply_patch',
]);

/** Built-in tool names pass through; MCP tools are bucketed; anything else is `other`. */
export function toolBucket(toolName: string | undefined): Parameters<typeof ATTR.toolBucket>[0] {
  if (!toolName) return 'other';
  if (BUILTIN_TOOLS.has(toolName)) return toolName as Parameters<typeof ATTR.toolBucket>[0];
  if (/^mcp__(clubhouse|group|browser|terminal)/.test(toolName)) return 'mcp_clubhouse';
  if (toolName.startsWith('mcp__')) return 'mcp_other';
  return 'other';
}

const HOOK_KINDS = new Set(['pre_tool', 'post_tool', 'tool_error', 'stop', 'notification', 'permission_request']);

/** One hook event from an agent CLI. Counters only; never a span or log per event. */
export function recordHookEvent(orchestratorId: string | undefined, kind: string, toolName: string | undefined): void {
  if (!isTelemetryActive()) return;
  const orchestrator: Orchestrator =
    orchestratorId === 'claude-code' || orchestratorId === 'codex-cli' || orchestratorId === 'copilot-cli' ? orchestratorId : 'other';
  const hookKind = (HOOK_KINDS.has(kind) ? kind : 'other') as Parameters<typeof ATTR.hookKind>[0];
  tel.count('clubhouse.agent.hook_events', 1, [ATTR.orchestrator(orchestrator), ATTR.hookKind(hookKind)]);
  if (kind === 'post_tool' || kind === 'tool_error') {
    tel.count('clubhouse.agent.tool_calls', 1, [
      ATTR.orchestrator(orchestrator),
      ATTR.toolBucket(toolBucket(toolName)),
      ATTR.toolResult(kind === 'post_tool' ? 'ok' : 'error'),
    ]);
  }
}

/** A hook-path permission request settled (spec §4.4). */
export function recordPermission(opts: {
  startMs: number;
  orchestrator: string | undefined;
  toolName: string | undefined;
  decision: 'allow' | 'deny' | 'ask';
  timedOut: boolean;
}): void {
  if (!isTelemetryActive()) return;
  const endMs = Date.now();
  const orchestrator: Orchestrator =
    opts.orchestrator === 'claude-code' || opts.orchestrator === 'codex-cli' || opts.orchestrator === 'copilot-cli' ? opts.orchestrator : 'other';
  const result = ATTR.permissionResult(opts.timedOut ? 'timeout' : 'resolved');
  const decision = ATTR.permissionDecision(opts.decision);
  replaySpan({
    name: 'clubhouse.agent.permission',
    startMs: opts.startMs,
    endMs,
    attrs: [ATTR.orchestrator(orchestrator), ATTR.toolBucket(toolBucket(opts.toolName)), decision, result, ATTR.permissionPath('hook')],
    outcome: opts.timedOut ? 'timeout' : 'ok',
  });
  tel.count('clubhouse.agent.permission.wait', (endMs - opts.startMs) / 1000, [decision, result, ATTR.permissionPath('hook')]);
}

// --- Clubhouse MCP --------------------------------------------------------------

const MCP_KINDS = new Set(['clubhouse', 'browser', 'terminal', 'group', 'plugin']);

/**
 * One MCP tool call served by the bridge. `toolName` is only parsed locally,
 * never exported raw: the binding segment is dropped, and the suffix only
 * survives if it is on the registry's fixed list. Plugin tool names are
 * plugin-authored, so they are always `other`.
 */
export function recordMcpToolCall(toolName: string, startMs: number, result: 'ok' | 'tool_error' | 'threw', global: boolean): void {
  if (!isTelemetryActive()) return;
  type Kind = Parameters<typeof ATTR.mcpToolKind>[0];
  type Tool = Parameters<typeof ATTR.mcpTool>[0];
  const match = /^([a-z]+)__[A-Za-z0-9_]+__([A-Za-z_]+)$/.exec(toolName);
  const kind: Kind = global ? 'global' : match && MCP_KINDS.has(match[1]) ? (match[1] as Kind) : 'other';
  const tool: Tool = global ? (toolName as Tool) : match && kind !== 'plugin' && kind !== 'other' ? (match[2] as Tool) : 'other';
  const endMs = Date.now();
  replaySpan({
    name: 'clubhouse.mcp.tool_call',
    startMs,
    endMs,
    attrs: [ATTR.mcpToolKind(kind), ATTR.mcpTool(tool), ATTR.mcpResult(result)],
    outcome: result === 'ok' ? 'ok' : 'error',
    errorType: result === 'ok' ? undefined : result === 'threw' ? 'mcp_tool_threw' : 'mcp_tool_error',
  });
  tel.count('clubhouse.mcp.tool_calls', 1, [ATTR.mcpToolKind(kind), ATTR.mcpTool(tool), ATTR.mcpResult(result)]);
  tel.count('clubhouse.mcp.tool_call.duration', (endMs - startMs) / 1000, [ATTR.mcpToolKind(kind)]);
}

// --- Binary lookup --------------------------------------------------------------

/** How long resolving a CLI binary took, and which tier answered (§12 H2, #1926). */
export function recordBinaryLookup(tier: Parameters<typeof ATTR.binaryLookupTier>[0], startMs: number): void {
  if (!isTelemetryActive()) return;
  tel.count('clubhouse.provider.binary_lookup.duration', (Date.now() - startMs) / 1000, [ATTR.binaryLookupTier(tier)]);
}
