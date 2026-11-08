/**
 * MCP command adapter: registers the wire tools (agent, group project and
 * browser commands) as tool templates, so every call goes through callTool's
 * gates and the grant check (#2968).
 *
 * It used to register each one in a shared CommandRegistry too, whose handler
 * called the tool directly with no gate, grant or wire check. Nothing in the
 * app called it, so that path is gone (#2974): a tool is reached only through
 * callTool.
 */

import { registerToolTemplate, type ToolGroups } from './tool-registry';
import type { ToolGrant } from './tool-grants';
import type { McpToolResult, BindingTargetKind } from './types';

/** Undoes a registration. */
export interface Disposable {
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface McpCommandDefinition {
  /** Dot-notation ID: "agent.sendMessage", "agent.getStatus". Descriptive only. */
  id: string;
  /** Grouping category. Descriptive only. */
  category: string;
  /** Human-readable label. Descriptive only. */
  label: string;
  /** Description for tool help text */
  description: string;
  /** JSON Schema for arg validation */
  inputSchema?: object;
  /** MCP binding config */
  mcp: {
    /** Target kind for binding scoping */
    targetKind: BindingTargetKind;
    /** Tool name suffix (e.g. "send_message", "get_status") */
    nameSuffix: string;
    /** The grant actions a call needs and where its target comes from (#2967). Required. */
    grant: ToolGrant;
    /** Gate the tool behind a tool group, or several. */
    group?: ToolGroups;
  };
  /** Handler — receives targetId + agentId + args, returns MCP result */
  handler: (targetId: string, agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
}

/* ------------------------------------------------------------------ */
/*  McpCommandAdapter                                                  */
/* ------------------------------------------------------------------ */

class McpCommandAdapter {
  /** Register a wire tool as a tool template: reached only through callTool's gates (#2974). */
  registerMcpCommand(def: McpCommandDefinition): Disposable {
    registerToolTemplate(
      def.mcp.targetKind,
      def.mcp.nameSuffix,
      {
        description: def.description,
        inputSchema: def.inputSchema as McpToolDefinitionSchema,
      },
      def.handler,
      { grant: def.mcp.grant, ...(def.mcp.group && { group: def.mcp.group }) },
    );
    // Templates are cleared with the tool registry (_resetForTesting there).
    return { dispose: () => {} };
  }

  /** Kept for tests that reset it alongside the tool registry. */
  _resetForTesting(): void {}
}

// Internal type reference for inputSchema
type McpToolDefinitionSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
};

/** Singleton adapter instance. */
export const mcpAdapter = new McpCommandAdapter();

/** Export class for testing. */
export { McpCommandAdapter };
