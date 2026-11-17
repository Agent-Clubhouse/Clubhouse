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
