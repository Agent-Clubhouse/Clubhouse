// Typed view of the `codex app-server` v2 protocol, built on the vendored
// bindings in ./generated (see generated-meta.ts for the source version and
// scripts/generate-codex-app-server-types.mjs to regenerate).
//
// The generated unions carry method → params for every message, but not
// method → result for client requests, so CodexResponseMap below pairs the
// methods the client calls with their generated response types.

import type { ClientRequest } from './generated/ClientRequest';
import type { InitializeResponse } from './generated/InitializeResponse';
import type { ServerNotification } from './generated/ServerNotification';
import type { ServerRequest } from './generated/ServerRequest';
import type { ApplyPatchApprovalResponse } from './generated/ApplyPatchApprovalResponse';
import type { ExecCommandApprovalResponse } from './generated/ExecCommandApprovalResponse';
import type { AttestationGenerateResponse } from './generated/v2/AttestationGenerateResponse';
import type { ChatgptAuthTokensRefreshResponse } from './generated/v2/ChatgptAuthTokensRefreshResponse';
import type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision';
import type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams';
import type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse';
import type { DynamicToolCallResponse } from './generated/v2/DynamicToolCallResponse';
import type { FileChangeApprovalDecision } from './generated/v2/FileChangeApprovalDecision';
import type { FileChangeRequestApprovalResponse } from './generated/v2/FileChangeRequestApprovalResponse';
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse';
import type { McpServerElicitationRequestResponse } from './generated/v2/McpServerElicitationRequestResponse';
import type { PermissionsRequestApprovalResponse } from './generated/v2/PermissionsRequestApprovalResponse';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import type { ToolRequestUserInputResponse } from './generated/v2/ToolRequestUserInputResponse';
import type { ReviewStartResponse } from './generated/v2/ReviewStartResponse';
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse';
import type { TurnSteerResponse } from './generated/v2/TurnSteerResponse';
import { CODEX_SERVER_NOTIFICATION_METHODS, CODEX_SERVER_REQUEST_METHODS } from './generated-meta';

export { CODEX_APP_SERVER_SCHEMA_VERSION, CODEX_APP_SERVER_GENERATE_COMMAND } from './generated-meta';
export { CODEX_SERVER_NOTIFICATION_METHODS, CODEX_SERVER_REQUEST_METHODS };

export type { ClientRequest, InitializeResponse, ServerNotification, ServerRequest };
export type { ThreadStartResponse, ThreadResumeResponse };
export type { JsonValue } from './generated/serde_json/JsonValue';
export type { InitializeParams } from './generated/InitializeParams';
export type { ClientInfo } from './generated/ClientInfo';
export type { RequestId } from './generated/RequestId';
export type { AskForApproval } from './generated/v2/AskForApproval';
export type { SandboxMode } from './generated/v2/SandboxMode';
export type { SandboxPolicy } from './generated/v2/SandboxPolicy';
export type { ReviewTarget } from './generated/v2/ReviewTarget';
export type { ReviewStartResponse } from './generated/v2/ReviewStartResponse';
export type { Thread } from './generated/v2/Thread';
export type { ThreadItem } from './generated/v2/ThreadItem';
export type { ThreadStatus } from './generated/v2/ThreadStatus';
export type { ThreadStartParams } from './generated/v2/ThreadStartParams';
export type { ThreadResumeParams } from './generated/v2/ThreadResumeParams';
export type { ThreadListParams } from './generated/v2/ThreadListParams';
export type { ThreadReadParams } from './generated/v2/ThreadReadParams';
export type { Turn } from './generated/v2/Turn';
export type { TurnStatus } from './generated/v2/TurnStatus';
export type { TurnError } from './generated/v2/TurnError';
export type { TurnStartParams } from './generated/v2/TurnStartParams';
export type { TurnSteerParams } from './generated/v2/TurnSteerParams';
export type { TurnInterruptParams } from './generated/v2/TurnInterruptParams';
export type { TurnPlanStep } from './generated/v2/TurnPlanStep';
export type { UserInput } from './generated/v2/UserInput';
export type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage';
export type { RateLimitSnapshot } from './generated/v2/RateLimitSnapshot';
export type { CodexErrorInfo } from './generated/v2/CodexErrorInfo';
export type {
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
};
export type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams';

// ── Client → server requests ────────────────────────────────────────────────

export type CodexClientRequestMethod = ClientRequest['method'];

export type CodexRequestParams<M extends CodexClientRequestMethod> =
  Extract<ClientRequest, { method: M }>['params'];

/** Result types for the client requests Clubhouse makes. */
export interface CodexResponseMap {
  'initialize': InitializeResponse;
  'thread/start': ThreadStartResponse;
  'thread/resume': ThreadResumeResponse;
  'thread/list': ThreadListResponse;
  'thread/read': ThreadReadResponse;
  'turn/start': TurnStartResponse;
  'turn/steer': TurnSteerResponse;
  'turn/interrupt': TurnInterruptResponse;
  'account/rateLimits/read': GetAccountRateLimitsResponse;
  'review/start': ReviewStartResponse;
}

/** Result of a client request; `unknown` for methods not yet in CodexResponseMap. */
export type CodexResponse<M extends CodexClientRequestMethod> =
  M extends keyof CodexResponseMap ? CodexResponseMap[M] : unknown;

// ── Server → client notifications ───────────────────────────────────────────

export type CodexNotificationMethod = ServerNotification['method'];

export type CodexNotificationParams<M extends CodexNotificationMethod> =
  Extract<ServerNotification, { method: M }>['params'];

// ── Server → client requests ────────────────────────────────────────────────

export type CodexServerRequestMethod = ServerRequest['method'];

export type CodexServerRequestParams<M extends CodexServerRequestMethod> =
  Extract<ServerRequest, { method: M }>['params'];

/** What the client must answer each server request with. */
export interface CodexServerRequestResultMap {
  'item/commandExecution/requestApproval': CommandExecutionRequestApprovalResponse;
  'item/fileChange/requestApproval': FileChangeRequestApprovalResponse;
  'item/tool/requestUserInput': ToolRequestUserInputResponse;
  'mcpServer/elicitation/request': McpServerElicitationRequestResponse;
  'item/permissions/requestApproval': PermissionsRequestApprovalResponse;
  'item/tool/call': DynamicToolCallResponse;
  'account/chatgptAuthTokens/refresh': ChatgptAuthTokensRefreshResponse;
  'attestation/generate': AttestationGenerateResponse;
  'applyPatchApproval': ApplyPatchApprovalResponse;
  'execCommandApproval': ExecCommandApprovalResponse;
}

export type CodexServerRequestResult<M extends CodexServerRequestMethod> = CodexServerRequestResultMap[M];

// ── Messages the vendored schema doesn't know ───────────────────────────────

/**
 * A message the pinned schema has no type for: usually a method added by a
 * newer Codex than the bindings came from. Surfaced, never fatal.
 */
export type CodexUnrecognizedMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: string | number; method: string; params: unknown }
  | { kind: 'other'; message: Record<string, unknown> };

// Compile-time checks that the runtime method lists and result map cover the
// generated unions exactly. A regeneration that adds a method fails typecheck
// here until the list (regenerated with it) and the map agree.
type Missing<Union extends string, Covered extends string> = Exclude<Union, Covered>;
type AssertNever<T extends never> = T;
export type _NotificationMethodsCovered = AssertNever<
  Missing<CodexNotificationMethod, (typeof CODEX_SERVER_NOTIFICATION_METHODS)[number]>
>;
export type _ServerRequestMethodsCovered = AssertNever<
  Missing<CodexServerRequestMethod, (typeof CODEX_SERVER_REQUEST_METHODS)[number]>
>;
export type _ServerRequestResultsCovered = AssertNever<
  Missing<CodexServerRequestMethod, keyof CodexServerRequestResultMap>
>;
export type _ResponseMapMethodsExist = AssertNever<
  Missing<keyof CodexResponseMap, CodexClientRequestMethod>
>;

const NOTIFICATION_METHODS: ReadonlySet<string> = new Set(CODEX_SERVER_NOTIFICATION_METHODS);
const SERVER_REQUEST_METHODS: ReadonlySet<string> = new Set(CODEX_SERVER_REQUEST_METHODS);

export function isKnownNotificationMethod(method: string): method is CodexNotificationMethod {
  return NOTIFICATION_METHODS.has(method);
}

export function isKnownServerRequestMethod(method: string): method is CodexServerRequestMethod {
  return SERVER_REQUEST_METHODS.has(method);
}

// ── Approval decisions ──────────────────────────────────────────────────────

/**
 * Every decision Codex accepts for a command approval, given what the request
 * proposed. The pinned schema has no `availableDecisions` field, so the
 * policy-amendment options are offered exactly when the request carries a
 * proposal to accept.
 */
export function commandApprovalDecisions(
  params: CommandExecutionRequestApprovalParams,
): CommandExecutionApprovalDecision[] {
  const decisions: CommandExecutionApprovalDecision[] = ['accept', 'acceptForSession'];
  if (params.proposedExecpolicyAmendment && params.proposedExecpolicyAmendment.length > 0) {
    decisions.push({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment },
    });
  }
  for (const amendment of params.proposedNetworkPolicyAmendments ?? []) {
    decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
  }
  decisions.push('decline', 'cancel');
  return decisions;
}

/** Every decision Codex accepts for a file-change approval. */
export const FILE_CHANGE_APPROVAL_DECISIONS: readonly FileChangeApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
];
