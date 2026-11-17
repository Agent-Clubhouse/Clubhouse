/**
 * The Clubhouse MCP tools that join the Dispatcher's two agents (#3036). No
 * chat shows a call to them, on any provider, desktop or phone
 * (concealed-tools). Kept apart from dispatcher-service, which is heavy, so
 * the spawn path can read it without loading the service.
 */
export const DISPATCHER_INTERNAL_TOOLS: ReadonlySet<string> = new Set(['start_work', 'tell_user']);

/**
 * The Clubhouse MCP tools the CLI runs without its own permission check, by
 * bare name (#3578): the Dispatcher's internal tools for the chat, nothing for
 * anything else. `isDispatcherChat` is the gate's answer (dispatcher-gate
 * syncDispatcherGate): the chat's own agent id in the chat's own folder, so
 * another agent placed in that folder gets nothing.
 *
 * At Auto, Claude Code's classifier read start_work's request text and
 * refused relayed merge or release go-aheads it couldn't verify, leaving the
 * Dispatcher with no way to act. Skipping it there widens nothing: start_work
 * only files the request with the Dispatcher's coordinator, marked as not the
 * user's approval (dispatcher-channel handOffToDispatcher). Clubhouse's own
 * group and grant check still runs on every call (tool-registry callTool),
 * and whatever the request leads to is done by agents under their own
 * access, grants and asks.
 */
export function preapprovedClubhouseToolsFor(kind: string, isDispatcherChat: boolean): string[] | undefined {
  return kind === 'durable' && isDispatcherChat ? [...DISPATCHER_INTERNAL_TOOLS] : undefined;
}

/**
 * Whether a start offers the model every tool up front instead of behind the
 * CLI's tool search (#3615): the Dispatcher's two agents only, by their folders.
 *
 * Copilot's tool_search_tool leaves out tools the session already loaded,
 * resumes included, so the coordinator searching for create_managed_agent or a
 * wire tool, or the chat searching for start_work, finds nothing and gives up.
 * Its override hook doesn't help: runtime 1.0.107 keeps its own search. The
 * cost is each agent's whole catalog on every request, about 85 KB of
 * Clubhouse tools for the coordinator and 10 KB for the chat (measured in
 * dispatcher-tools.runtime.qa.ts). This grants nothing: the folder only picks
 * how tools are offered, and every call still goes through Clubhouse's group
 * and grant check and the CLI's own ask.
 */
export function loadsAllToolsUpFront(kind: string, isDispatcherFolder: boolean): boolean {
  return kind === 'durable' && isDispatcherFolder;
}
