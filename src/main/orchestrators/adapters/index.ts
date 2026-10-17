// Protocol plumbing kept for the upcoming Chat runtime (see
// docs/structured-chat-research.md). The structured-mode adapters that used
// these were removed; the clients and spawn helper are protocol-level and
// carry the #1911 fixes (Codex app-server v2 shapes, ACP session/update,
// Windows .cmd shim spawning). The Codex client is typed against the vendored
// app-server bindings in ./codex-protocol.
export { AsyncQueue } from './async-queue';
export { AcpClient, RpcError } from './acp-client';
export type { AcpClientOpts } from './acp-client';
export { AcpSession, GENERIC_ACP_PROFILE, CLUBHOUSE_ACP_CLIENT_CAPABILITIES } from './acp-session';
export type { AcpSessionOpts, AcpSessionEvent, AcpSessionState, AcpAgentProfile, TurnStopReason } from './acp-session';
export { deriveAcpCapabilities, terminalLoginCommand } from './acp-capabilities';
export type { AcpDriverCapabilities } from './acp-capabilities';
export { parseSessionUpdate } from './acp-updates';
export { AcpChatDriver, COPILOT_ACP_LAUNCH, createCopilotAcpChatDriver, createGenericAcpChatDriver } from './acp-chat-driver';
export type { AcpLaunchSpec } from './acp-chat-driver';
export { AcpChatEventMapper, toChatCapabilities } from './acp-chat-mapper';
export { ACP_SCHEMA_VERSION, ACP_PROTOCOL_VERSION } from './acp-schema';
export {
  COPILOT_ACP_ARGS,
  COPILOT_ACP_PROFILE,
  COPILOT_PERMISSION_LEVELS,
  COPILOT_ACP_TESTED_RANGE,
  resolveCopilotAcpSpawn,
  selectAcpProfile,
  copilotModeKind,
  copilotVersionStatus,
} from './copilot-acp';
export {
  CodexAppServerClient,
  CODEX_RPC_INTERNAL_ERROR,
  CODEX_RPC_METHOD_NOT_FOUND,
  textInput,
} from './codex-app-server-client';
export type { CodexAppServerClientOpts } from './codex-app-server-client';
