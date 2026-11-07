/**
 * Normalized session event format that all providers emit.
 * Returned by the agents API's session transcript readers.
 */
export interface SessionEvent {
  id: string;
  timestamp: number;           // ms since epoch (from JSONL record or file stat)
  /** `usage`: a message that had usage and nothing else to show (thinking only). */
  type: 'user_message' | 'assistant_message' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'usage';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  text?: string;               // message text or tool result summary
  filePath?: string;           // for file modifications (Write/Edit tools)
  /**
   * One message's usage, once, on the first event of that message. A figure the
   * transcript did not report is absent (not 0). `inputTokens` excludes cache
   * reads and writes, as the transcript gives it. `conflict`: repeated records of
   * the message disagreed, so these figures are the highest seen per field, which
   * may match no actual record and must not be treated as a measured sample.
   */
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; conflict?: boolean };
  /** This event stands for an assistant message the transcript gave no usage for. */
  usageMissing?: boolean;
  /** The provider's id for the message this event came from, when it had one. */
  messageId?: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}

export interface SessionSummary {
  summary: string | null;
  filesModified: string[];
  totalToolCalls: number;
  toolsUsed: string[];         // unique tool names
  totalCostUsd: number;
  totalDurationMs: number;
  /** Sums of what the transcript reported, each message once. Uncached input; see `totalCache*`. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  /** `partial`: some message lacked input or output, or repeated records disagreed. `none`: no usage was found. */
  tokenUsage?: 'complete' | 'partial' | 'none';
  /** Messages whose repeated records disagreed. */
  tokenUsageConflicts?: number;
  model: string | null;
  orchestrator: string | null;
  eventCount: number;
  startedAt: string | null;    // ISO string
  lastActiveAt: string | null; // ISO string
}

export interface SessionTranscriptPage {
  events: SessionEvent[];
  totalEvents: number;
}
