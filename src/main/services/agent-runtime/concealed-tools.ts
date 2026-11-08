/**
 * Tool calls a chat never shows (#3036). Some Clubhouse MCP tools are plumbing
 * between agents that share one identity, and a person should never see them:
 * the Dispatcher's chat handing work over, or the Dispatcher reporting back.
 * ChatRuntime drops their tool_call events, and every update to them, before
 * the transcript, windows or phones see them, for every provider.
 *
 * Whoever owns such tools registers which ones an agent conceals. Nothing is
 * concealed unless a resolver says so.
 */

/** The Clubhouse MCP tools an agent conceals, by bare name, or null for none. */
export type ConcealedToolsResolver = (agentId: string) => ReadonlySet<string> | null;

const resolvers = new Set<ConcealedToolsResolver>();

/** Add a resolver. Returns a function that removes it. */
export function registerConcealedTools(resolver: ConcealedToolsResolver): () => void {
  resolvers.add(resolver);
  return () => { resolvers.delete(resolver); };
}

/**
 * A provider's name for a Clubhouse MCP tool, without its server:
 * `mcp__clubhouse__start_work` (Claude, Codex), `clubhouse.start_work`,
 * `clubhouse-start_work` (Copilot) or a bare `start_work` are all `start_work`.
 * Null for a tool of another MCP server, which is never concealed.
 */
export function clubhouseToolName(toolName: string | undefined): string | null {
  if (!toolName) return null;
  const match = toolName.match(/^(?:mcp__)?clubhouse(?:__|[./:-])([a-z_]+)$/i);
  if (match) return match[1];
  // A bare name has no server prefix: single underscores only.
  return /^[a-z]+(?:_[a-z]+)*$/i.test(toolName) ? toolName : null;
}

/** Whether this agent's chat leaves this tool call out. */
export function isConcealedTool(agentId: string, toolName: string | undefined): boolean {
  const bare = clubhouseToolName(toolName);
  if (!bare) return false;
  for (const resolver of resolvers) {
    if (resolver(agentId)?.has(bare)) return true;
  }
  return false;
}

/** For tests. */
export function _resetConcealedToolsForTesting(): void {
  resolvers.clear();
}
