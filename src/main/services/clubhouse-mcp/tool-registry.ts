/**
 * Tool Registry — manages tool definitions and generates scoped tool lists
 * based on an agent's current bindings.
 */

import type { McpToolDefinition, McpToolResult, McpBinding, BindingTargetKind } from './types';
import { bindingManager } from './binding-manager';
import { agentRegistry } from '../agent-registry';
import { groupProjectRegistry } from '../group-project-registry';
import { deniedGroupProjectTools } from '../../../shared/group-project-admin';
import { appLog } from '../log-service';
import { isOrchestrationEnabled, onOrchestrationGateChange } from './orchestration-gate';
import { ORCHESTRATION_OFF_MESSAGE } from '../../../shared/orchestration-policy';

/** Check if a value matches a JSON Schema type (handles array vs object correctly). */
function matchesJsonSchemaType(value: unknown, schemaType: string): boolean {
  if (schemaType === 'array') return Array.isArray(value);
  if (schemaType === 'object') return typeof value === 'object' && !Array.isArray(value) && value !== null;
  return typeof value === schemaType;
}

/**
 * A tool group gates its tools per agent: they are listed only for agents the
 * group is on for, and callTool refuses them for any other agent, so a client
 * holding a stale tool list can't reach them either.
 * - `orchestration` (#2228): helper and connection tools, on when the agent's
 *   "Let this agent orchestrate" policy is on.
 */
export type ToolGroup = 'orchestration';

interface ToolGroupGate {
  isEnabled: (agentId: string) => boolean;
  refusal: string;
}

const toolGroupGates: Record<ToolGroup, ToolGroupGate> = {
  orchestration: { isEnabled: isOrchestrationEnabled, refusal: ORCHESTRATION_OFF_MESSAGE },
};

/** Whether a tool in `group` (or in no group) is available to an agent. */
function groupAllows(group: ToolGroup | undefined, agentId: string): boolean {
  return !group || toolGroupGates[group].isEnabled(agentId);
}

function groupRefusal(group: ToolGroup): McpToolResult {
  return { content: [{ type: 'text', text: toolGroupGates[group].refusal }], isError: true };
}

export interface ToolRegistrationOptions {
  /** Gate the tool behind a tool group. */
  group?: ToolGroup;
}

export interface ToolTemplate {
  nameSuffix: string;
  definition: Omit<McpToolDefinition, 'name'>;
  handler: (targetId: string, agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  group?: ToolGroup;
}

/**
 * Tool templates keyed by targetKind.
 * Each template generates tools for a specific bound target.
 */
const toolTemplates = new Map<BindingTargetKind, ToolTemplate[]>();

/**
 * Templates that belong to one target rather than to every target of a kind
 * (plugin tools: a binding to plugin X exposes only X's tools). Keyed by
 * targetKind, then targetId.
 */
const targetTemplates = new Map<BindingTargetKind, Map<string, ToolTemplate[]>>();

/** The templates a binding exposes: its target's own set if it has one, else its kind's. */
function templatesFor(binding: McpBinding): ToolTemplate[] | undefined {
  const scoped = targetTemplates.get(binding.targetKind);
  if (scoped) return scoped.get(binding.targetId);
  return toolTemplates.get(binding.targetKind);
}

/**
 * Replace the whole template set of one target. The swap is a single step,
 * so a caller that validates first never leaves a partial set behind.
 */
export function setTargetToolTemplates(targetKind: BindingTargetKind, targetId: string, templates: ToolTemplate[]): void {
  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.nameSuffix)) {
      throw new Error(`Duplicate tool template nameSuffix "${t.nameSuffix}" for ${targetKind} "${targetId}"`);
    }
    seen.add(t.nameSuffix);
  }
  let byTarget = targetTemplates.get(targetKind);
  if (!byTarget) {
    byTarget = new Map();
    targetTemplates.set(targetKind, byTarget);
  }
  byTarget.set(targetId, [...templates]);
  invalidateToolListCache();
}

/** Remove one target's template set. */
export function clearTargetToolTemplates(targetKind: BindingTargetKind, targetId: string): void {
  const byTarget = targetTemplates.get(targetKind);
  if (!byTarget?.delete(targetId)) return;
  invalidateToolListCache();
}

/**
 * Global tools — available to ALL agents regardless of bindings.
 * Used for core platform capabilities like canvas operations.
 */
const globalTools = new Map<string, {
  definition: McpToolDefinition;
  handler: (agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  group?: ToolGroup;
}>();

/** Maximum length for wire instruction strings before truncation. */
const WIRE_INSTRUCTION_MAX_LENGTH = 500;

/**
 * Patterns that could be used to inject system prompt overrides via wire instructions.
 * Matches common jailbreak / override sequences.
 */
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/gi,
  /<\s*system\s*>/gi,
  /<\/\s*system\s*>/gi,
  /\n{2,}[-=]{3,}/g,       // double-newline + horizontal rule (common delimiter attack)
  /\[\s*system\s*\]/gi,
  /\bACT\s+AS\b/gi,
  /\bDAN\b/gi,
  /\bJAILBREAK\b/gi,
];

/**
 * Sanitize a wire instruction string to prevent prompt injection.
 * Strips injection patterns and enforces a maximum length.
 */
export function sanitizeWireInstruction(instruction: string): string {
  let sanitized = instruction;
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[removed]');
  }
  if (sanitized.length > WIRE_INSTRUCTION_MAX_LENGTH) {
    sanitized = sanitized.slice(0, WIRE_INSTRUCTION_MAX_LENGTH);
  }
  return sanitized;
}

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
  options: ToolRegistrationOptions = {},
): void {
  let templates = toolTemplates.get(targetKind);
  if (!templates) {
    templates = [];
    toolTemplates.set(targetKind, templates);
  }
  if (templates.some(t => t.nameSuffix === nameSuffix)) {
    throw new Error(`Duplicate tool template nameSuffix "${nameSuffix}" for targetKind "${targetKind}"`);
  }
  templates.push({ nameSuffix, definition, handler, ...(options.group && { group: options.group }) });
}

/**
 * Unregister a specific tool template (reverse of registerToolTemplate).
 * Used when plugin tools are removed or re-registered.
 */
export function unregisterToolTemplate(targetKind: BindingTargetKind, nameSuffix: string): void {
  const templates = toolTemplates.get(targetKind);
  if (!templates) return;
  const idx = templates.findIndex(t => t.nameSuffix === nameSuffix);
  if (idx !== -1) {
    templates.splice(idx, 1);
    if (templates.length === 0) {
      toolTemplates.delete(targetKind);
    }
  }
}

/**
 * Register a global tool available to all agents (no binding required).
 * Used for core platform capabilities like canvas management.
 */
export function registerGlobalTool(
  name: string,
  definition: Omit<McpToolDefinition, 'name'>,
  handler: (agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>,
  options: ToolRegistrationOptions = {},
): void {
  globalTools.set(name, {
    definition: { ...definition, name },
    handler,
    ...(options.group && { group: options.group }),
  });
  invalidateToolListCache();
}

/** True if `name` is a registered global tool. */
export function isGlobalTool(name: string): boolean {
  return globalTools.has(name);
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
  if (binding.targetKind === 'group-project') {
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
    : binding.targetKind;
  return `${prefix}__${buildToolKey(binding)}__${suffix}`;
}

/** Parse a tool name back into its components. Returns null if format doesn't match. */
export function parseToolName(name: string): { prefix: string; toolKey: string; suffix: string } | null {
  const match = name.match(/^(clubhouse|browser|terminal|group)__([a-zA-Z0-9_]+)__([a-zA-Z_]+)$/);
  if (!match) return null;
  return { prefix: match[1], toolKey: match[2], suffix: match[3] };
}

// ── Tool list cache ─────────────────────────────────────────────────
// Caches getScopedToolList() results per agent. Uses the binding manager's
// internal version to detect when the cache is stale.

const toolListCache = new Map<string, { tools: McpToolDefinition[]; bindingVersion: number }>();

/** Invalidate all cached tool lists. */
export function invalidateToolListCache(): void {
  toolListCache.clear();
}

/**
 * Get the scoped tool list for an agent based on its current bindings.
 * Results are cached and invalidated when bindings change.
 */
export function getScopedToolList(agentId: string): McpToolDefinition[] {
  const currentVersion = bindingManager.getVersion();
  const cached = toolListCache.get(agentId);
  if (cached && cached.bindingVersion === currentVersion) {
    return cached.tools;
  }
  const bindings = bindingManager.getBindingsForAgent(agentId);
  const tools: McpToolDefinition[] = [];
  const seenNames = new Set<string>();

  for (const binding of bindings) {
    const templates = templatesFor(binding);
    if (!templates) continue;

    // When target agent is sleeping (not in registry), only expose status tools.
    const isTargetSleeping = binding.targetKind === 'agent' && !agentRegistry.get(binding.targetId);

    // For group projects, the project's admin role governs the privileged
    // toolset (admins get them, non-admins don't), combined with any per-wire
    // disables. For all other targets, only per-wire disables apply.
    const deniedTools = binding.targetKind === 'group-project'
      ? deniedGroupProjectTools(
          groupProjectRegistry.getSync(binding.targetId)?.metadata,
          binding.agentId,
          binding.disabledTools,
        )
      : new Set<string>(binding.disabledTools ?? []);

    for (const template of templates) {
      if (isTargetSleeping && template.nameSuffix !== 'get_status') {
        continue;
      }

      if (!groupAllows(template.group, agentId)) continue;

      // Skip tools disabled by role gating and/or at the wire level
      if (deniedTools.has(template.nameSuffix)) {
        continue;
      }

      let description = template.definition.description;

      // Inject per-wire custom instructions into tool description
      if (binding.instructions) {
        const specificInstruction = binding.instructions[template.nameSuffix];
        const globalInstruction = binding.instructions['*'];
        const raw = specificInstruction || globalInstruction;
        if (raw) {
          const safe = sanitizeWireInstruction(raw);
          description += `\n\n[WIRE INSTRUCTIONS — user-supplied]\n${safe}\n[END WIRE INSTRUCTIONS]`;
        }
      }

      // Two targets can build the same name (plugin ids 'a-b' and 'a_b'
      // sanitize alike): the first binding keeps it, as callTool resolves it.
      const name = buildToolName(binding, template.nameSuffix);
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      tools.push({
        ...template.definition,
        description,
        name,
      });
    }
  }

  // Append global tools (available regardless of bindings, unless gated by a group)
  for (const [, tool] of globalTools) {
    if (!groupAllows(tool.group, agentId)) continue;
    tools.push(tool.definition);
  }

  // Cache the result
  toolListCache.set(agentId, { tools, bindingVersion: currentVersion });

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
  // Check global tools first (no binding required)
  const globalTool = globalTools.get(toolName);
  if (globalTool) {
    // Checked at call time too: the client's tool list may be stale.
    if (globalTool.group && !groupAllows(globalTool.group, agentId)) {
      appLog('core:mcp', 'info', 'Tool call refused: tool group is off for this agent', {
        meta: { agentId, toolName, group: globalTool.group },
      });
      return groupRefusal(globalTool.group);
    }
    const schema = globalTool.definition.inputSchema;
    if (schema && typeof schema === 'object') {
      const required = (schema.required as string[]) || [];
      const properties = (schema.properties as Record<string, { type?: string }>) || {};
      for (const field of required) {
        if (args[field] === undefined || args[field] === null) {
          return { content: [{ type: 'text', text: `Missing required argument: ${field}` }], isError: true };
        }
      }
      for (const [key, value] of Object.entries(args)) {
        const propSchema = properties[key];
        if (propSchema?.type && !matchesJsonSchemaType(value, propSchema.type)) {
          return { content: [{ type: 'text', text: `Invalid type for argument "${key}": expected ${propSchema.type}, got ${typeof value}` }], isError: true };
        }
      }
    }
    return globalTool.handler(agentId, args);
  }

  const bindings = bindingManager.getBindingsForAgent(agentId);

  // A target with its own tool set (a plugin) names its tools
  // `<kind>__<key>__<tool>`, where the plugin picks <tool>: match the
  // binding's prefix rather than parsing, since <tool> may hold digits,
  // hyphens or '__'.
  const scopedMatch = matchScopedToolName(bindings, toolName);
  const parsed = scopedMatch?.parsed ?? parseToolName(toolName);
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
  const binding = scopedMatch?.binding ?? bindings.find(b => {
    if (targetTemplates.has(b.targetKind)) return false;
    const expectedPrefix = b.targetKind === 'agent' ? 'clubhouse'
      : b.targetKind === 'group-project' ? 'group'
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

  const templates = templatesFor(binding);
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

  if (template.group && !groupAllows(template.group, agentId)) {
    appLog('core:mcp', 'info', 'Tool call refused: tool group is off for this agent', {
      meta: { agentId, toolName, group: template.group },
    });
    return groupRefusal(template.group);
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
      if (propSchema?.type && !matchesJsonSchemaType(value, propSchema.type)) {
        return {
          content: [{ type: 'text', text: `Invalid type for argument "${key}": expected ${propSchema.type}, got ${typeof value}` }],
          isError: true,
        };
      }
    }
  }

  // Defense in depth: for group-project targets, verify the caller is authorized
  // to invoke this tool at call time, not just at listing time.
  if (binding.targetKind === 'group-project') {
    const project = await groupProjectRegistry.getSync(binding.targetId);
    const denied = deniedGroupProjectTools(project?.metadata, agentId, binding.disabledTools);
    if (denied.has(parsed.suffix)) {
      return {
        content: [{ type: 'text', text: 'Only a project admin can invoke this tool.' }],
        isError: true,
      };
    }
  }

  return template.handler(binding.targetId, agentId, args);
}

function matchScopedToolName(
  bindings: McpBinding[],
  toolName: string,
): { binding: McpBinding; parsed: { prefix: string; toolKey: string; suffix: string } } | null {
  for (const b of bindings) {
    if (!targetTemplates.has(b.targetKind)) continue;
    const toolKey = buildToolKey(b);
    const prefix = `${b.targetKind}__${toolKey}__`;
    // The target must have this tool: a prefix alone is ambiguous when one
    // target's key ends where another's begins ('acme' and 'acme__notes').
    const suffix = toolName.slice(prefix.length);
    if (toolName.startsWith(prefix) && templatesFor(b)?.some(t => t.nameSuffix === suffix)) {
      return { binding: b, parsed: { prefix: b.targetKind, toolKey, suffix } };
    }
  }
  return null;
}

// Admin membership lives in group-project metadata (not in bindingManager, so
// its version counter doesn't change). Refresh scoped tool lists whenever a
// group project changes so role-based gating takes effect immediately.
groupProjectRegistry.onChange(() => invalidateToolListCache());

// Tool groups are not bindings either: drop the agent's cached list when its
// orchestration gate flips. The bridge server sends tools/list_changed.
onOrchestrationGateChange((agentId) => { toolListCache.delete(agentId); });

/** For testing: clear all registered templates and global tools. */
export function _resetForTesting(): void {
  toolTemplates.clear();
  targetTemplates.clear();
  globalTools.clear();
  toolListCache.clear();
}
