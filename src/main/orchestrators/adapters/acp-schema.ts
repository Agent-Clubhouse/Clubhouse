/**
 * Agent Client Protocol (ACP) v1 wire types.
 *
 * Hand-written from the stable schema in agentclientprotocol/agent-client-protocol
 * at tag `schema-v1.26.0` (schema/v1/schema.json). A copy of that schema and
 * its method table is vendored under `__fixtures__/acp/schema-v1.26.0/`, and
 * `acp-schema.test.ts` fails when the constants below drift from it. Bump
 * both together.
 *
 * Only the stable surface is modelled. Unstable fields an agent sends anyway
 * (Copilot's legacy `models` on session/new, the per-turn `usage` on the
 * prompt result) are typed as optional extras where the driver reads them.
 */

export const ACP_SCHEMA_VERSION = '1.26.0';
export const ACP_PROTOCOL_VERSION = 1;

/** Agent-side methods (client → agent), from schema/v1/meta.json. */
export const ACP_AGENT_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionList: 'session/list',
  sessionDelete: 'session/delete',
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  logout: 'logout',
} as const;

/** Client-side methods (agent → client), from schema/v1/meta.json. */
export const ACP_CLIENT_METHODS = {
  sessionRequestPermission: 'session/request_permission',
  sessionUpdate: 'session/update',
  fsWriteTextFile: 'fs/write_text_file',
  fsReadTextFile: 'fs/read_text_file',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalRelease: 'terminal/release',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill',
  elicitationCreate: 'elicitation/create',
  elicitationComplete: 'elicitation/complete',
} as const;

export const ACP_PROTOCOL_METHODS = {
  cancelRequest: '$/cancel_request',
} as const;

/** JSON-RPC error codes ACP assigns meaning to. */
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

export type Meta = Record<string, unknown> | null;

// ── Content ────────────────────────────────────────────────────────────────

export interface TextContent { type: 'text'; text: string; annotations?: unknown; _meta?: Meta }
export interface ImageContent { type: 'image'; data: string; mimeType: string; uri?: string | null; annotations?: unknown; _meta?: Meta }
export interface AudioContent { type: 'audio'; data: string; mimeType: string; annotations?: unknown; _meta?: Meta }
export interface ResourceLink {
  type: 'resource_link';
  name: string;
  uri: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  annotations?: unknown;
  _meta?: Meta;
}
export interface EmbeddedResource {
  type: 'resource';
  resource:
    | { uri: string; text: string; mimeType?: string | null; _meta?: Meta }
    | { uri: string; blob: string; mimeType?: string | null; _meta?: Meta };
  annotations?: unknown;
  _meta?: Meta;
}
export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;

// ── Capabilities and initialize ────────────────────────────────────────────

export interface Implementation { name: string; version: string; title?: string | null }

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  session?: {
    /** `{}` advertises the complete compaction contract. */
    compaction?: Record<string, never> | null;
    configOptions?: { boolean?: Record<string, never> | null } | null;
    /** `{}` means the client can present `notice` updates. */
    notices?: Record<string, never> | null;
  } | null;
  auth?: { terminal?: boolean };
  elicitation?: { form?: Record<string, never> | null; url?: Record<string, never> | null } | null;
  _meta?: Meta;
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
    resume?: object | null;
    close?: object | null;
  };
  auth?: { logout?: object | null };
  _meta?: Meta;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  /** Absent means `agent` (handled through `authenticate`). */
  type?: 'agent' | 'terminal';
  args?: string[];
  env?: Record<string, string>;
  _meta?: Meta;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: Implementation | null;
  _meta?: Meta;
}

// ── Sessions ───────────────────────────────────────────────────────────────

export type McpServer =
  | { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: 'sse'; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export interface SessionMode { id: string; name: string; description?: string | null }
export interface SessionModeState { currentModeId: string; availableModes: SessionMode[] }

export type SessionConfigOptionCategory = 'mode' | 'model' | 'model_config' | 'thought_level' | 'other' | (string & {});

export interface SessionConfigSelectOption { value: string; name: string; description?: string | null; _meta?: Meta }
export interface SessionConfigSelectGroup { group: string; name: string; options: SessionConfigSelectOption[]; _meta?: Meta }

interface SessionConfigOptionBase {
  id: string;
  name: string;
  description?: string | null;
  category?: SessionConfigOptionCategory | null;
  _meta?: Meta;
}
export interface SessionConfigSelect extends SessionConfigOptionBase {
  type: 'select';
  currentValue: string;
  /** Flat list, or a list of groups. */
  options: SessionConfigSelectOption[] | SessionConfigSelectGroup[];
}
export interface SessionConfigBoolean extends SessionConfigOptionBase {
  type: 'boolean';
  currentValue: boolean;
}
export type SessionConfigOption = SessionConfigSelect | SessionConfigBoolean;

/** Copilot still sends the pre-config-options model list (unstable in the schema). */
export interface LegacySessionModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string; description?: string | null; _meta?: Meta }>;
}

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
}
export interface NewSessionResponse {
  sessionId: string;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
  models?: LegacySessionModelState | null;
  _meta?: Meta;
}
export interface LoadSessionRequest extends NewSessionRequest { sessionId: string }
export type LoadSessionResponse = Omit<NewSessionResponse, 'sessionId'>;
export interface ResumeSessionRequest { sessionId: string; cwd: string; mcpServers?: McpServer[]; additionalDirectories?: string[] }
export type ResumeSessionResponse = LoadSessionResponse;

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Meta;
}
export interface ListSessionsResponse { sessions: SessionInfo[]; nextCursor?: string | null }

// ── Prompt turn ────────────────────────────────────────────────────────────

export const ACP_STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const;
export type StopReason = typeof ACP_STOP_REASONS[number];

/** Per-turn token totals. Not in stable v1 (draft RFD); Copilot sends it on the prompt result. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export interface PromptResponse {
  stopReason: string;
  usage?: TurnUsage | null;
  _meta?: Meta;
}

// ── Tool calls ─────────────────────────────────────────────────────────────

export const ACP_TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;
export type ToolKind = typeof ACP_TOOL_KINDS[number];

export const ACP_TOOL_CALL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;
export type ToolCallStatus = typeof ACP_TOOL_CALL_STATUSES[number];

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock; _meta?: Meta }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string; _meta?: Meta }
  | { type: 'terminal'; terminalId: string; _meta?: Meta };

export interface ToolCallLocation { path: string; line?: number | null }

export interface ToolCall {
  toolCallId: string;
  title: string;
  name?: string | null;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Meta;
}

export interface ToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Meta;
}

// ── Session updates ────────────────────────────────────────────────────────

export const ACP_SESSION_UPDATE_KINDS = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
] as const;
export type SessionUpdateKind = typeof ACP_SESSION_UPDATE_KINDS[number];

export interface ContentChunk { content: ContentBlock; messageId?: string | null; _meta?: Meta }

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
  _meta?: Meta;
}

export interface AvailableCommand {
  name: string;
  description: string;
  /** Only the `unstructured` input shape exists in v1: `{ hint }`. */
  input?: { hint: string } | null;
  _meta?: Meta;
}

export type NoticeSeverity = 'info' | 'warning' | 'error' | 'other' | (string & {});
export type CompactionStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'other' | (string & {});

export type SessionUpdate =
  | ({ sessionUpdate: 'user_message_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'agent_message_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'agent_thought_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'tool_call' } & ToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallUpdate)
  | { sessionUpdate: 'plan'; entries: PlanEntry[]; _meta?: Meta }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[]; _meta?: Meta }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string; _meta?: Meta }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[]; _meta?: Meta }
  | { sessionUpdate: 'session_info_update'; title?: string | null; updatedAt?: string | null; _meta?: Meta }
  | { sessionUpdate: 'usage_update'; used: number; size: number; cost?: { amount: number; currency: string } | null; _meta?: Meta }
  | { sessionUpdate: 'notice'; severity: NoticeSeverity; title: string; description?: string | null; _meta?: Meta }
  | { sessionUpdate: 'compaction_update'; compactionId: string; status: CompactionStatus; summary?: ContentBlock[] | null; error?: string | null; _meta?: Meta }
  | { sessionUpdate: 'compaction_summary_chunk'; compactionId: string; content: ContentBlock; _meta?: Meta };

export interface SessionNotification { sessionId: string; update: SessionUpdate; _meta?: Meta }

// ── Permissions ────────────────────────────────────────────────────────────

export const ACP_PERMISSION_OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
export type PermissionOptionKind = typeof ACP_PERMISSION_OPTION_KINDS[number];

export interface PermissionOption { optionId: string; name: string; kind: PermissionOptionKind; _meta?: Meta }

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  _meta?: Meta;
}

export type RequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export interface RequestPermissionResponse { outcome: RequestPermissionOutcome; _meta?: Meta }
