/**
 * Shared types for the Clubhouse MCP bridge system.
 */

/** The kind of target a binding points to. */
export type BindingTargetKind = 'browser' | 'agent' | 'terminal' | 'group-project';

/** A single binding between an agent and a canvas widget or another agent. */
export interface McpBinding {
  agentId: string;
  targetId: string;
  targetKind: BindingTargetKind;
  label: string;
  /** Human-readable name of the source agent (e.g. "scrappy-robin"). */
  agentName?: string;
  /** Human-readable name of the target (e.g. "faithful-urchin" for agents). */
  targetName?: string;
  /** Human-readable project name (e.g. "my-frontend-app"). */
  projectName?: string;
  /**
   * Per-wire custom instructions injected into tool descriptions.
   * Keys are tool suffixes (e.g. "send_message") or "*" for all tools.
   */
  instructions?: Record<string, string>;
  /**
   * Tool suffixes disabled on this wire (e.g. ["read_output", "broadcast"]).
   * Tools in this list are excluded from the scoped tool list.
   */
  disabledTools?: string[];
}

/** MCP JSON-RPC request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** MCP JSON-RPC response envelope. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP JSON-RPC notification (no id). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** MCP tool definition as returned by tools/list. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** Result of an MCP tool call. */
export interface McpToolResult {
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/** Handler function for a registered tool. */
export type McpToolHandler = (
  agentId: string,
  args: Record<string, unknown>,
) => Promise<McpToolResult>;

/** A registered tool with its definition and handler. */
export interface RegisteredTool {
  definition: McpToolDefinition;
  handler: McpToolHandler;
  /** Which target kind this tool belongs to (for scoping). */
  targetKind: BindingTargetKind;
}
