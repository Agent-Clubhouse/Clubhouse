/**
 * Normalized session event format that all providers emit.
 * Used by the Sessions plugin to display session timelines.
 */
export interface SessionEvent {
  id: string;
  timestamp: number;           // ms since epoch (from JSONL record or file stat)
  type: 'user_message' | 'assistant_message' | 'tool_use' | 'tool_result' | 'system' | 'result';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  text?: string;               // message text or tool result summary
  filePath?: string;           // for file modifications (Write/Edit tools)
  usage?: { inputTokens: number; outputTokens: number };
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
  totalInputTokens: number;
  totalOutputTokens: number;
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
