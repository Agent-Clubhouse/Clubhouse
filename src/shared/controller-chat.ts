import type { ChatEvent, ChatSessionSummary } from './chat';

/** Desktop reads only. This is deliberately separate from the phone/control contract. */
export const CONTROLLER_CHAT_PATH = '/api/v1/network/dispatcher/controller/chat';
export const CONTROLLER_CHAT_MAX_BYTES = 8 * 1024 * 1024;
export interface ControllerChatQuery {
  sessionId?: string;
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
}
export interface ControllerChatPage {
  version: 1;
  agentId: string | null;
  sessionId: string | null;
  currentSessionId: string | null;
  events: ChatEvent[];
  lastSeq: number;
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
  readOnly: true;
}
export type ControllerReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'unavailable' | 'offline' | 'forbidden' | 'error' };
export interface ControllerChatSessions { sessions: ChatSessionSummary[] }

/** Streamed replacements share one body; sequence cursors remain in the page metadata. */
export function controllerEventKey(event: ChatEvent): string | null {
  if (event.type === 'agent_message' || event.type === 'agent_message_chunk') return `${event.sessionId}:message:${event.data.messageId}`;
  if (event.type === 'agent_thought' || event.type === 'agent_thought_chunk') return `${event.sessionId}:thought:${event.data.messageId}`;
  if (event.type === 'tool_call' || event.type === 'tool_call_update') return `${event.sessionId}:tool:${event.data.toolCallId}`;
  return null;
}

/** Keep only the latest body per message/tool. A tool's initial metadata is retained once. */
export function compactControllerEvents(events: ChatEvent[]): ChatEvent[] {
  const latest = new Map<string, number>();
  const toolCalls = new Map<string, number>();
  for (const event of events) {
    const key = controllerEventKey(event);
    if (!key) continue;
    latest.set(key, Math.max(latest.get(key) ?? 0, event.seq));
    if (event.type === 'tool_call') toolCalls.set(key, Math.max(toolCalls.get(key) ?? 0, event.seq));
  }
  return events.flatMap((event) => {
    const key = controllerEventKey(event);
    if (!key || latest.get(key) === event.seq) return [event];
    if (event.type === 'tool_call' && toolCalls.get(key) === event.seq) return [{ ...event, data: { ...event.data, content: [] } }];
    return [];
  });
}
