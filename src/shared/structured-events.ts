// ── Structured Mode Event Types ─────────────────────────────────────────────
// Normalized event layer for structured agent execution. Any provider adapter
// can emit these events, enabling native React UI controls regardless of the
// underlying CLI protocol.

export type StructuredEventType =
  | 'text_delta'
  | 'text_done'
  | 'tool_start'
  | 'tool_output'
  | 'tool_end'
  | 'file_diff'
  | 'command_output'
  | 'permission_request'
  | 'plan_update'
  | 'thinking'
  | 'error'
  | 'usage'
  | 'end';

export interface StructuredEvent {
  type: StructuredEventType;
  timestamp: number;
  data:
    | TextDelta
    | TextDone
    | ToolStart
    | ToolOutput
    | ToolEnd
    | FileDiff
    | CommandOutput
    | PermissionRequest
    | PlanUpdate
    | Thinking
    | ErrorEvent
    | UsageEvent
    | EndEvent;
}

// ── Data payloads ───────────────────────────────────────────────────────────

export interface TextDelta {
  text: string;
}

export interface TextDone {
  text: string; // full accumulated text
}

export interface ToolStart {
  id: string;
  name: string;
  displayVerb: string; // resolved from provider toolVerbMap
  input: Record<string, unknown>;
}

export interface ToolOutput {
  id: string;
  output: string; // streaming chunk
  isPartial: boolean;
}

export interface ToolEnd {
  id: string;
  name: string;
  result: string;
  durationMs: number;
  status: 'success' | 'error';
}

export interface FileDiff {
  path: string;
  changeType: 'create' | 'modify' | 'delete';
  diff: string; // unified diff format
}

export interface CommandOutput {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  output: string;
  exitCode?: number;
}

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
}

export interface PlanUpdate {
  steps: Array<{
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
  }>;
}

export interface Thinking {
  text: string;
  isPartial: boolean;
}

export interface ErrorEvent {
  code: string;
  message: string;
  toolId?: string;
}

export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface EndEvent {
  reason: 'complete' | 'error' | 'cancelled' | 'timeout';
  summary?: string;
}
