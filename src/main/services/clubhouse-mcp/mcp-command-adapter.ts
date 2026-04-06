/**
 * MCP Command Adapter — bridges MCP tool templates into the CommandRegistry.
 *
 * Each MCP tool is registered as both:
 * 1. A CommandDefinition in the CommandRegistry (for unified dispatch)
 * 2. A tool template in the existing tool-registry (for backward compatibility)
 *
 * This dual registration means callers can invoke tools through either path
 * during the migration period. Once all consumers use the registry, the
 * legacy tool-registry path can be removed.
 */

import { commandRegistry } from '../../../shared/command-registry';
import type { CommandDefinition, CommandResult, Disposable, ExecutionContext } from '../../../shared/command-registry';
import { registerToolTemplate } from './tool-registry';
import type { McpToolResult, McpToolDefinition, BindingTargetKind } from './types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface McpCommandDefinition {
  /** Dot-notation command ID: "assistant.createCanvas" */
  id: string;
  /** Category for grouping: "assistant", "agent", "browser", etc. */
  category: string;
  /** Human-readable label */
  label: string;
  /** Description (used for MCP tool description) */
  description: string;
  /** JSON Schema for arguments */
  inputSchema?: object;
  /** MCP target kind for binding scoping */
  targetKind: BindingTargetKind;
  /** MCP tool name suffix (e.g. "create_canvas") */
  nameSuffix: string;
  /** Handler: receives targetId, agentId, and args; returns MCP tool result */
  handler: (targetId: string, agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /** Command palette hints */
  palette?: { keywords?: string[]; shortcut?: string; hidden?: boolean };
}

/* ------------------------------------------------------------------ */
/*  Adapter                                                            */
/* ------------------------------------------------------------------ */

const registeredDisposables: Disposable[] = [];

/**
 * Register an MCP tool as both a CommandDefinition and a legacy tool template.
 *
 * The command ID follows dot-notation: `{category}.{camelCaseSuffix}`.
 * The tool template uses the existing `registerToolTemplate` for backward
 * compatibility with `getScopedToolList` and `callTool`.
 */
export function registerMcpCommand(def: McpCommandDefinition): Disposable {
  // 1. Register in CommandRegistry
  const commandDef: CommandDefinition = {
    id: def.id,
    category: def.category,
    label: def.label,
    description: def.description,
    inputSchema: def.inputSchema,
    process: 'main',
    palette: def.palette,
    mcp: { scoping: 'binding' },
    handler: async (context: ExecutionContext, args: Record<string, unknown>): Promise<CommandResult> => {
      const targetId = (args._targetId as string) || '';
      const agentId = context.agentId || '';
      try {
        const result = await def.handler(targetId, agentId, args);
        const text = result.content
          ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text)
          .join('\n') || '';
        return {
          success: !result.isError,
          data: text,
          error: result.isError ? text : undefined,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  const disposable = commandRegistry.register(commandDef);
  registeredDisposables.push(disposable);

  // 2. Also register as legacy tool template for backward compatibility
  registerToolTemplate(
    def.targetKind,
    def.nameSuffix,
    { description: def.description, inputSchema: (def.inputSchema as McpToolDefinition['inputSchema']) || { type: 'object' } },
    def.handler,
  );

  return disposable;
}

/**
 * Convert a snake_case tool suffix to a dot-notation command ID.
 * e.g., ("assistant", "create_canvas") → "assistant.createCanvas"
 */
export function toCommandId(category: string, snakeSuffix: string): string {
  const camel = snakeSuffix.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return `${category}.${camel}`;
}

/** For testing: dispose all registered commands. */
export function _resetAdapterForTesting(): void {
  for (const d of registeredDisposables) {
    d.dispose();
  }
  registeredDisposables.length = 0;
}
