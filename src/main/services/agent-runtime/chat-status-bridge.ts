/**
 * Derives the hook-shaped status events that terminal agents get from Claude
 * hooks, but from chat events, so the agent list, badges, notifications,
 * sounds, plugin `agent:hook` events and Annex detailed status work the same
 * for chat agents. Clubhouse's own hooks are not injected for chat agents.
 */

import type { AgentHookEvent } from '../../../shared/types';
import type { ChatEvent } from '../../../shared/chat';

/** Map a chat event to a hook event, or null when it doesn't change status. */
export function chatEventToHookEvent(event: ChatEvent, toolNames: Map<string, string>): AgentHookEvent | null {
  const timestamp = event.ts;
  switch (event.type) {
    case 'tool_call': {
      const toolName = event.data.toolName ?? event.data.kind;
      toolNames.set(event.data.toolCallId, toolName);
      if (event.data.status === 'completed') return { kind: 'post_tool', toolName, timestamp };
      if (event.data.status === 'failed') return { kind: 'tool_error', toolName, message: event.data.title, timestamp };
      return { kind: 'pre_tool', toolName, toolVerb: event.data.title, timestamp };
    }
    case 'tool_call_update': {
      const toolName = toolNames.get(event.data.toolCallId);
      if (event.data.status === 'completed') {
        toolNames.delete(event.data.toolCallId);
        return { kind: 'post_tool', toolName, timestamp };
      }
      if (event.data.status === 'failed') {
        toolNames.delete(event.data.toolCallId);
        return { kind: 'tool_error', toolName, message: event.data.error, timestamp };
      }
      return null;
    }
    case 'permission_request':
      return { kind: 'permission_request', toolName: event.data.toolName, message: event.data.title, timestamp };
    case 'permission_resolved':
      // As the hook server reports it: the decision rides in `message`, which
      // picks the granted or denied sound. A cancelled turn counts as denied.
      return { kind: 'permission_resolved', message: event.data.decision === 'allow' ? 'allow' : 'deny', timestamp };
    case 'turn_ended':
      return { kind: 'stop', timestamp };
    case 'error':
      return event.data.fatal ? { kind: 'tool_error', message: event.data.message, timestamp } : null;
    default:
      return null;
  }
}

/** Per-agent tool-name memory for post_tool events. */
export function createStatusBridge(emit: (agentId: string, hookEvent: AgentHookEvent) => void): (event: ChatEvent) => void {
  const toolNamesByAgent = new Map<string, Map<string, string>>();
  return (event) => {
    let toolNames = toolNamesByAgent.get(event.agentId);
    if (!toolNames) {
      toolNames = new Map();
      toolNamesByAgent.set(event.agentId, toolNames);
    }
    if (event.type === 'session_ended') toolNamesByAgent.delete(event.agentId);
    const hookEvent = chatEventToHookEvent(event, toolNames);
    if (hookEvent) emit(event.agentId, hookEvent);
  };
}
