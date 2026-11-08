/**
 * Clubhouse MCP — public API.
 *
 * Provides agent-to-widget and agent-to-agent interaction via MCP tools.
 * Always on: no setting turns it off.
 */

export { bindingManager } from './binding-manager';
export * as bridgeServer from './bridge-server';
export { injectClubhouseMcp, isClubhouseMcpEntry, stripClubhouseMcp, buildClubhouseMcpDef, scrubClubhouseNonce, scrubClubhouseNonceToml, CLUBHOUSE_NONCE_ENV } from './injection';
export { getScopedToolList, callTool, registerToolTemplate, registerGlobalTool, buildToolName, parseToolName } from './tool-registry';
export type { McpBinding, BindingTargetKind, McpToolDefinition, McpToolResult } from './types';
