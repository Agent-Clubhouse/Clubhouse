/**
 * Normalized events produced by the Claude chat driver, shared by both
 * transports (Agent SDK and raw `claude -p` stream-json).
 *
 * Provisional: the cross-provider chat contract (structured-events v2,
 * docs/structured-chat-research.md §7 "The contract") and the AgentRuntime
 * seam are being defined separately in src/shared. These names already follow
 * that vocabulary (ACP-style session / turn / message / tool_call /
 * permission_request), so mapping onto the shared contract once it lands
 * should be a rename, not a redesign.
 */

/** Claude Code's native permission modes. `-p` may start in `auto`, so callers always pass one. */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

/** Mirrors the CLI's PermissionUpdate (`permission_suggestions` on `can_use_tool`). */
export type ClaudePermissionUpdate = Record<string, unknown> & { type: string };

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Fields every event carries once the transport has stamped it. */
export interface ClaudeEventEnvelope {
  /** Native Claude session id; empty until `system/init` arrives. */
  sessionId: string;
  /** Clubhouse turn counter for this transport instance, starting at 1. */
  turnId: number;
  /** Monotonic sequence number for this transport instance, starting at 1. */
  seq: number;
}

export type ClaudeChatEventBody =
  | {
      kind: 'session_started';
      model: string;
      cwd: string;
      permissionMode: string;
      cliVersion: string;
      tools: string[];
      slashCommands: string[];
      apiKeySource?: string;
      capabilities?: unknown;
      /** MCP servers from init's `mcp_servers`; absent when the CLI didn't send the field. */
      mcpServers?: Array<{ name: string; status: string }>;
    }
  | {
      /** Result of the `initialize` control handshake: commands, models, agents, account. */
      kind: 'initialized';
      commands: Array<{ name: string; description?: string; argumentHint?: string }>;
      models: Array<{ value: string; displayName?: string; description?: string }>;
      raw: Record<string, unknown>;
    }
  | { kind: 'user_message'; text: string; uuid?: string; replay: boolean }
  | { kind: 'message_chunk'; messageId?: string; text: string; parentToolCallId?: string }
  | { kind: 'thought_chunk'; messageId?: string; text: string; parentToolCallId?: string }
  | { kind: 'message'; messageId: string; text: string; parentToolCallId?: string }
  | { kind: 'thought'; messageId: string; text: string; parentToolCallId?: string }
  | {
      kind: 'tool_call';
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
      parentToolCallId?: string;
    }
  | {
      kind: 'tool_call_update';
      toolCallId: string;
      name: string;
      status: 'completed' | 'failed';
      /** Text form of the tool_result content sent to the model. */
      content: string;
      /** The CLI's typed `tool_use_result` (e.g. `structuredPatch` for edits). */
      result?: unknown;
      parentToolCallId?: string;
    }
  | {
      kind: 'permission_request';
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      toolCallId?: string;
      suggestions: ClaudePermissionUpdate[];
      title?: string;
      description?: string;
      displayName?: string;
      blockedPath?: string;
      decisionReason?: string;
      agentId?: string;
    }
  | { kind: 'permission_cancelled'; requestId: string }
  | {
      kind: 'turn_ended';
      subtype: string;
      isError: boolean;
      result?: string;
      errors?: string[];
      durationMs?: number;
      numTurns?: number;
      totalCostUsd?: number;
      usage?: ClaudeUsage;
      modelUsage?: Record<string, unknown>;
      queuedTurnCount?: number;
      /** The model's stop_reason for the turn (`end_turn`, `max_tokens`, `refusal`, …). */
      stopReason?: string;
      /** Why the CLI's loop ended (`completed`, `prompt_too_long`, `blocking_limit`, `api_error`, …). */
      terminalReason?: string;
    }
  | {
      kind: 'rate_limit';
      status: string;
      rateLimitType?: string;
      resetsAt?: number;
      utilization?: number;
      isUsingOverage?: boolean;
    }
  | { kind: 'compacted'; trigger?: string; preTokens?: number }
  | { kind: 'subagent'; phase: 'started' | 'progress' | 'notification' | 'updated'; taskId: string; raw: Record<string, unknown> }
  | { kind: 'mode_changed'; permissionMode: string }
  | { kind: 'permission_denied'; toolName?: string; raw: Record<string, unknown> }
  | {
      kind: 'error';
      message: string;
      fatal: boolean;
      /** Claude's assistant `error` kind (`authentication_failed`, `rate_limit`, `max_output_tokens`, …). */
      apiError?: string;
    }
  /** A wire message the normalizer doesn't map yet. Logged as a drift signal, never dropped silently. */
  | { kind: 'unmapped'; type: string; subtype?: string; raw: Record<string, unknown> }
  | { kind: 'session_ended'; exitCode: number | null; signal: string | null; reason?: string }
  /**
   * `tool_progress`: a tool is still running (Bash/PowerShell progress, a
   * heartbeat for other long tools), or a subagent's API call is being retried.
   */
  | {
      kind: 'tool_progress';
      toolCallId: string;
      toolName: string;
      elapsedSeconds: number;
      heartbeat: boolean;
      parentToolCallId?: string;
      subagentType?: string;
      retry?: { attempt: number; maxRetries: number; retryDelayMs?: number; errorStatus?: number; errorCategory?: string };
    }
  /** `system/background_tasks_changed`: every live background task (replace semantics). */
  | { kind: 'background_tasks'; tasks: ClaudeBackgroundTask[] }
  /** `system/vcs_state_changed`: a commit, push, merge or rebase happened; the workspace's git state is stale. */
  | { kind: 'vcs_changed'; vcsKind: string; branch?: string; cwd?: string };

export interface ClaudeBackgroundTask {
  taskId: string;
  taskType: string;
  description: string;
  subagentType?: string;
  /** Ambient tasks aren't user-visible activity. */
  ambient: boolean;
}

export type ClaudeChatEvent = ClaudeEventEnvelope & ClaudeChatEventBody;
