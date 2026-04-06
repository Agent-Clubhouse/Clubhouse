/**
 * MCP Command Adapter — bridges CommandRegistry with the MCP tool binding system.
 *
 * Provides a unified registration path: tools are registered in both the
 * CommandRegistry (for discoverability, command palette, CLI) AND the existing
 * MCP tool template system (for binding-aware scoping and dispatch).
 *
 * Phase 2 of the CommandRegistry migration (Mission 58).
 */

import { registerToolTemplate } from './tool-registry';
import { commandRegistry } from '../../../shared/command-registry';
import type { CommandDefinition, CommandResult, Disposable, ExecutionContext } from '../../../shared/command-registry';
import type { McpToolResult, BindingTargetKind } from './types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface McpCommandDefinition {
  /** Dot-notation command ID: "agent.sendMessage", "agent.getStatus" */
  id: string;
  /** Grouping category */
  category: string;
  /** Human-readable label */
  label: string;
  /** Description for tool help text */
  description: string;
  /** JSON Schema for arg validation */
  inputSchema?: object;
  /** Where the handler runs */
  process?: 'main' | 'renderer';
  /** Command palette hints */
  palette?: { keywords?: string[]; shortcut?: string; hidden?: boolean };
  /** MCP binding config */
  mcp: {
    /** Target kind for binding scoping */
    targetKind: BindingTargetKind;
    /** Tool name suffix (e.g. "send_message", "get_status") */
    nameSuffix: string;
  };
  /** Handler — receives targetId + agentId + args, returns MCP result */
  handler: (targetId: string, agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
}

/* ------------------------------------------------------------------ */
/*  Result conversion                                                  */
/* ------------------------------------------------------------------ */

/** Convert MCP tool result to CommandResult format. */
function mcpToCommandResult(mcpResult: McpToolResult): CommandResult {
  const text = mcpResult.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return {
    success: !mcpResult.isError,
    data: mcpResult,
    error: mcpResult.isError ? text : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  McpCommandAdapter                                                  */
/* ------------------------------------------------------------------ */

class McpCommandAdapter {
  private readonly disposables: Disposable[] = [];

  /**
   * Register a command that's exposed as both a CommandRegistry entry
   * and an MCP tool template (for binding-aware scoping).
   *
   * The handler is registered in:
   * 1. tool-registry.ts (via registerToolTemplate) — for getScopedToolList/callTool
   * 2. CommandRegistry — for discoverability via list_commands, command palette, CLI
   */
  registerMcpCommand(def: McpCommandDefinition): Disposable {
    // Register in MCP tool template system (existing binding-aware dispatch)
    registerToolTemplate(
      def.mcp.targetKind,
      def.mcp.nameSuffix,
      {
        description: def.description,
        inputSchema: def.inputSchema as McpToolDefinitionSchema,
      },
      def.handler,
    );

    // Register in CommandRegistry for discoverability
    const commandDef: CommandDefinition = {
      id: def.id,
      category: def.category,
      label: def.label,
      description: def.description,
      inputSchema: def.inputSchema,
      process: def.process || 'main',
      palette: def.palette || { hidden: true },
      mcp: { scoping: 'binding' },
      handler: (context: ExecutionContext, args: Record<string, unknown>): Promise<CommandResult> => {
        // When invoked via CommandRegistry (e.g. command palette), we need
        // targetId and agentId from context or args
        const targetId = (args.targetId as string) || context.agentId || '';
        const agentId = context.agentId || '';
        return def.handler(targetId, agentId, args).then(mcpToCommandResult);
      },
    };

    const disposable = commandRegistry.register(commandDef);
    this.disposables.push(disposable);
    return disposable;
  }

  /** Dispose all registered commands and clear the registry (for testing). */
  _resetForTesting(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
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
