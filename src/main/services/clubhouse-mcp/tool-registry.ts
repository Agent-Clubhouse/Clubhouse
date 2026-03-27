/**
 * Tool Registry — manages tool definitions and generates scoped tool lists
 * based on an agent's current bindings.
 */

import type { McpToolDefinition, McpToolResult, McpBinding, BindingTargetKind } from './types';
import { bindingManager } from './binding-manager';
import { agentRegistry } from '../agent-registry';
import { groupProjectRegistry } from '../group-project-registry';
import { appLog } from '../log-service';

/** Tool suffixes gated behind the group-project shoulderTapEnabled setting. */
const SHOULDER_TAP_SUFFIXES = new Set(['shoulder_tap', 'broadcast']);

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
 * using a human-readable name pattern.
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
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

/** Generate a short 4-character hash of a string for uniqueness in tool names (FNV-1a). */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (hash >>> 0).toString(36).padStart(4, '0').slice(0, 4);
}

/**
 * Build a tool key (the middle segment of a tool name) from a binding.
 * For agent targets: `<project>_<targetName>_<hash>`
 * For other targets: sanitized targetId.
 */
export function buildToolKey(binding: McpBinding): string {
  if (binding.targetKind === 'agent') {
    const project = sanitizeId(binding.projectName || 'project');
    const name = sanitizeId(binding.targetName || binding.label || binding.targetId);
    const hash = shortHash(binding.targetId);
    return `${project}_${name}_${hash}`;
  }
  if (binding.targetKind === 'group-project' || binding.targetKind === 'agent-queue') {
    const name = sanitizeId(binding.targetName || binding.label || binding.targetId);
    const hash = shortHash(binding.targetId);
    return `${name}_${hash}`;
  }
  return sanitizeId(binding.targetId);
}

/**
 * Build the full tool name from a binding and action suffix.
 * Agent targets: `clubhouse__<project>_<name>_<hash>__<suffix>`
 * Other targets: `<targetKind>__<sanitizedId>__<suffix>`
 */
export function buildToolName(binding: McpBinding, suffix: string): string {
  const prefix = binding.targetKind === 'agent' ? 'clubhouse'
    : binding.targetKind === 'group-project' ? 'group'
    : binding.targetKind === 'agent-queue' ? 'queue'
    : binding.targetKind;
  return `${prefix}__${buildToolKey(binding)}__${suffix}`;
}

/** Parse a tool name back into its components. Returns null if format doesn't match. */
export function parseToolName(name: string): { prefix: string; toolKey: string; suffix: string } | null {
  const match = name.match(/^(clubhouse|browser|terminal|group|queue|assistant)__([a-zA-Z0-9_]+)__([a-zA-Z_]+)$/);
  if (!match) return null;
  return { prefix: match[1], toolKey: match[2], suffix: match[3] };
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

    // When target agent is sleeping (not in registry), only expose status and wake tools
    const isTargetSleeping = binding.targetKind === 'agent' && !agentRegistry.get(binding.targetId);

    // For group-project bindings, check if shoulder tap is enabled at the project level
    let shoulderTapEnabled = false;
    if (binding.targetKind === 'group-project') {
      const project = groupProjectRegistry.getSync(binding.targetId);
      shoulderTapEnabled = !!(project?.metadata?.shoulderTapEnabled);
    }

    for (const template of templates) {
      if (isTargetSleeping && template.nameSuffix !== 'get_status' && template.nameSuffix !== 'wake') {
        continue;
      }

      // Skip tools disabled at the wire level
      if (binding.disabledTools?.includes(template.nameSuffix)) {
        continue;
      }

      // Skip shoulder tap tools when not enabled at the group project level
      if (binding.targetKind === 'group-project' && SHOULDER_TAP_SUFFIXES.has(template.nameSuffix) && !shoulderTapEnabled) {
        continue;
      }

      let description = template.definition.description;

      // Inject per-wire custom instructions into tool description
      if (binding.instructions) {
        const specificInstruction = binding.instructions[template.nameSuffix];
        const globalInstruction = binding.instructions['*'];
        const instruction = specificInstruction || globalInstruction;
        if (instruction) {
          description += `\n\nWIRE INSTRUCTIONS: ${instruction}`;
        }
      }

      tools.push({
        ...template.definition,
        description,
        name: buildToolName(binding, template.nameSuffix),
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
  const binding = bindings.find(b => {
    const expectedPrefix = b.targetKind === 'agent' ? 'clubhouse'
      : b.targetKind === 'group-project' ? 'group'
      : b.targetKind === 'agent-queue' ? 'queue'
      : b.targetKind;
    return expectedPrefix === parsed.prefix && buildToolKey(b) === parsed.toolKey;
  });
  if (!binding) {
    appLog('core:mcp', 'warn', 'Tool call: no binding matches target', {
      meta: {
        agentId,
        parsedToolKey: parsed.toolKey,
        availableBindings: bindings.map(b => ({ targetId: b.targetId, toolKey: buildToolKey(b), targetKind: b.targetKind })),
      },
    });
    return {
      content: [{ type: 'text', text: `No binding found for target: ${parsed.toolKey}` }],
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

  // Validate arguments against the tool's declared inputSchema
  const schema = template.definition.inputSchema;
  if (schema && typeof schema === 'object') {
    const schemaObj = schema as Record<string, unknown>;
    const required = (schemaObj.required as string[]) || [];
    const properties = (schemaObj.properties as Record<string, { type?: string }>) || {};

    // Check required fields are present
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        return {
          content: [{ type: 'text', text: `Missing required argument: ${field}` }],
          isError: true,
        };
      }
    }

    // Check types of provided fields
    for (const [key, value] of Object.entries(args)) {
      const propSchema = properties[key];
      if (propSchema?.type && typeof value !== propSchema.type) {
        return {
          content: [{ type: 'text', text: `Invalid type for argument "${key}": expected ${propSchema.type}, got ${typeof value}` }],
          isError: true,
        };
      }
    }
  }

  return template.handler(binding.targetId, agentId, args);
}

/** For testing: clear all registered templates. */
export function _resetForTesting(): void {
  toolTemplates.clear();
}
