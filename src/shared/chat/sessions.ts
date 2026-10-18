import type { ChatDriverId } from './capabilities';

/** Saved Clubhouse chat history; nativeSessionId is used only to resume the CLI. */
export interface ChatSessionSummary {
  sessionId: string;
  nativeSessionId?: string;
  driver?: ChatDriverId;
  provider?: string;
  startedAt: number;
  lastActiveAt: number;
  endedAt?: number;
  title?: string;
  lastSeq: number;
}
