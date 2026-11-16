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
