import type { ClaudeBackgroundTask, ClaudeChatEvent, ClaudeChatEventBody, ClaudePermissionUpdate, ClaudeUsage } from './events';

/**
 * One stream-json wire message as `claude -p --output-format stream-json`
 * writes it. The Agent SDK yields these same objects as `SDKMessage`, so both
 * transports feed one normalizer (docs/structured-chat-research.md §7).
 */
export type ClaudeWireMessage = Record<string, unknown> & { type: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function toUsage(v: unknown): ClaudeUsage | undefined {
  if (!isObj(v)) return undefined;
  return {
    inputTokens: num(v.input_tokens) ?? 0,
    outputTokens: num(v.output_tokens) ?? 0,
    cacheReadInputTokens: num(v.cache_read_input_tokens) ?? 0,
    cacheCreationInputTokens: num(v.cache_creation_input_tokens) ?? 0,
  };
}

/** Flatten a tool_result's content (string or content blocks) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((b) => (isObj(b) && b.type === 'text' ? str(b.text) ?? '' : ''))
    .filter(Boolean)
    .join('\n');
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((b) => (isObj(b) && b.type === 'text' ? str(b.text) ?? '' : ''))
    .join('');
}

const SUBAGENT_PHASES: Record<string, 'started' | 'progress' | 'notification' | 'updated'> = {
  task_started: 'started',
  task_progress: 'progress',
  task_notification: 'notification',
  task_updated: 'updated',
};

/**
 * Stateful mapper from Claude stream-json wire messages to Clubhouse chat
 * events, stamping each with session id, turn id and sequence number.
 *
 * Both transports own one instance per session. Control-protocol frames
 * (`control_request` / `control_response`) never reach it: transports handle
 * those and call {@link emit} for the events they produce (permissions,
 * initialize results).
 */
export class ClaudeNormalizer {
  private sessionId = '';
  private turnId = 1;
  private seq = 0;
  /** Bumped by the next event after a turn ends, so `turn_ended` keeps its turn's id. */
  private turnPending = false;
  private readonly toolNames = new Map<string, string>();
  private readonly streamMessageIds = new Map<string, string>();

  get currentSessionId(): string {
    return this.sessionId;
  }

  /** Stamp a transport-produced event body with the envelope. */
  emit(body: ClaudeChatEventBody): ClaudeChatEvent {
    if (this.turnPending && body.kind !== 'session_ended') {
      this.turnPending = false;
      this.turnId += 1;
    }
    this.seq += 1;
    return { ...body, sessionId: this.sessionId, turnId: this.turnId, seq: this.seq };
  }

  normalize(msg: ClaudeWireMessage): ClaudeChatEvent[] {
    const sid = str(msg.session_id);
    if (sid) this.sessionId = sid;
    return this.map(msg).map((b) => {
      const ev = this.emit(b);
      if (b.kind === 'turn_ended') this.turnPending = true;
      return ev;
    });
  }

  private map(msg: ClaudeWireMessage): ClaudeChatEventBody[] {
    const parentToolCallId = str(msg.parent_tool_use_id);
    switch (msg.type) {
      case 'system':
        return this.mapSystem(msg);
      case 'stream_event':
        return this.mapStreamEvent(msg, parentToolCallId);
      case 'assistant':
        return this.mapAssistant(msg, parentToolCallId);
      case 'user':
        return this.mapUser(msg, parentToolCallId);
      case 'result':
        return [this.mapResult(msg)];
      case 'rate_limit_event': {
        const info = isObj(msg.rate_limit_info) ? msg.rate_limit_info : {};
        return [{
          kind: 'rate_limit',
          status: str(info.status) ?? 'unknown',
          rateLimitType: str(info.rateLimitType),
          resetsAt: num(info.resetsAt),
          utilization: num(info.utilization),
          isUsingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined,
          overageStatus: str(info.overageStatus),
          overageResetsAt: num(info.overageResetsAt),
          overageDisabledReason: str(info.overageDisabledReason),
        }];
      }
      case 'keep_alive':
        return [];
      case 'tool_progress':
        return [this.mapToolProgress(msg, parentToolCallId)];
      // A queued prompt's fate (queued, started, completed, …). Clubhouse
      // tracks its own queue and sends no command uuids, so there's nothing to show.
      case 'command_lifecycle':
        return [];
      default:
        return [{ kind: 'unmapped', type: msg.type, subtype: str(msg.subtype), raw: msg }];
    }
  }

  private mapSystem(msg: ClaudeWireMessage): ClaudeChatEventBody[] {
    const subtype = str(msg.subtype);
    if (subtype === 'init') {
      return [{
        kind: 'session_started',
        model: str(msg.model) ?? '',
        cwd: str(msg.cwd) ?? '',
        permissionMode: str(msg.permissionMode) ?? '',
        cliVersion: str(msg.claude_code_version) ?? '',
        tools: arr(msg.tools).filter((t): t is string => typeof t === 'string'),
        slashCommands: arr(msg.slash_commands).filter((t): t is string => typeof t === 'string'),
        apiKeySource: str(msg.apiKeySource),
        capabilities: msg.capabilities,
        ...(Array.isArray(msg.mcp_servers) && {
          mcpServers: msg.mcp_servers.filter(isObj).flatMap((s) => {
            const name = str(s.name);
            return name ? [{ name, status: str(s.status) ?? '' }] : [];
          }),
        }),
      }];
    }
    if (subtype === 'compact_boundary') {
      const meta = isObj(msg.compact_metadata) ? msg.compact_metadata : {};
      return [{ kind: 'compacted', trigger: str(meta.trigger), preTokens: num(meta.pre_tokens) }];
    }
    if (subtype === 'status') {
      const mode = str(msg.permissionMode);
      return mode ? [{ kind: 'mode_changed', permissionMode: mode }] : [];
    }
    if (subtype === 'permission_denied') {
      return [{ kind: 'permission_denied', toolName: str(msg.tool_name), raw: msg }];
    }
    // A running estimate of thinking progress, not billed usage; turn_ended carries the real token counts.
    if (subtype === 'thinking_tokens') return [];
    if (subtype === 'background_tasks_changed') {
      const tasks: ClaudeBackgroundTask[] = arr(msg.tasks).filter(isObj).map((t) => ({
        taskId: str(t.task_id) ?? '',
        taskType: str(t.task_type) ?? '',
        description: str(t.description) ?? '',
        ...(str(t.subagent_type) ? { subagentType: str(t.subagent_type) } : {}),
        ambient: t.ambient === true,
      }));
      return [{ kind: 'background_tasks', tasks }];
    }
    if (subtype === 'vcs_state_changed') {
      return [{ kind: 'vcs_changed', vcsKind: str(msg.kind) ?? 'unknown', branch: str(msg.branch), cwd: str(msg.cwd) }];
    }
    // A PR or MR was published or linked (github, gitlab, …). Nothing in chat shows PRs yet.
    if (subtype === 'code_change_published') return [];
    if (subtype && SUBAGENT_PHASES[subtype]) {
      return [{ kind: 'subagent', phase: SUBAGENT_PHASES[subtype], taskId: str(msg.task_id) ?? '', raw: msg }];
    }
    return [{ kind: 'unmapped', type: 'system', subtype, raw: msg }];
  }

  private mapToolProgress(msg: ClaudeWireMessage, parentToolCallId?: string): ClaudeChatEventBody {
    const r = isObj(msg.subagent_retry) ? msg.subagent_retry : undefined;
    return {
      kind: 'tool_progress',
      toolCallId: str(msg.tool_use_id) ?? '',
      toolName: str(msg.tool_name) ?? '',
      elapsedSeconds: num(msg.elapsed_time_seconds) ?? 0,
      heartbeat: msg.heartbeat === true,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      ...(str(msg.subagent_type) ? { subagentType: str(msg.subagent_type) } : {}),
      ...(r ? {
        retry: {
          attempt: num(r.attempt) ?? 0,
          maxRetries: num(r.max_retries) ?? 0,
          retryDelayMs: num(r.retry_delay_ms),
          errorStatus: num(r.error_status),
          errorCategory: str(r.error_category),
        },
      } : {}),
    };
  }

  private mapStreamEvent(msg: ClaudeWireMessage, parentToolCallId?: string): ClaudeChatEventBody[] {
    const event = isObj(msg.event) ? msg.event : {};
    // Partial streams are keyed by parent so a subagent's stream doesn't
    // overwrite the main thread's current message id.
    const streamKey = parentToolCallId ?? '';
    if (event.type === 'message_start' && isObj(event.message)) {
      const id = str(event.message.id);
      if (id) this.streamMessageIds.set(streamKey, id);
      return [];
    }
    if (event.type !== 'content_block_delta' || !isObj(event.delta)) return [];
    const messageId = this.streamMessageIds.get(streamKey);
    const delta = event.delta;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ kind: 'message_chunk', messageId, text: delta.text, parentToolCallId }];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return [{ kind: 'thought_chunk', messageId, text: delta.thinking, parentToolCallId }];
    }
    return [];
  }

  private mapAssistant(msg: ClaudeWireMessage, parentToolCallId?: string): ClaudeChatEventBody[] {
    const message = isObj(msg.message) ? msg.message : {};
    const messageId = str(message.id) ?? str(msg.uuid) ?? '';
    const out: ClaudeChatEventBody[] = [];
    for (const block of arr(message.content)) {
      if (!isObj(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ kind: 'message', messageId, text: block.text, parentToolCallId });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        out.push({ kind: 'thought', messageId, text: block.thinking, parentToolCallId });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        const toolCallId = str(block.id) ?? '';
        const name = str(block.name) ?? '';
        this.toolNames.set(toolCallId, name);
        out.push({ kind: 'tool_call', toolCallId, name, input: isObj(block.input) ? block.input : {}, parentToolCallId });
      }
    }
    if (isObj(msg.error) || typeof msg.error === 'string') {
      const apiError = typeof msg.error === 'string' ? msg.error : undefined;
      out.push({ kind: 'error', message: apiError ?? JSON.stringify(msg.error), fatal: false, apiError });
    }
    // Subagents run in their own context; only the main loop's fill is the session's.
    const usage = toUsage(message.usage);
    if (usage && !parentToolCallId) out.push({ kind: 'assistant_usage', messageId, model: str(message.model), usage });
    return out;
  }

  private mapUser(msg: ClaudeWireMessage, parentToolCallId?: string): ClaudeChatEventBody[] {
    const message = isObj(msg.message) ? msg.message : {};
    const content = message.content;
    const toolResults = arr(content).filter((b): b is Obj => isObj(b) && b.type === 'tool_result');
    if (toolResults.length > 0) {
      return toolResults.map((b) => {
        const toolCallId = str(b.tool_use_id) ?? '';
        return {
          kind: 'tool_call_update' as const,
          toolCallId,
          name: this.toolNames.get(toolCallId) ?? '',
          status: b.is_error === true ? 'failed' as const : 'completed' as const,
          content: toolResultText(b.content),
          // tool_use_result belongs to the message's (single) tool result.
          result: toolResults.length === 1 ? msg.tool_use_result : undefined,
          parentToolCallId,
        };
      });
    }
    // Plain user text only reaches us as a replay (--replay-user-messages) or
    // a synthetic message the CLI injected; the host already knows what it sent.
    return [{ kind: 'user_message', text: userText(content), uuid: str(msg.uuid), replay: msg.isReplay === true }];
  }

  private mapResult(msg: ClaudeWireMessage): ClaudeChatEventBody {
    return {
      kind: 'turn_ended',
      subtype: str(msg.subtype) ?? 'unknown',
      isError: msg.is_error === true,
      result: str(msg.result),
      errors: Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string') : undefined,
      durationMs: num(msg.duration_ms),
      numTurns: num(msg.num_turns),
      totalCostUsd: num(msg.total_cost_usd),
      usage: toUsage(msg.usage),
      modelUsage: isObj(msg.modelUsage) ? msg.modelUsage : undefined,
      queuedTurnCount: num(msg.queued_turn_count),
      stopReason: str(msg.stop_reason),
      terminalReason: str(msg.terminal_reason),
    };
  }
}

/** Map a `can_use_tool` control request (wire field names) to a permission_request body. */
export function permissionRequestFromWire(requestId: string, req: Obj): ClaudeChatEventBody {
  return {
    kind: 'permission_request',
    requestId,
    toolName: str(req.tool_name) ?? '',
    input: isObj(req.input) ? req.input : {},
    toolCallId: str(req.tool_use_id),
    suggestions: arr(req.permission_suggestions).filter((s): s is ClaudePermissionUpdate => isObj(s) && typeof s.type === 'string'),
    title: str(req.title),
    description: str(req.description),
    displayName: str(req.display_name),
    blockedPath: str(req.blocked_path),
    decisionReason: str(req.decision_reason),
    agentId: str(req.agent_id),
  };
}

/** Map an `initialize` control response payload to an initialized body. */
export function initializedFromWire(raw: Obj): ClaudeChatEventBody {
  const commands = arr(raw.commands).filter(isObj).map((c) => ({
    name: str(c.name) ?? '',
    description: str(c.description),
    argumentHint: str(c.argumentHint),
    ...(c.builtin === true && { builtin: true }),
  }));
  const models = arr(raw.models).filter(isObj).map((m) => ({
    value: str(m.value) ?? '',
    displayName: str(m.displayName),
    description: str(m.description),
    resolvedModel: str(m.resolvedModel),
    efforts: arr(m.supportedEffortLevels).filter((e): e is string => typeof e === 'string'),
  }));
  return { kind: 'initialized', commands, models, raw };
}
