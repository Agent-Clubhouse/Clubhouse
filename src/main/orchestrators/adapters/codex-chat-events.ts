// Maps `codex app-server` v2 traffic onto the Clubhouse chat event contract
// (src/shared/chat). This is the translation half of the Codex chat driver:
// the client in codex-app-server-client.ts feeds it typed notifications and
// server requests, and it returns ChatEventDrafts for the chat runtime to
// stamp and publish. It holds only the state the translation needs (streamed
// plan text, open permission requests and their native decisions).

import type {
  ChatErrorCode,
  ChatEventDraft,
  ChatQuestionAnswers,
  ChatSessionState,
  ContentBlock,
  PermissionOption,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
  TurnStopReason,
  UsageLimit,
} from '../../../shared/chat/events';
import {
  commandApprovalDecisions,
  FILE_CHANGE_APPROVAL_DECISIONS,
  type CodexErrorInfo,
  type CodexServerRequestResult,
  type CodexUnrecognizedMessage,
  type CommandExecutionApprovalDecision,
  type FileChangeApprovalDecision,
  type RateLimitSnapshot,
  type RequestId,
  type ServerNotification,
  type ServerRequest,
  type ThreadItem,
  type ThreadStatus,
  type TurnError,
  type TurnStatus,
  type UserInput,
} from './codex-protocol';

type Item<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;

/** The JSON-RPC answer to send back to Codex for a resolved permission. */
export type CodexPermissionReply =
  | {
      id: RequestId;
      method: 'item/commandExecution/requestApproval';
      result: CodexServerRequestResult<'item/commandExecution/requestApproval'>;
    }
  | {
      id: RequestId;
      method: 'item/fileChange/requestApproval';
      result: CodexServerRequestResult<'item/fileChange/requestApproval'>;
    }
  | {
      id: RequestId;
      method: 'item/permissions/requestApproval';
      result: CodexServerRequestResult<'item/permissions/requestApproval'>;
    };

type PermissionOutcome = 'allow' | 'deny' | 'cancelled';

export interface CodexQuestionReply {
  id: RequestId;
  method: 'item/tool/requestUserInput';
  result: CodexServerRequestResult<'item/tool/requestUserInput'>;
}

/** An open permission request: the native reply and outcome behind each option id. */
type OpenPermission = Map<string, { reply: CodexPermissionReply; outcome: PermissionOutcome }>;

function decisionOutcome(decision: CommandExecutionApprovalDecision | FileChangeApprovalDecision): PermissionOutcome {
  return decision === 'decline' ? 'deny' : decision === 'cancel' ? 'cancelled' : 'allow';
}

export class CodexChatEventMapper {
  private readonly planText = new Map<string, string>();
  private readonly openPermissions = new Map<string, OpenPermission>();
  private readonly openQuestions = new Map<string, RequestId>();
  /** Turns whose terminal error already went out via an `error` notification. */
  private readonly erroredTurns = new Set<string>();

  /** Translate one notification. Known methods with no chat meaning map to nothing. */
  mapNotification(notification: ServerNotification): ChatEventDraft[] {
    switch (notification.method) {
      case 'thread/status/changed': {
        const state = sessionState(notification.params.status);
        return state ? [{ type: 'session_state', data: { state } }] : [];
      }
      case 'turn/started':
        return [{ type: 'turn_started', data: { trigger: 'prompt', nativeTurnId: notification.params.turn.id } }];
      case 'turn/completed': {
        const { turn } = notification.params;
        const events: ChatEventDraft[] = [];
        // Codex usually reports a terminal failure twice: an `error` with
        // willRetry false, then this turn/completed carrying the same error.
        const alreadyReported = this.erroredTurns.delete(turn.id);
        if (turn.status === 'failed' && turn.error && !alreadyReported) {
          events.push({ type: 'error', data: { ...errorData(turn.error), fatal: false } });
        }
        events.push({
          type: 'turn_ended',
          data: {
            stopReason: stopReason(turn.status, turn.error),
            ...(turn.durationMs != null && { durationMs: turn.durationMs }),
          },
        });
        return events;
      }
      case 'item/started':
        return this.mapItemStarted(notification.params.item);
      case 'item/completed':
        return this.mapItemCompleted(notification.params.item);
      case 'item/agentMessage/delta': {
        const { itemId, delta } = notification.params;
        return [{ type: 'agent_message_chunk', data: { messageId: itemId, text: delta } }];
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const { itemId, delta } = notification.params;
        return [{ type: 'agent_thought_chunk', data: { messageId: itemId, text: delta } }];
      }
      case 'item/plan/delta': {
        const { itemId, delta } = notification.params;
        const markdown = (this.planText.get(itemId) ?? '') + delta;
        this.planText.set(itemId, markdown);
        return [{ type: 'plan_document', data: { planId: itemId, markdown, status: 'streaming' } }];
      }
      case 'item/commandExecution/outputDelta': {
        const { itemId, delta } = notification.params;
        return [{
          type: 'tool_call_update',
          data: { toolCallId: itemId, content: [{ type: 'terminal', output: delta }], contentMode: 'append' },
        }];
      }
      case 'item/fileChange/patchUpdated': {
        const { itemId, changes } = notification.params;
        return [{
          type: 'tool_call_update',
          data: { toolCallId: itemId, content: diffContent(changes), contentMode: 'replace' },
        }];
      }
      case 'turn/plan/updated': {
        const { plan } = notification.params;
        return [{
          type: 'plan',
          data: {
            entries: plan.map((step) => ({
              content: step.step,
              status: step.status === 'inProgress' ? 'in_progress' : step.status,
            })),
          },
        }];
      }
      case 'thread/tokenUsage/updated': {
        const { tokenUsage } = notification.params;
        const { total, last, modelContextWindow } = tokenUsage;
        return [{
          type: 'usage',
          data: {
            scope: 'session',
            tokens: {
              input: total.inputTokens,
              cachedInput: total.cachedInputTokens,
              cacheWrite: total.cacheWriteInputTokens,
              output: total.outputTokens,
              reasoning: total.reasoningOutputTokens,
              total: total.totalTokens,
            },
            ...(modelContextWindow != null && { context: { used: last.totalTokens, size: modelContextWindow } }),
          },
        }];
      }
      case 'account/rateLimits/updated': {
        const limits = rateLimitWindows(notification.params.rateLimits);
        return limits.length > 0 ? [{ type: 'usage', data: { scope: 'session', limits } }] : [];
      }
      case 'error': {
        const { error, willRetry, turnId } = notification.params;
        if (!willRetry) this.erroredTurns.add(turnId);
        return [{ type: 'error', data: { ...errorData(error), fatal: false, willRetry } }];
      }
      case 'model/rerouted':
        return [{ type: 'model_changed', data: { modelId: notification.params.toModel } }];
      case 'warning':
        return [{ type: 'notice', data: { level: 'warn', code: 'codex_warning', message: notification.params.message } }];
      case 'deprecationNotice':
      case 'configWarning': {
        const { summary, details } = notification.params;
        const code = notification.method === 'configWarning' ? 'codex_config_warning' : 'codex_deprecation';
        return [{ type: 'notice', data: { level: 'warn', code, message: details ? `${summary}: ${details}` : summary } }];
      }
      case 'serverRequest/resolved': {
        const requestId = String(notification.params.requestId);
        if (this.openPermissions.delete(requestId)) {
          return [{ type: 'permission_resolved', data: { requestId, decision: 'cancelled', by: 'agent' } }];
        }
        if (this.openQuestions.delete(requestId)) {
          return [{ type: 'question_resolved', data: { requestId, answers: {}, cancelled: true } }];
        }
        return [];
      }
      case 'thread/name/updated': {
        const { threadName } = notification.params;
        return threadName ? [{ type: 'session_info', data: { title: threadName } }] : [];
      }
      default:
        return [];
    }
  }

  /**
   * Translate a server request into a permission request or a question.
   * Returns null for requests the chat contract can't express yet; the driver
   * must answer those itself so the turn isn't left blocked.
   */
  mapServerRequest(request: ServerRequest): ChatEventDraft[] | null {
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const { params } = request;
        const open: OpenPermission = new Map();
        let networkIndex = 0;
        const options = commandApprovalDecisions(params).map((decision) => {
          const isNetwork = typeof decision === 'object' && 'applyNetworkPolicyAmendment' in decision;
          const option = commandOption(decision, isNetwork ? networkIndex++ : 0);
          open.set(option.optionId, {
            reply: { id: request.id, method: request.method, result: { decision } },
            outcome: decisionOutcome(decision),
          });
          return option;
        });
        const requestId = String(request.id);
        this.openPermissions.set(requestId, open);
        return [{
          type: 'permission_request',
          data: {
            requestId,
            title: params.command ? `Run ${params.command}` : 'Run a command',
            ...(params.reason && { description: params.reason }),
            toolCallId: params.itemId,
            toolName: 'commandExecution',
            rawInput: { command: params.command, cwd: params.cwd, commandActions: params.commandActions },
            options,
          },
        }];
      }
      case 'item/fileChange/requestApproval': {
        const { params } = request;
        const open: OpenPermission = new Map();
        const options = FILE_CHANGE_APPROVAL_DECISIONS.map((decision) => {
          open.set(decision, {
            reply: { id: request.id, method: request.method, result: { decision } },
            outcome: decisionOutcome(decision),
          });
          return fileChangeOption(decision);
        });
        const requestId = String(request.id);
        this.openPermissions.set(requestId, open);
        return [{
          type: 'permission_request',
          data: {
            requestId,
            title: 'Apply file changes',
            ...(params.reason && { description: params.reason }),
            toolCallId: params.itemId,
            toolName: 'fileChange',
            ...(params.grantRoot && { rawInput: { grantRoot: params.grantRoot } }),
            options,
          },
        }];
      }
      case 'item/permissions/requestApproval': {
        const { params } = request;
        const requestId = String(request.id);
        const { network, fileSystem } = params.permissions;
        const granted = {
          ...(network && { network }),
          ...(fileSystem && { fileSystem }),
        };
        const reply = (result: CodexServerRequestResult<'item/permissions/requestApproval'>): CodexPermissionReply =>
          ({ id: request.id, method: request.method, result });
        this.openPermissions.set(requestId, new Map([
          ['grantForTurn', { reply: reply({ permissions: granted, scope: 'turn' }), outcome: 'allow' }],
          ['grantForSession', { reply: reply({ permissions: granted, scope: 'session' }), outcome: 'allow' }],
          // Granting nothing is how a client declines.
          ['decline', { reply: reply({ permissions: {}, scope: 'turn' }), outcome: 'deny' }],
        ]));
        const asks = [
          ...(network?.enabled ? ['network access'] : []),
          ...(fileSystem?.write?.length ? [`write access to ${fileSystem.write.join(', ')}`] : []),
          ...(fileSystem?.read?.length ? [`read access to ${fileSystem.read.join(', ')}`] : []),
        ];
        return [{
          type: 'permission_request',
          data: {
            requestId,
            title: asks.length > 0 ? `Allow ${asks.join(' and ')}` : 'Grant additional permissions',
            ...(params.reason && { description: params.reason }),
            toolCallId: params.itemId,
            toolName: 'permissions',
            rawInput: params.permissions,
            options: [
              { optionId: 'grantForTurn', kind: 'allow_once', label: 'Allow for this turn' },
              { optionId: 'grantForSession', kind: 'allow_session', label: 'Allow for this session' },
              { optionId: 'decline', kind: 'reject_once', label: 'Deny' },
            ],
          },
        }];
      }
      case 'item/tool/requestUserInput': {
        const { params } = request;
        const requestId = String(request.id);
        this.openQuestions.set(requestId, request.id);
        return [{
          type: 'question',
          data: {
            requestId,
            toolCallId: params.itemId,
            questions: params.questions.map((q) => ({
              id: q.id,
              prompt: q.question,
              ...(q.header && { header: q.header }),
              // Codex answers by label, so the label doubles as the option id.
              ...(q.options && {
                options: q.options.map((o) => ({ id: o.label, label: o.label, ...(o.description && { description: o.description }) })),
              }),
              allowFreeText: q.isOther || !q.options || q.options.length === 0,
            })),
          },
        }];
      }
      default:
        return null;
    }
  }

  /**
   * Answer an open question. Returns the reply to send to Codex and the
   * question_resolved event, or undefined when the request isn't open.
   */
  resolveQuestion(
    requestId: string,
    answers: ChatQuestionAnswers,
  ): { reply: CodexQuestionReply; event: ChatEventDraft } | undefined {
    const id = this.openQuestions.get(requestId);
    if (id === undefined) return undefined;
    this.openQuestions.delete(requestId);
    const result: CodexQuestionReply['result'] = { answers: {} };
    for (const [questionId, answer] of Object.entries(answers)) {
      result.answers[questionId] = { answers: Array.isArray(answer) ? answer : [answer] };
    }
    return {
      reply: { id, method: 'item/tool/requestUserInput', result },
      event: { type: 'question_resolved', data: { requestId, answers } },
    };
  }

  /**
   * Resolve an open permission with one of its option ids. Returns the reply
   * to send to Codex and the permission_resolved event, or undefined when the
   * request or option is unknown (already resolved, or a bad option id).
   */
  resolvePermission(
    requestId: string,
    optionId: string,
    by: Extract<ChatEventDraft, { type: 'permission_resolved' }>['data']['by'] = 'user',
  ): { reply: CodexPermissionReply; event: ChatEventDraft } | undefined {
    const option = this.openPermissions.get(requestId)?.get(optionId);
    if (!option) return undefined;
    this.openPermissions.delete(requestId);
    return {
      reply: option.reply,
      event: { type: 'permission_resolved', data: { requestId, optionId, decision: option.outcome, by } },
    };
  }

  /**
   * Resolve every open permission and question as cancelled by the agent, for
   * when the process is gone and nothing can answer them any more.
   */
  cancelOpenRequests(): ChatEventDraft[] {
    const events: ChatEventDraft[] = [
      ...[...this.openPermissions.keys()].map((requestId): ChatEventDraft =>
        ({ type: 'permission_resolved', data: { requestId, decision: 'cancelled', by: 'agent' } })),
      ...[...this.openQuestions.keys()].map((requestId): ChatEventDraft =>
        ({ type: 'question_resolved', data: { requestId, answers: {}, cancelled: true } })),
    ];
    this.openPermissions.clear();
    this.openQuestions.clear();
    return events;
  }

  /** A message the vendored schema doesn't know, as the protocol-drift event. */
  mapUnrecognized(message: CodexUnrecognizedMessage): ChatEventDraft[] {
    if (message.kind === 'other') {
      return [{ type: 'protocol_unknown', data: { driver: 'codex_app_server', kind: 'field', name: '(message without id or method)' } }];
    }
    return [{ type: 'protocol_unknown', data: { driver: 'codex_app_server', kind: message.kind, name: message.method } }];
  }

  private mapItemStarted(item: ThreadItem): ChatEventDraft[] {
    switch (item.type) {
      case 'commandExecution':
        return [{ type: 'tool_call', data: commandToolCall(item, 'in_progress') }];
      case 'fileChange':
        return [{ type: 'tool_call', data: fileChangeToolCall(item, 'in_progress') }];
      case 'mcpToolCall':
        return [{
          type: 'tool_call',
          data: {
            toolCallId: item.id,
            kind: 'other',
            title: `${item.server}: ${item.tool}`,
            status: 'in_progress',
            toolName: `mcp__${item.server}__${item.tool}`,
            rawInput: item.arguments,
          },
        }];
      case 'dynamicToolCall':
        return [{
          type: 'tool_call',
          data: {
            toolCallId: item.id,
            kind: 'other',
            title: item.tool,
            status: 'in_progress',
            toolName: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
            rawInput: item.arguments,
          },
        }];
      case 'webSearch':
        return [{
          type: 'tool_call',
          data: { toolCallId: item.id, kind: 'fetch', title: item.query ? `Search: ${item.query}` : 'Web search', status: 'in_progress', toolName: 'webSearch' },
        }];
      case 'imageView':
        return [{
          type: 'tool_call',
          data: { toolCallId: item.id, kind: 'read', title: `View ${item.path}`, status: 'completed', toolName: 'imageView', locations: [{ path: item.path }] },
        }];
      case 'collabAgentToolCall':
        return item.receiverThreadIds.map((threadId) => ({
          type: 'subagent' as const,
          data: { subagentId: threadId, name: item.tool, status: 'running' as const, parentToolCallId: item.id, nativeSessionId: threadId },
        }));
      default:
        return [];
    }
  }

  private mapItemCompleted(item: ThreadItem): ChatEventDraft[] {
    switch (item.type) {
      // User messages are recorded by the chat runtime when it sends them, so
      // Codex's echo of the user's input is not re-emitted here.
      case 'userMessage':
        return [];
      case 'agentMessage':
        return [{ type: 'agent_message', data: { messageId: item.id, text: item.text } }];
      case 'reasoning': {
        const text = (item.summary.length > 0 ? item.summary : item.content).join('\n\n');
        return text ? [{ type: 'agent_thought', data: { messageId: item.id, text } }] : [];
      }
      case 'plan':
        this.planText.delete(item.id);
        return [{ type: 'plan_document', data: { planId: item.id, markdown: item.text, status: 'ready' } }];
      case 'commandExecution': {
        const call = commandToolCall(item, commandStatus(item.status));
        return [{
          type: 'tool_call_update',
          data: {
            toolCallId: item.id,
            status: call.status,
            content: call.content,
            contentMode: 'replace',
            ...(item.durationMs != null && { durationMs: item.durationMs }),
          },
        }];
      }
      case 'fileChange':
        return [{
          type: 'tool_call_update',
          data: { toolCallId: item.id, status: commandStatus(item.status), content: diffContent(item.changes), contentMode: 'replace' },
        }];
      case 'mcpToolCall':
        return [{
          type: 'tool_call_update',
          data: {
            toolCallId: item.id,
            status: item.status === 'failed' ? 'failed' : 'completed',
            ...(item.result && { rawOutput: item.result }),
            ...(item.error && { error: item.error.message }),
            ...(item.durationMs != null && { durationMs: item.durationMs }),
          },
        }];
      case 'dynamicToolCall':
        return [{
          type: 'tool_call_update',
          data: {
            toolCallId: item.id,
            status: item.status === 'failed' || item.success === false ? 'failed' : 'completed',
            ...(item.contentItems && { rawOutput: item.contentItems }),
            ...(item.durationMs != null && { durationMs: item.durationMs }),
          },
        }];
      case 'webSearch':
        return [{ type: 'tool_call_update', data: { toolCallId: item.id, status: 'completed' } }];
      case 'collabAgentToolCall': {
        const status = item.status === 'failed' ? 'failed' : item.status === 'interrupted' ? 'cancelled' : item.status === 'completed' ? 'completed' : 'running';
        return item.receiverThreadIds.map((threadId) => ({
          type: 'subagent' as const,
          data: { subagentId: threadId, name: item.tool, status, parentToolCallId: item.id, nativeSessionId: threadId },
        }));
      }
      case 'contextCompaction':
        return [{ type: 'notice', data: { level: 'info', code: 'context_compacted', message: 'Context compacted' } }];
      default:
        return [];
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sessionState(status: ThreadStatus): ChatSessionState | undefined {
  switch (status.type) {
    case 'idle':
      return 'idle';
    case 'systemError':
      return 'error';
    case 'active':
      if (status.activeFlags.includes('waitingOnApproval')) return 'waiting_permission';
      if (status.activeFlags.includes('waitingOnUserInput')) return 'waiting_input';
      return 'running';
    default:
      return undefined;
  }
}

function stopReason(status: TurnStatus, error: TurnError | null): TurnStopReason {
  switch (status) {
    case 'completed':
      return 'end_turn';
    case 'interrupted':
      return 'cancelled';
    default: {
      const native = codexErrorName(error?.codexErrorInfo ?? null);
      if (native === 'contextWindowExceeded') return 'max_tokens';
      if (native === 'cyberPolicy' || native === 'misalignmentPolicyViolation') return 'refusal';
      return 'error';
    }
  }
}

/** `codexErrorInfo` is a string or a single-key object; this is its name. */
export function codexErrorName(info: CodexErrorInfo | null): string | undefined {
  if (info == null) return undefined;
  return typeof info === 'string' ? info : Object.keys(info)[0];
}

/** Codex error kinds on the contract's closed ChatErrorCode set. */
export function codexErrorCode(info: CodexErrorInfo | null): ChatErrorCode {
  switch (codexErrorName(info)) {
    case 'contextWindowExceeded':
      return 'context_overflow';
    case 'usageLimitExceeded':
    case 'rateLimitExceeded':
    case 'sessionBudgetExceeded':
      return 'rate_limited';
    case 'unauthorized':
      return 'auth_required';
    case 'cyberPolicy':
    case 'misalignmentPolicyViolation':
      return 'refusal';
    case 'badRequest':
    case 'activeTurnNotSteerable':
      return 'protocol_error';
    case 'sandboxError':
      return 'tool_failed';
    default:
      return 'unknown';
  }
}

function errorData(error: TurnError): { code: ChatErrorCode; message: string } {
  return {
    code: codexErrorCode(error.codexErrorInfo),
    message: error.additionalDetails ? `${error.message} (${error.additionalDetails})` : error.message,
  };
}

function rateLimitWindows(snapshot: RateLimitSnapshot): UsageLimit[] {
  const windows: UsageLimit[] = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window) continue;
    windows.push({
      window: windowName(window.windowDurationMins),
      utilization: Math.min(1, Math.max(0, window.usedPercent / 100)),
      // Codex reports Unix seconds; the contract uses epoch milliseconds.
      ...(window.resetsAt != null && { resetsAt: window.resetsAt * 1000 }),
    });
  }
  return windows;
}

function windowName(minutes: number | null): string {
  if (minutes == null) return 'window';
  if (minutes === 10_080) return 'week';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function commandKind(item: Item<'commandExecution'>): ToolKind {
  const actions = item.commandActions;
  if (actions.length > 0 && actions.every((a) => a.type === 'read')) return 'read';
  if (actions.length > 0 && actions.every((a) => a.type === 'search' || a.type === 'listFiles')) return 'search';
  return 'execute';
}

function commandStatus(status: Item<'commandExecution'>['status']): ToolCallStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

function commandToolCall(item: Item<'commandExecution'>, status: ToolCallStatus) {
  const terminal: ToolCallContent = {
    type: 'terminal',
    command: item.command,
    cwd: item.cwd,
    output: item.aggregatedOutput ?? '',
    ...(item.exitCode != null && { exitCode: item.exitCode }),
  };
  return {
    toolCallId: item.id,
    kind: commandKind(item),
    title: item.command,
    status,
    toolName: 'commandExecution',
    rawInput: { command: item.command, cwd: item.cwd },
    content: [terminal],
  };
}

function diffContent(changes: Item<'fileChange'>['changes']): ToolCallContent[] {
  return changes.map((change) => ({ type: 'diff', path: change.path, unifiedDiff: change.diff }));
}

function fileChangeToolCall(item: Item<'fileChange'>, status: ToolCallStatus) {
  const kind: ToolKind = item.changes.length > 0 && item.changes.every((c) => c.kind.type === 'delete') ? 'delete' : 'edit';
  return {
    toolCallId: item.id,
    kind,
    title: item.changes.length === 1 ? `Edit ${item.changes[0].path}` : `Edit ${item.changes.length} files`,
    status,
    toolName: 'fileChange',
    locations: item.changes.map((c) => ({ path: c.path })),
    content: diffContent(item.changes),
  };
}

function commandOption(decision: CommandExecutionApprovalDecision, networkIndex: number): PermissionOption {
  if (decision === 'accept') return { optionId: 'accept', kind: 'allow_once', label: 'Allow' };
  if (decision === 'acceptForSession') return { optionId: 'acceptForSession', kind: 'allow_session', label: 'Allow for this session' };
  if (decision === 'decline') return { optionId: 'decline', kind: 'reject_once', label: 'Deny' };
  if (decision === 'cancel') return { optionId: 'cancel', kind: 'cancel_turn', label: 'Deny and stop the turn' };
  if ('acceptWithExecpolicyAmendment' in decision) {
    const scope = decision.acceptWithExecpolicyAmendment.execpolicy_amendment.join(' ');
    return { optionId: 'execpolicy', kind: 'allow_always', label: `Always allow ${scope}`, scope };
  }
  const { host, action } = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return {
    optionId: `network:${networkIndex}`,
    kind: action === 'allow' ? 'allow_always' : 'reject_always',
    label: action === 'allow' ? `Always allow network access to ${host}` : `Always block network access to ${host}`,
    scope: host,
  };
}

function fileChangeOption(decision: FileChangeApprovalDecision): PermissionOption {
  switch (decision) {
    case 'accept':
      return { optionId: 'accept', kind: 'allow_once', label: 'Allow' };
    case 'acceptForSession':
      return { optionId: 'acceptForSession', kind: 'allow_session', label: 'Allow edits for this session' };
    case 'decline':
      return { optionId: 'decline', kind: 'reject_once', label: 'Deny' };
    case 'cancel':
      return { optionId: 'cancel', kind: 'cancel_turn', label: 'Deny and stop the turn' };
  }
}

/** Contract content blocks as Codex `UserInput`, for turn/start and turn/steer. */
export function toCodexInput(content: ContentBlock[]): UserInput[] {
  return content.flatMap((block): UserInput[] => {
    switch (block.type) {
      case 'text':
        return [{ type: 'text', text: block.text, text_elements: [] }];
      case 'image':
        if (block.path) return [{ type: 'localImage', path: block.path }];
        if (block.uri) return [{ type: 'image', url: block.uri }];
        if (block.data) return [{ type: 'image', url: `data:${block.mimeType};base64,${block.data}` }];
        return [];
      case 'file':
        return [{ type: 'mention', name: block.path, path: block.path }];
      case 'resource':
        return block.text ? [{ type: 'text', text: block.text, text_elements: [] }] : [];
    }
  });
}
