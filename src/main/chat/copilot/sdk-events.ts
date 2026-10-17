/**
 * Copilot SDK session events → chat contract drafts (minimal set).
 *
 * The SDK emits ~176 event types. This maps the ones a chat turn needs:
 * message and reasoning text, tool start/finish, usage, errors, title and
 * model changes. Turn boundaries come from the driver (a Clubhouse turn runs
 * from `send` to `session.idle`; the SDK's own `assistant.turn_*` events are
 * per model call). Types listed in KNOWN_IGNORED are understood and dropped;
 * anything else becomes `protocol_unknown` once per type, which feeds the
 * drift signal while the mapping grows.
 */

import type { ChatErrorCode, ChatEventDraft, TokenUsage, ToolKind } from '../../../shared/chat/events';

export interface SdkSessionEvent {
  type: string;
  data?: unknown;
}

/** Understood, deliberately not mapped (yet). Keeps protocol_unknown meaningful. */
const KNOWN_IGNORED = new Set([
  'session.start',
  'session.resume',
  'session.info',
  'session.idle', // handled by the driver
  'session.usage_info',
  'session.context_changed',
  'session.tools_updated',
  'session.skills_loaded',
  'session.mcp_servers_loaded',
  'session.mcp_server_status_changed',
  'session.custom_agents_updated',
  'session.extensions_loaded',
  'session.shutdown',
  'session.permissions_changed',
  'session.mode_changed',
  'session.usage_checkpoint',
  'session.quota_observation',
  'session.workspace_file_changed',
  'session.background_tasks_changed',
  'session.remote_steerable_changed',
  'session.session_limits_changed',
  'user.message',
  'pending_messages.modified',
  'assistant.turn_start',
  'assistant.turn_end',
  'assistant.message_start',
  'assistant.streaming_delta',
  'assistant.tool_call_delta',
  'assistant.intent',
  'assistant.idle',
  'model.call_finished',
  'tool.execution_progress',
  'tool.execution_partial_result',
  'tool.shell_output',
  'permission.requested', // answered through onPermissionRequest
  'permission.completed',
  'commands.changed',
  'capabilities.changed',
  'instruction_discovered',
  'hook.start',
  'hook.progress',
  'hook.end',
  'system.message',
  'system.notification',
]);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Copilot tool names → ACP tool kinds, for icons and grouping. */
export function toolKindFor(toolName: string | undefined): ToolKind {
  const name = (toolName ?? '').toLowerCase();
  if (/^(view|read|cat|ls|glob)/.test(name)) return 'read';
  if (/(edit|write|create|str_replace|apply_patch)/.test(name)) return 'edit';
  if (/(delete|remove|rm)$/.test(name)) return 'delete';
  if (/(grep|search|find)/.test(name)) return 'search';
  if (/(bash|shell|powershell|exec|run)/.test(name)) return 'execute';
  if (/(fetch|web|url)/.test(name)) return 'fetch';
  if (/think/.test(name)) return 'think';
  return 'other';
}

function errorCode(errorType: string | undefined): ChatErrorCode {
  switch (errorType) {
    case 'authentication':
    case 'auth':
      return 'auth_required';
    case 'rate_limit':
    case 'quota':
      return 'rate_limited';
    case 'context_window':
    case 'context_length':
      return 'context_overflow';
    default:
      return 'unknown';
  }
}

export class CopilotSdkEventMapper {
  private readonly seenUnknown = new Set<string>();

  map(event: SdkSessionEvent): ChatEventDraft[] {
    const d = (event.data ?? {}) as Record<string, unknown>;
    const subagentId = str(d.parentToolCallId);
    switch (event.type) {
      case 'assistant.message_delta': {
        const text = str(d.deltaContent);
        return text ? [{ type: 'agent_message_chunk', data: { messageId: str(d.messageId) ?? '', text, ...(subagentId && { subagentId }) } }] : [];
      }
      case 'assistant.message':
        return [{ type: 'agent_message', data: { messageId: str(d.messageId) ?? '', text: str(d.content) ?? '', ...(subagentId && { subagentId }) } }];
      case 'assistant.reasoning_delta': {
        const text = str(d.deltaContent);
        return text ? [{ type: 'agent_thought_chunk', data: { messageId: str(d.reasoningId) ?? '', text, ...(subagentId && { subagentId }) } }] : [];
      }
      case 'assistant.reasoning':
        return [{ type: 'agent_thought', data: { messageId: str(d.reasoningId) ?? '', text: str(d.content) ?? '', ...(subagentId && { subagentId }) } }];
      case 'tool.execution_start': {
        const toolName = str(d.toolName) ?? str(d.mcpToolName);
        return [{
          type: 'tool_call',
          data: {
            toolCallId: str(d.toolCallId) ?? '',
            kind: toolKindFor(toolName),
            title: toolName ?? 'Tool',
            status: 'in_progress',
            ...(toolName && { toolName }),
            ...(d.arguments !== undefined && { rawInput: d.arguments }),
            ...(subagentId && { subagentId }),
          },
        }];
      }
      case 'tool.execution_complete': {
        const error = d.error as { message?: unknown } | undefined;
        return [{
          type: 'tool_call_update',
          data: {
            toolCallId: str(d.toolCallId) ?? '',
            status: d.success === false ? 'failed' : 'completed',
            ...(d.result !== undefined && { rawOutput: d.result }),
            ...(error && str(error.message) && { error: str(error.message) }),
          },
        }];
      }
      case 'assistant.usage': {
        const tokens: TokenUsage = {
          ...(num(d.inputTokens) !== undefined && { input: num(d.inputTokens) }),
          ...(num(d.cacheReadTokens) !== undefined && { cachedInput: num(d.cacheReadTokens) }),
          ...(num(d.cacheWriteTokens) !== undefined && { cacheWrite: num(d.cacheWriteTokens) }),
          ...(num(d.outputTokens) !== undefined && { output: num(d.outputTokens) }),
          ...(num(d.reasoningTokens) !== undefined && { reasoning: num(d.reasoningTokens) }),
        };
        return Object.keys(tokens).length ? [{ type: 'usage', data: { scope: 'turn', tokens } }] : [];
      }
      case 'session.error':
        return [{ type: 'error', data: { code: errorCode(str(d.errorType)), message: str(d.message) ?? 'Copilot reported an error', fatal: false } }];
      case 'session.title_changed':
        return str(d.title) ? [{ type: 'session_info', data: { title: str(d.title) } }] : [];
      case 'session.model_change': {
        const modelId = str(d.newModel);
        const effort = str(d.reasoningEffort);
        return modelId ? [{ type: 'model_changed', data: { modelId, ...(effort && { effort }) } }] : [];
      }
      default:
        if (KNOWN_IGNORED.has(event.type) || this.seenUnknown.has(event.type)) return [];
        this.seenUnknown.add(event.type);
        return [{ type: 'protocol_unknown', data: { driver: 'copilot_sdk', kind: 'field', name: `event:${event.type}` } }];
    }
  }
}
