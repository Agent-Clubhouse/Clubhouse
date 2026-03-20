/**
 * Tool Registry — manages tool definitions and generates scoped tool lists
 * based on an agent's current bindings.
 */

import type { McpToolDefinition, McpToolResult, BindingTargetKind } from './types';
import { bindingManager } from './binding-manager';
import { appLog } from '../log-service';

/**
 * Tool templates keyed by targetKind.
 * Each template generates tools for a specific bound target.
 */
const toolTemplates = new Map<BindingTargetKind, Array<{
  nameSuffix: string;
  definition: Omit<McpToolDefinition, 'name'>;
  handler: (targetId: string, agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
}>>();

/**
 * Register a tool template for a target kind.
 * When an agent is bound to a target of this kind, a tool will be generated
 * with the name pattern: `{targetKind}__{targetId}__{nameSuffix}`.
 */
export function registerToolTemplate(
  targetKind: BindingTargetKind,
  nameSuffix: string,
  definition: Omit<McpToolDefinition, 'name'>,
  handler: (targetId: string, agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>,
): void {
  let templates = toolTemplates.get(targetKind);
  if (!templates) {
    templates = [];
    toolTemplates.set(targetKind, templates);
  }
  templates.push({ nameSuffix, definition, handler });
}

/** Sanitize an ID for use in tool names (replace non-alphanumeric with underscores). */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

/** Build the tool name from target kind, target ID, and suffix. */
export function buildToolName(targetKind: BindingTargetKind, targetId: string, suffix: string): string {
  return `${targetKind}__${sanitizeId(targetId)}__${suffix}`;
}

/** Parse a tool name back into its components. Returns null if format doesn't match. */
export function parseToolName(name: string): { targetKind: string; targetId: string; suffix: string } | null {
  const match = name.match(/^(browser|agent|terminal)__([a-zA-Z0-9_]+)__([a-zA-Z_]+)$/);
  if (!match) return null;
  return { targetKind: match[1], targetId: match[2], suffix: match[3] };
}

/**
 * Get the scoped tool list for an agent based on its current bindings.
 */
export function getScopedToolList(agentId: string): McpToolDefinition[] {
  const bindings = bindingManager.getBindingsForAgent(agentId);
  const tools: McpToolDefinition[] = [];

  for (const binding of bindings) {
    const templates = toolTemplates.get(binding.targetKind);
    if (!templates) continue;

    for (const template of templates) {
      tools.push({
        ...template.definition,
        name: buildToolName(binding.targetKind, binding.targetId, template.nameSuffix),
      });
    }
  }

  return tools;
}

/**
 * Resolve a tool call: find the handler for the given tool name and execute it.
 */
export async function callTool(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const parsed = parseToolName(toolName);
  if (!parsed) {
    appLog('core:mcp', 'warn', 'Tool call: failed to parse tool name', {
      meta: { agentId, toolName },
    });
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  // Verify the agent has this binding
  const bindings = bindingManager.getBindingsForAgent(agentId);
  const binding = bindings.find(b => sanitizeId(b.targetId) === parsed.targetId);
  if (!binding) {
    appLog('core:mcp', 'warn', 'Tool call: no binding matches target', {
      meta: {
        agentId,
        parsedTarget: parsed.targetId,
        availableBindings: bindings.map(b => ({ targetId: b.targetId, sanitized: sanitizeId(b.targetId), targetKind: b.targetKind })),
      },
    });
    return {
      content: [{ type: 'text', text: `No binding found for target: ${parsed.targetId}` }],
      isError: true,
    };
  }

  const templates = toolTemplates.get(binding.targetKind);
  if (!templates) {
    return {
      content: [{ type: 'text', text: `No tools registered for kind: ${binding.targetKind}` }],
      isError: true,
    };
  }

  const template = templates.find(t => t.nameSuffix === parsed.suffix);
  if (!template) {
    return {
      content: [{ type: 'text', text: `Unknown tool action: ${parsed.suffix}` }],
      isError: true,
    };
  }

  return template.handler(binding.targetId, agentId, args);
}

/** For testing: clear all registered templates. */
export function _resetForTesting(): void {
  toolTemplates.clear();
}
