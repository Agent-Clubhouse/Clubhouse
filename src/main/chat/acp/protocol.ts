/**
 * The part of the Agent Client Protocol (stable v1) Clubhouse speaks, written
 * by hand from the vendored public schema (schema/schema.v1.json, see
 * schema/PROVENANCE.md). protocol.test.ts holds the constants here to that
 * file, so a schema upgrade that renames or drops something fails there.
 *
 * Only stable-schema methods appear. Every optional one is gated on what the
 * agent advertised in `initialize`:
 *   session/load        agentCapabilities.loadSession
 *   session/resume      agentCapabilities.sessionCapabilities.resume
 *   session/close       agentCapabilities.sessionCapabilities.close
 *   session/list        agentCapabilities.sessionCapabilities.list (not sent)
 *   systemPrompt field  agentCapabilities.sessionCapabilities.systemPrompt
 *   elicitation/create  the client's own clientCapabilities.elicitation.form
 * session/new, session/prompt, session/cancel and session/update are the
 * baseline every agent MUST support (SessionCapabilities in the schema), and
 * $/cancel_request is a protocol-level notification either side may send.
 *
 * Docs: https://agentclientprotocol.com/protocol/v1/overview
 */

/** Protocol major version Clubhouse requests in `initialize`. */
export const ACP_PROTOCOL_VERSION = 1;

/** Package and version the vendored schema came from (schema/PROVENANCE.md). */
export const ACP_SCHEMA_SOURCE = { package: '@agentclientprotocol/sdk', version: '2.9.1', file: 'schema/v1/schema.json' } as const;

export const ACP_AGENT_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  logout: 'logout',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  sessionList: 'session/list',
  sessionDelete: 'session/delete',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
} as const;

export const ACP_CLIENT_METHODS = {
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
  elicitationCreate: 'elicitation/create',
  elicitationComplete: 'elicitation/complete',
  fsReadTextFile: 'fs/read_text_file',
  fsWriteTextFile: 'fs/write_text_file',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalRelease: 'terminal/release',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill',
} as const;

export const ACP_PROTOCOL_METHODS = { cancelRequest: '$/cancel_request' } as const;

export const ACP_SESSION_UPDATE_KINDS = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
  'subagent_update',
  'session_message',
  'session_message_chunk',
] as const;
export type SessionUpdateKind = (typeof ACP_SESSION_UPDATE_KINDS)[number];

export const ACP_STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const;
export type StopReason = (typeof ACP_STOP_REASONS)[number];

export const ACP_PERMISSION_OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
export type PermissionOptionKind = (typeof ACP_PERMISSION_OPTION_KINDS)[number];

export const ACP_TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;
export type ToolKind = (typeof ACP_TOOL_KINDS)[number];

export const ACP_TOOL_CALL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;
export type ToolCallStatus = (typeof ACP_TOOL_CALL_STATUSES)[number];

/** The schema's named `ErrorCode` values. */
export const ACP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

// ── Shapes ─────────────────────────────────────────────────────────────────
// Field subsets of the schema's definitions. Optional fields the schema marks
// nullable are typed `| null`. `_meta` is never read: the schema says
// implementations must not assume anything about it.

export interface Implementation { name: string; title?: string | null; version?: string | null }

export interface ClientCapabilities {
  fs?: { readTextFile: boolean; writeTextFile: boolean };
  terminal?: boolean;
  elicitation?: { form?: Record<string, never> | null; url?: Record<string, never> | null } | null;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: {
    list?: object | null;
    delete?: object | null;
    additionalDirectories?: object | null;
    systemPrompt?: object | null;
    resume?: object | null;
    close?: object | null;
  };
}

/** `type` absent means `agent`: the agent logs in through `authenticate`. */
export type AuthMethod =
  | { type: 'terminal'; id: string; name: string; description?: string | null; args?: string[]; env?: Record<string, string> }
  | { type?: 'agent'; id: string; name: string; description?: string | null };

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: Implementation | null;
}

export type McpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: 'http' | 'sse'; name: string; url: string; headers: Array<{ name: string; value: string }> };

export interface SystemPrompt { mode: 'append'; content: ContentBlock[] }

export interface SessionSetup {
  cwd: string;
  mcpServers: McpServer[];
  systemPrompt?: SystemPrompt;
}

export interface SessionMode { id: string; name: string; description?: string | null }
export interface SessionModeState { currentModeId: string; availableModes: SessionMode[] }

export interface SessionConfigSelectOption { value: string; name: string; description?: string | null }
export type SessionConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  /** `mode`, `model`, `thought_level`, or `_`-prefixed custom ones. Must not be needed for correctness. */
  category?: string | null;
} & (
  | {
      type: 'select';
      currentValue: string;
      options: SessionConfigSelectOption[] | Array<{ group: string; name: string; options: SessionConfigSelectOption[] }>;
    }
  | { type: 'boolean'; currentValue: boolean }
);

/** `session/new`; `session/load` and `session/resume` answer with the same fields minus `sessionId`. */
export interface SessionSetupResponse {
  sessionId?: string;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string | null }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string | null; title?: string | null; description?: string | null }
  | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string | null } | { uri: string; blob: string; mimeType?: string | null } };

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface ToolCallLocation { path: string; line?: number | null }

export interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }

export interface AvailableCommand { name: string; description: string; input?: { hint: string } | null }

/** The `update` of a `session/update` notification, for the variants Clubhouse maps. */
export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: 'tool_call'; title: string } & ToolCallFields)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallFields)
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[] }
  | { sessionUpdate: 'session_info_update'; title?: string | null; updatedAt?: string | null }
  | { sessionUpdate: 'usage_update'; used: number; size: number; cost?: { amount: number; currency: string } | null };

export interface SessionNotification { sessionId: string; update: SessionUpdate | { sessionUpdate: string } }

export interface PromptRequest { sessionId: string; prompt: ContentBlock[] }
export interface PromptResponse { stopReason: StopReason }

export interface PermissionOption { optionId: string; name: string; kind: PermissionOptionKind }
export interface RequestPermissionRequest { sessionId: string; toolCall: ToolCallFields; options: PermissionOption[] }
export type RequestPermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };
export interface RequestPermissionResponse { outcome: RequestPermissionOutcome }

/** A form field in an elicitation's `requestedSchema` (ElicitationPropertySchema). */
export type ElicitationProperty =
  | { type: 'string'; title?: string | null; description?: string | null; enum?: string[] | null; oneOf?: Array<{ const: string; title?: string | null }> | null }
  | { type: 'number' | 'integer'; title?: string | null; description?: string | null }
  | { type: 'boolean'; title?: string | null; description?: string | null }
  | { type: 'array'; title?: string | null; description?: string | null; items?: { enum?: string[] | null; anyOf?: Array<{ const: string; title?: string | null }> | null } | null };

/** Form-mode `elicitation/create` scoped to a session (the only kind Clubhouse advertises). */
export interface CreateElicitationRequest {
  mode: string;
  message: string;
  sessionId?: string;
  toolCallId?: string | null;
  requestId?: string | number;
  requestedSchema?: { type?: 'object'; title?: string | null; properties?: Record<string, ElicitationProperty>; required?: string[] | null };
}

export type ElicitationValue = string | number | boolean | string[];
export type CreateElicitationResponse =
  | { action: 'accept'; content?: Record<string, ElicitationValue> | null }
  | { action: 'decline' }
  | { action: 'cancel' };
