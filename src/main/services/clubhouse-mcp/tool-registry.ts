/**
 * Tool Registry — manages tool definitions and generates scoped tool lists
 * based on an agent's current bindings.
 */

import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withSettingsSurface } from '../settings-audit';
import type { McpToolAnnotations, McpToolDefinition, McpToolResult, McpBinding, BindingTargetKind, ConnectionToolCatalog } from './types';
import { isToolGrantPassThrough, toolGrantDeclarations, type ToolGrant } from './tool-grants';
import type { GrantAction } from '../../../shared/agent-grants';
import type { GrantToolMap } from '../../../shared/agent-grant-changes';
import { bindingManager } from './binding-manager';
import { agentRegistry } from '../agent-registry';
import { groupProjectRegistry } from '../group-project-registry';
import { deniedGroupProjectTools } from '../../../shared/group-project-admin';
import { appLog } from '../log-service';
import { isCrossProjectEnabled, isOrchestrationEnabled, onOrchestrationGateChange } from './orchestration-gate';
import { dispatcherGateVersion, isDispatcherAgent, isDispatcherChatAgent, isDispatcherCoordinatorId, isTrackedDispatcher } from './dispatcher-gate';
import { mcpCallAccess, mcpCallerKind } from './mcp-call-gate';
import { CROSS_PROJECT_OFF_MESSAGE, MCP_CALLER_UNKNOWN_MESSAGE, ORCHESTRATION_OFF_MESSAGE } from '../../../shared/orchestration-policy';
import { callerGrants, checkToolGrant, isListable, type GrantCheck, type GrantCheckWire } from './grant-check';
import { askFirst } from './ask-first';
import { callKey, type ConsumedCallApproval } from '../grant-requests';
import { resolveArgTargets, type ArgTargets } from './arg-targets';
import { recordGrantDecision } from '../grant-telemetry';
import { recordDispatcherControl } from '../../telemetry/dispatcher-telemetry';
import { CONNECTION_TOOLS, WAKE_TOOL } from '../../../shared/connection-grants';
import { localConnectionWakeOn } from '../connection-grants-store';
import { localizeAgentArgs } from './agent-addresses';
import { forwardAgentCall, remoteMachineOf } from '../annex-agent-calls';
import { getProvider } from '../../orchestrators';

/** The refusal a Dispatcher tool returns for any other agent. */
export const DISPATCHER_ONLY_MESSAGE = 'Only the Dispatcher can use this tool.';
import type { McpRefusalReason } from '../../telemetry/agent-signals';

const approvedCall = new AsyncLocalStorage<{ key: string; approval?: ConsumedCallApproval }>();

/** Main-only local context, not a durable or forwardable authorization token. */
export function grantApprovalContext(agentId: string, toolName: string, args: Record<string, unknown>, grant: ToolGrant | undefined, targets: ArgTargets, wire?: GrantCheckWire): string {
  const caller = agentRegistry.get(agentId);
  return callKey(agentId, toolName, {
    args,
    caller: { projectPath: caller?.projectPath, orchestrator: caller?.orchestrator, runtime: caller?.runtime, access: caller?.launchAccess },
    policy: callerGrants(agentId), declarations: grant,
    targets: [...targets].map(([declaration, resolved]) => ({ declaration, resolved })),
    wire: wire && { targetId: wire.binding.targetId, targetKind: wire.binding.targetKind, metadata: wire.groupMetadata },
  });
}

/** A fresh refusal always wins; only this exact call's consumed user approval can cover Ask first. */
export function callGrantIsApproved(agentId: string, toolName: string, args: Record<string, unknown>, check: GrantCheck, context?: string): boolean {
  if (check.ok === true) return true;
  const current = approvedCall.getStore();
  const approval = current?.approval;
  return check.reason === 'ask_first' && current?.key === callKey(agentId, toolName, args)
    && !!context && approval?.scope.context === context
    && check.asks.every((ask) => approval.scope.asks.some((approved) => approved.action === ask.action && approved.where === ask.where));
}

/**
 * Whether the agent's CLI keeps the tool list it read at session start (#2603).
 * An agent that isn't tracked gets the listing of a CLI that refreshes.
 */
export function keepsFirstToolList(agentId: string): boolean {
  const orchestrator = agentRegistry.get(agentId)?.orchestrator;
  return !!orchestrator && !!getProvider(orchestrator)?.getCapabilities().ignoresToolListChanged;
}

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
 * - `crossProject` (#2512): tools that reach other projects (list_projects),
 *   on when orchestration and the agent's "Cross-project helpers" are both on.
 * - `dispatcher` (#2536): the Dispatcher's tools, on only for the running
 *   Dispatcher while it is turned on. The two groups above are never on for
 *   the Dispatcher, whatever its policy says.
 * - `dispatcherChat` (#3036): the tools of the Dispatcher's chat, on only for
 *   the running chat while the Dispatcher is turned on. Reading, and handing
 *   work to the Dispatcher; the chat never acts on agents itself.
 * - `fixedToolList` (#2603): the way to a wire added after the session started,
 *   on for agents whose CLI never re-reads its tool list.
 * - `actions` (#2952): the Actions tools, on for every agent that can own an
 *   action: not for quick agents, which end with their task, not for the
 *   Dispatcher while it is turned off, and never for its chat.
 * - `connections` (#3336): durable-agent connection management, never for the
 *   Dispatcher's read-only chat or quick agents. Grants decide each endpoint.
 * - `dispatcherConnected` (#3041): tools for agents connected to the
 *   Dispatcher (update_my_card), on while the agent has its wire to the
 *   Dispatcher. Also listed for agents whose CLI keeps its first tool list,
 *   which can't pick the tool up when they connect later; the tool itself
 *   refuses an agent that isn't connected. Never for the Dispatcher's agents.
 *
 * A tool may name several groups; it is available when any of them is on.
 */
export type ToolGroup = 'orchestration' | 'crossProject' | 'dispatcher' | 'dispatcherChat' | 'fixedToolList' | 'actions' | 'connections' | 'dispatcherConnected';

/**
 * Whether an agent has its wire to the Dispatcher. Set by the agent card tools
 * when they register (the check needs the Dispatcher's id, which this module
 * can't import); until then nobody is connected, so the group fails closed.
 */
let connectedToDispatcher: (agentId: string) => boolean = () => false;

export function setDispatcherConnectionCheck(check: ((agentId: string) => boolean) | null): void {
  connectedToDispatcher = check ?? (() => false);
}

/** One group, or several (any one of them opens the tool). */
export type ToolGroups = ToolGroup | readonly ToolGroup[];

interface ToolGroupGate {
  isEnabled: (agentId: string) => boolean;
  refusal: string;
}

const toolGroupGates: Record<ToolGroup, ToolGroupGate> = {
  orchestration: {
    isEnabled: (agentId) => !isTrackedDispatcher(agentId) && isOrchestrationEnabled(agentId),
    refusal: ORCHESTRATION_OFF_MESSAGE,
  },
  crossProject: {
    isEnabled: (agentId) => !isTrackedDispatcher(agentId) && isCrossProjectEnabled(agentId),
    refusal: CROSS_PROJECT_OFF_MESSAGE,
  },
  dispatcher: { isEnabled: isDispatcherAgent, refusal: DISPATCHER_ONLY_MESSAGE },
  dispatcherChat: { isEnabled: isDispatcherChatAgent, refusal: DISPATCHER_ONLY_MESSAGE },
  actions: {
    isEnabled: (agentId) => (isTrackedDispatcher(agentId) ? isDispatcherAgent(agentId) : mcpCallerKind(agentId) !== 'quick'),
    refusal: 'Actions aren’t available to you: quick agents can’t own actions, and the Dispatcher can’t use them while it is turned off.',
  },
  connections: {
    isEnabled: (agentId) => (isTrackedDispatcher(agentId) ? isDispatcherAgent(agentId) : mcpCallerKind(agentId) !== 'quick'),
    refusal: 'Connection management is only available to durable agents and the enabled Dispatcher.',
  },
  dispatcherConnected: {
    isEnabled: (agentId) => !isTrackedDispatcher(agentId) && (connectedToDispatcher(agentId) || keepsFirstToolList(agentId)),
    refusal: 'Only agents connected to the Dispatcher can use this tool.',
  },
  fixedToolList: {
    isEnabled: keepsFirstToolList,
    refusal: 'Your CLI refreshes its tool list, so call the wire\'s own tools instead.',
  },
};

function groupList(group: ToolGroups): readonly ToolGroup[] {
  return typeof group === 'string' ? [group] : group;
}

/** Whether a tool in `group` (or in no group) is available to an agent. */
function groupAllows(group: ToolGroups | undefined, agentId: string): boolean {
  return !group || groupList(group).some((g) => toolGroupGates[g].isEnabled(agentId));
}

/**
 * Results the registry refused before any handler ran, and why (#2308). Kept
 * beside the result rather than on it, so the reason never reaches the client.
 */
const refusals = new WeakMap<McpToolResult, McpRefusalReason>();

function refuse(reason: McpRefusalReason, text: string): McpToolResult {
  const result: McpToolResult = { content: [{ type: 'text', text }], isError: true };
  refusals.set(result, reason);
  return result;
}

/** Why `callTool` refused this result, or undefined when a handler produced it. */
export function refusalReasonOf(result: McpToolResult): McpRefusalReason | undefined {
  return refusals.get(result);
}

function groupRefusal(group: ToolGroups): McpToolResult {
  return refuse('group_off', toolGroupGates[groupList(group)[0]].refusal);
}

export interface ToolRegistrationOptions {
  /**
   * The grant actions a call needs and where its target comes from (#2967).
   * Required: a tool can't be registered without one. Declarations only for
   * now: nothing allows or refuses a call by it yet.
   */
  grant: ToolGrant;
  /** Gate the tool behind a tool group, or several. */
  group?: ToolGroups;
}

const INTERNAL_READ: Readonly<McpToolAnnotations> = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const INTERNAL_WRITE: Readonly<McpToolAnnotations> = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const INTERNAL_DESTRUCTIVE: Readonly<McpToolAnnotations> = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const OPEN_READ: Readonly<McpToolAnnotations> = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const OPEN_WRITE: Readonly<McpToolAnnotations> = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const OPEN_DESTRUCTIVE: Readonly<McpToolAnnotations> = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/**
 * Explicit effects, not grant actions or name heuristics. The inventory test
 * registers the startup catalog so an added tool needs an annotation review.
 * Mixed tools describe their most capable call, not just their preview path.
 */
const TOOL_ANNOTATIONS: Partial<Record<'global' | BindingTargetKind, Readonly<Record<string, Readonly<McpToolAnnotations>>>>> = {
  agent: {
    preview_provider: INTERNAL_READ,
    change_provider: INTERNAL_WRITE,
    send_message: INTERNAL_WRITE,
    get_status: INTERNAL_READ,
    read_output: INTERNAL_READ,
    check_connectivity: INTERNAL_READ,
    send_file: INTERNAL_WRITE,
    clear_agent: INTERNAL_DESTRUCTIVE,
    compact_agent: INTERNAL_DESTRUCTIVE,
    wake_agent: INTERNAL_WRITE,
    sleep_agent: INTERNAL_DESTRUCTIVE,
  },
  browser: {
    navigate: OPEN_DESTRUCTIVE,
    screenshot: OPEN_READ,
    get_console: OPEN_READ,
    click: OPEN_DESTRUCTIVE,
    type: OPEN_DESTRUCTIVE,
    evaluate: OPEN_DESTRUCTIVE,
    get_page_content: OPEN_READ,
    get_accessibility_tree: OPEN_READ,
  },
  'group-project': {
    list_members: INTERNAL_READ,
    post_bulletin: INTERNAL_WRITE,
    read_bulletin: INTERNAL_READ,
    read_topic: INTERNAL_READ,
    get_project_info: INTERNAL_READ,
    shoulder_tap: INTERNAL_WRITE,
    broadcast: INTERNAL_WRITE,
    wake_agent: INTERNAL_WRITE,
    sleep_agent: INTERNAL_DESTRUCTIVE,
    toggle_polling: INTERNAL_WRITE,
    query_polling: INTERNAL_READ,
    nudge_polling: INTERNAL_WRITE,
    read_message: INTERNAL_READ,
    clear_topic: INTERNAL_DESTRUCTIVE,
    clear_agent: INTERNAL_DESTRUCTIVE,
    compact_agent: INTERNAL_DESTRUCTIVE,
    delete_messages: INTERNAL_DESTRUCTIVE,
    set_project_info: INTERNAL_WRITE,
  },
  global: {
    // Can call browser/plugin tools or destructive wire tools, with their gates intact.
    call_wire_tool: OPEN_DESTRUCTIVE,
    notify_user: INTERNAL_WRITE,
    // hand_off records a receipt; only dispose_helper removes files and branches.
    hand_off: INTERNAL_WRITE,
    dispose_helper: INTERNAL_DESTRUCTIVE,
    start_helper: OPEN_WRITE,
    list_helpers: INTERNAL_READ,
    sleep_helper: INTERNAL_DESTRUCTIVE,
    wake_helper: INTERNAL_WRITE,
    list_projects: INTERNAL_READ,
    message_parent: INTERNAL_WRITE,
    // Live model/limit reads may contact a provider, even if a cached call does not.
    list_models: OPEN_READ,
    list_agents: INTERNAL_READ,
    inspect_helper: INTERNAL_READ,
    start_work: INTERNAL_DESTRUCTIVE,
    read_memory: INTERNAL_READ,
    write_memory: INTERNAL_WRITE,
    list_abilities: INTERNAL_READ,
    tell_user: INTERNAL_WRITE,
    search_memory: INTERNAL_READ,
    update_project: INTERNAL_WRITE,
    update_agent: INTERNAL_WRITE,
    list_settings: INTERNAL_READ,
    read_settings: INTERNAL_READ,
    set_orchestrator_helpers: INTERNAL_WRITE,
    connect_orchestrators: INTERNAL_WRITE,
    disconnect_orchestrators: INTERNAL_DESTRUCTIVE,
    set_connection_tools: INTERNAL_WRITE,
    list_connections: INTERNAL_READ,
    list_orchestrator_controls: INTERNAL_READ,
    list_agent_parts: INTERNAL_READ,
    get_agent_part: INTERNAL_READ,
    discover_agent_assets: INTERNAL_READ,
    import_agent_asset: INTERNAL_WRITE,
    create_agent_part: INTERNAL_WRITE,
    update_agent_part: INTERNAL_WRITE,
    fork_agent_part: INTERNAL_WRITE,
    delete_agent_part: INTERNAL_DESTRUCTIVE,
    get_agent_setup: INTERNAL_READ,
    get_agent_activation: INTERNAL_READ,
    set_agent_setup: INTERNAL_WRITE,
    switch_agent_to_managed: INTERNAL_WRITE,
    preview_agent_setup: INTERNAL_READ,
    list_agent_templates: INTERNAL_READ,
    save_agent_template: INTERNAL_WRITE,
    push_agent_template: INTERNAL_WRITE,
    delete_agent_template: INTERNAL_DESTRUCTIVE,
    create_managed_agent: INTERNAL_WRITE,
    restart_agent: INTERNAL_DESTRUCTIVE,
    delete_agent: INTERNAL_DESTRUCTIVE,
    answer_helper_question: INTERNAL_WRITE,
    create_group_project: INTERNAL_WRITE,
    add_to_group_project: INTERNAL_WRITE,
    remove_from_group_project: INTERNAL_DESTRUCTIVE,
    connect_agents: INTERNAL_WRITE,
    disconnect_agents: INTERNAL_DESTRUCTIVE,
    create_action: INTERNAL_WRITE,
    list_actions: INTERNAL_READ,
    update_action: INTERNAL_WRITE,
    delete_action: INTERNAL_DESTRUCTIVE,
    run_action: INTERNAL_DESTRUCTIVE,
    action_history: INTERNAL_READ,
    subscribe: INTERNAL_WRITE,
    read_helper_presets: OPEN_READ,
    set_helper_presets: OPEN_WRITE,
    request_grant: INTERNAL_WRITE,
    update_my_card: INTERNAL_WRITE,
    list_devices: INTERNAL_READ,
    rename_device: INTERNAL_WRITE,
    reconnect_device: INTERNAL_WRITE,
    remove_device: INTERNAL_DESTRUCTIVE,
    start_adding_device: INTERNAL_WRITE,
    add_project: INTERNAL_WRITE,
    preview_repository_import: OPEN_READ,
    import_repository: OPEN_WRITE,
    get_repository_import: INTERNAL_READ,
    cancel_repository_import: INTERNAL_WRITE,
    request_app_update: INTERNAL_WRITE,
    get_delivery: INTERNAL_READ,
    get_annex_network_settings: INTERNAL_READ,
    update_annex_network_settings: INTERNAL_WRITE,
  },
};

function annotatedDefinition(
  kind: 'global' | BindingTargetKind,
  name: string,
  definition: Omit<McpToolDefinition, 'name'>,
): Omit<McpToolDefinition, 'name'> {
  // Plugin behavior is unknown; never borrow a built-in's hints by matching its name.
  const catalog = TOOL_ANNOTATIONS[kind];
  const annotations = kind === 'plugin' ? OPEN_DESTRUCTIVE
    : catalog && Object.prototype.hasOwnProperty.call(catalog, name) ? catalog[name] : undefined;
  return annotations ? { ...definition, annotations: { ...annotations } } : definition;
}

export interface ToolTemplate {
  nameSuffix: string;
  definition: Omit<McpToolDefinition, 'name'>;
  handler: (targetId: string, agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /** What a call needs, as in {@link ToolRegistrationOptions.grant}. */
  grant: ToolGrant;
  group?: ToolGroups;
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
  byTarget.set(targetId, templates.map((t) => ({
    ...t,
    definition: annotatedDefinition(targetKind, t.nameSuffix, t.definition),
  })));
  invalidateToolListCache();
}

/** Remove one target's template set. */
export function clearTargetToolTemplates(targetKind: BindingTargetKind, targetId: string): void {
  const byTarget = targetTemplates.get(targetKind);
  if (!byTarget?.delete(targetId)) return;
  invalidateToolListCache();
}

/**
 * The only tools a sleeping agent target lists, and wake_agent is listed for
 * nothing else, unless the caller's CLI never re-reads its list: then every
 * tool is listed whatever the target's state, and the handlers answer a target
 * in the wrong state (#2603).
 */
const SLEEPING_TARGET_TOOLS: ReadonlySet<string> = new Set(['get_status', 'wake_agent', 'preview_provider', 'change_provider']);

/**
 * Whether an agent wire offers its sender wake_agent (#3215): the Dispatcher
 * as before, and any other agent only on a connection on this computer whose
 * Wake it switch is on (on for a new connection, #3214). Across machines it stays the
 * Dispatcher's (D232). The call's grant, agent.wake on that agent, is checked
 * after this, so Ask first and Off on the permissions page still apply.
 */
function wakeOffered(agentId: string, binding: McpBinding): boolean {
  if (isDispatcherAgent(agentId)) return true;
  return !remoteMachineOf(binding.targetId) && localConnectionWakeOn(agentId, binding.targetId);
}

/**
 * Whether `agentId` can call wake_agent on its wire to `targetId` now: the
 * wire offers it and a grant covers it (or it can ask). For hints that point
 * at wake_agent.
 */
export function canCallWake(agentId: string, targetId: string): boolean {
  const binding = bindingManager.getBindingsForAgent(agentId).find((b) => b.targetKind === 'agent' && b.targetId === targetId);
  const template = toolTemplates.get('agent')?.find((t) => t.nameSuffix === WAKE_TOOL);
  if (!binding || !template || binding.disabledTools?.includes(WAKE_TOOL) || !wakeOffered(agentId, binding)) return false;
  return isListable(checkToolGrant(agentId, template.grant, {}, wireOf(binding)));
}

/** wake_agent on an agent wire, which only some senders are offered. */
function isAgentWake(binding: McpBinding, suffix: string): boolean {
  return binding.targetKind === 'agent' && suffix === WAKE_TOOL;
}

const WAKE_OFF_MESSAGE = 'wake_agent isn\u2019t turned on for this connection. The user can turn on Wake it in the Connections card.';

/**
 * Global tools — available to ALL agents regardless of bindings.
 * Used for core platform capabilities like canvas operations.
 */
const globalTools = new Map<string, {
  definition: McpToolDefinition;
  handler: (agentId: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  grant?: ToolGrant;
  group?: ToolGroups;
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
  options: ToolRegistrationOptions,
): void {
  let templates = toolTemplates.get(targetKind);
  if (!templates) {
    templates = [];
    toolTemplates.set(targetKind, templates);
  }
  if (templates.some(t => t.nameSuffix === nameSuffix)) {
    throw new Error(`Duplicate tool template nameSuffix "${nameSuffix}" for targetKind "${targetKind}"`);
  }
  // `options?.`: test-only tools may register without options; real tools can't (typecheck, tool-grants.test).
  templates.push({
    nameSuffix, definition: annotatedDefinition(targetKind, nameSuffix, definition), handler,
    grant: options?.grant,
    ...(options?.group && { group: options.group }),
  });
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
  options: ToolRegistrationOptions,
): void {
  // `options?.`: test-only tools may register without options; real tools can't (typecheck, tool-grants.test).
  globalTools.set(name, {
    definition: { ...annotatedDefinition('global', name, definition), name },
    handler,
    ...(options?.grant && { grant: options.grant }),
    ...(options?.group && { group: options.group }),
  });
  invalidateToolListCache();
}

/** One registered tool and its grant declaration, for the declaration table and the evaluator. */
export interface RegisteredToolGrant {
  /** 'global', or the target kind of a template. */
  kind: 'global' | BindingTargetKind;
  /** The global tool's name, or the template's name suffix. */
  name: string;
  /** Undefined only for a tool registered without one (tests). */
  grant: ToolGrant | undefined;
  /** The tool group gating it, if any. */
  group?: ToolGroups;
  /** Effect hints, independent of the grant and group enforcing authorization. */
  annotations?: McpToolAnnotations;
}

/**
 * Every registered global tool and tool template with its grant declaration
 * (#2967), templates first by target kind. Target-scoped templates (plugins)
 * are listed under their kind once per target.
 */
export function listToolGrants(): RegisteredToolGrant[] {
  const out: RegisteredToolGrant[] = [];
  for (const [kind, templates] of toolTemplates) {
    for (const t of templates) out.push({ kind, name: t.nameSuffix, grant: t.grant, ...(t.group && { group: t.group }), ...(t.definition.annotations && { annotations: { ...t.definition.annotations } }) });
  }
  for (const [kind, byTarget] of targetTemplates) {
    for (const [, templates] of byTarget) {
      for (const t of templates) out.push({ kind, name: t.nameSuffix, grant: t.grant, ...(t.definition.annotations && { annotations: { ...t.definition.annotations } }) });
    }
  }
  for (const [name, tool] of globalTools) out.push({ kind: 'global', name, grant: tool.grant, ...(tool.group && { group: tool.group }), ...(tool.definition.annotations && { annotations: { ...tool.definition.annotations } }) });
  return out;
}

/** Read-only help for the permissions page, derived from the declarations used at runtime. */
export function grantToolMap(): GrantToolMap {
  const tools: GrantToolMap = {};
  for (const { name, grant } of listToolGrants()) {
    if (!grant) continue;
    for (const declaration of toolGrantDeclarations(grant)) {
      for (const action of declaration.actions) {
        const names = tools[action] ??= [];
        if (!names.includes(name)) names.push(name);
      }
    }
  }
  for (const names of Object.values(tools)) names.sort();
  return tools;
}

/** The groups whose tools the Dispatcher can call, through its controller or its chat, as toolGroupGates opens them. */
const DISPATCHER_TOOL_GROUPS: ReadonlySet<ToolGroup> = new Set(['dispatcher', 'dispatcherChat', 'actions']);

/**
 * The grant actions a registered tool lets the running Dispatcher use (#3238):
 * global tools in no group or in one of its groups, and the tools on its wires
 * to agents. A grant no tool uses does nothing, so it isn't offered as an ability.
 */
export function dispatcherToolActions(): Set<GrantAction> {
  const out = new Set<GrantAction>();
  const add = (grant: ToolGrant | undefined, group: ToolGroups | undefined) => {
    if (!grant || isToolGrantPassThrough(grant)) return;
    if (group && !groupList(group).some((g) => DISPATCHER_TOOL_GROUPS.has(g))) return;
    for (const d of toolGrantDeclarations(grant)) for (const action of d.actions) out.add(action);
  };
  for (const t of toolTemplates.get('agent') ?? []) add(t.grant, t.group);
  for (const [, tool] of globalTools) add(tool.grant, tool.group);
  return out;
}

/** Part of the cache key: which agents are the Dispatcher, since a wire to it lists no reset tools (#2968). */
function conditionsKey(): string {
  return `d${dispatcherGateVersion()}`;
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
// internal version, plus which agent targets are awake, to detect when the
// cache is stale.

const toolListCache = new Map<string, { tools: McpToolDefinition[]; bindingVersion: number; wakeKey: string; conditionsKey: string }>();

/** Invalidate all cached tool lists. */
export function invalidateToolListCache(): void {
  toolListCache.clear();
}

/**
 * The agents wired to the agent `targetId`. That target starting or stopping
 * changes their tool lists (a sleeping target exposes only get_status) without
 * changing any binding (#2564).
 */
export function agentsWiredTo(targetId: string): string[] {
  const agentIds = new Set<string>();
  for (const binding of bindingManager.getAllBindings()) {
    if (binding.targetKind === 'agent' && binding.targetId === targetId) agentIds.add(binding.agentId);
  }
  return [...agentIds];
}

/** Which agent targets are awake, one character per binding: part of the cache key (#2564). */
function wakeKey(bindings: McpBinding[]): string {
  return bindings.map((b) => (b.targetKind !== 'agent' ? '-' : agentRegistry.get(b.targetId) ? '1' : '0')).join('');
}

function templateListable(
  binding: McpBinding,
  template: ToolTemplate,
  deniedTools: ReadonlySet<string>,
  wire = wireOf(binding),
): boolean {
  return groupAllows(template.group, binding.agentId)
    && !deniedTools.has(template.nameSuffix)
    && isListable(checkToolGrant(binding.agentId, template.grant, {}, wire));
}

/**
 * Stable direction-editor choices from registered templates. Direction switches
 * and transient target/session state are separate from role/group/grant eligibility.
 */
export function getConnectionToolCatalog(
  agentId: string,
  targetId: string,
  targetKind: BindingTargetKind,
): ConnectionToolCatalog {
  const binding: McpBinding = { agentId, targetId, targetKind, label: targetId };
  const templates = templatesFor(binding);
  if (!templates || (targetKind === 'plugin' && !targetTemplates.get('plugin')?.has(targetId))) {
    return { state: 'unavailable', reason: 'tools_not_registered', tools: [] };
  }
  const deniedTools = targetKind === 'group-project'
    ? deniedGroupProjectTools(groupProjectRegistry.getSync(targetId)?.metadata, agentId)
    : new Set<string>();
  const wire: GrantCheckWire = { ...wireOf(binding), wakeOn: true };
  return {
    state: 'available',
    tools: templates.map((template) => ({
      suffix: template.nameSuffix,
      description: template.definition.description,
      available: templateListable(binding, template, deniedTools, wire),
    })),
  };
}

/**
 * Get the scoped tool list for an agent based on its current bindings.
 * Results are cached and invalidated when bindings change or a target wakes or sleeps.
 * A target's state doesn't change the list of a CLI that keeps its first one.
 */
export function getScopedToolList(agentId: string): McpToolDefinition[] {
  const access = mcpCallAccess(agentId, agentRegistry.get(agentId)?.projectPath);
  if (access === 'closed') return [];
  const currentVersion = bindingManager.getVersion();
  const bindings = bindingManager.getBindingsForAgent(agentId);
  const allWireTools = keepsFirstToolList(agentId);
  const currentWakeKey = allWireTools ? 'all' : wakeKey(bindings);
  const currentConditions = conditionsKey();
  const cached = toolListCache.get(agentId);
  if (cached && cached.bindingVersion === currentVersion && cached.wakeKey === currentWakeKey && cached.conditionsKey === currentConditions) {
    return cached.tools;
  }
  const tools: McpToolDefinition[] = [];
  const seenNames = new Set<string>();

  for (const binding of bindings) {
    const templates = templatesFor(binding);
    if (!templates) continue;

    // When target agent is sleeping (not in registry), only expose status and wake tools.
    // An agent on another machine is never in this registry: its machine knows its state and answers for it (#3064).
    const followsTargetState = binding.targetKind === 'agent' && !allWireTools && !remoteMachineOf(binding.targetId);
    const isTargetSleeping = followsTargetState && !agentRegistry.get(binding.targetId);
    // A sleeping Dispatcher still takes messages: send_message delivers and wakes it (#3069, #3108).
    const sleepingDispatcher = isTargetSleeping && isDispatcherCoordinatorId(binding.targetId);

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
      if (isTargetSleeping && !SLEEPING_TARGET_TOOLS.has(template.nameSuffix) && !(sleepingDispatcher && template.nameSuffix === 'send_message')) {
        continue;
      }
      if (followsTargetState && !isTargetSleeping && template.nameSuffix === 'wake_agent') {
        continue;
      }

      if (!templateListable(binding, template, deniedTools)) continue;
      if (isAgentWake(binding, template.nameSuffix) && !wakeOffered(agentId, binding)) continue;

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
    if (!isListable(checkToolGrant(agentId, tool.grant, {}))) continue;
    tools.push(tool.definition);
  }

  // Cache the result
  toolListCache.set(agentId, { tools, bindingVersion: currentVersion, wakeKey: currentWakeKey, conditionsKey: currentConditions });

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
  // Before everything else: a caller the gate doesn't know reaches no tool, whatever list the client holds.
  const access = mcpCallAccess(agentId, agentRegistry.get(agentId)?.projectPath);
  if (access === 'closed') return refuse('caller_unknown', MCP_CALLER_UNKNOWN_MESSAGE);

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
          return refuse('invalid_args', `Missing required argument: ${field}`);
        }
      }
      for (const [key, value] of Object.entries(args)) {
        const propSchema = properties[key];
        if (propSchema?.type && !matchesJsonSchemaType(value, propSchema.type)) {
          return refuse('invalid_args', `Invalid type for argument "${key}": expected ${propSchema.type}, got ${typeof value}`);
        }
      }
    }
    // An agent named with this machine's address is the bare id from here on; another machine's is refused (#3063).
    const localized = localizeAgentArgs(globalTool.grant, args);
    if ('message' in localized) return refuse('other_machine', localized.message);
    args = localized.args;
    // After the argument checks, as for wire tools: the user is never asked about a call that would fail on its arguments.
    const targets = await resolveArgTargets(agentId, globalTool.grant, args);
    const granted = checkToolGrant(agentId, globalTool.grant, args, undefined, targets);
    let approval: ConsumedCallApproval | undefined;
    if (granted.ok === false) {
      const outcome = await grantRefusal(agentId, toolName, granted, args, grantApprovalContext(agentId, toolName, args, globalTool.grant, targets));
      if ('refusal' in outcome) return outcome.refusal;
      approval = outcome.approval;
    }
    return approvedCall.run({
      key: callKey(agentId, toolName, args),
      approval,
    }, () => withSettingsSurface('mcp', agentId, () => globalTool.handler(agentId, args)));
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
    return refuse('unparseable', `Unknown tool: ${toolName}`);
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
    return refuse('no_binding', `No binding found for target: ${parsed.toolKey}`);
  }

  const templates = templatesFor(binding);
  if (!templates) {
    return refuse('unknown_tool', `No tools registered for kind: ${binding.targetKind}`);
  }

  const template = templates.find(t => t.nameSuffix === parsed.suffix);
  if (!template) {
    return refuse('unknown_tool', `Unknown tool action: ${parsed.suffix}`);
  }

  if (template.group && !groupAllows(template.group, agentId)) {
    appLog('core:mcp', 'info', 'Tool call refused: tool group is off for this agent', {
      meta: { agentId, toolName, group: template.group },
    });
    return groupRefusal(template.group);
  }

  if (isAgentWake(binding, parsed.suffix) && !wakeOffered(agentId, binding)) {
    recordGrantDecision({ agentId, toolName, decision: 'refused', reason: 'no_grant', actions: ['agent.wake'], targetKind: 'connection' });
    // Across machines wake stays the Dispatcher's (D232): no switch here opens it.
    return refuse('tool_denied', remoteMachineOf(binding.targetId) ? 'Only the Dispatcher can wake an agent on another computer.' : WAKE_OFF_MESSAGE);
  }

  // Checked at call time too: the listing drops these, but a client may have a stale list or know the name.
  if (binding.disabledTools?.includes(parsed.suffix)) {
    // A connection's permissions (D129) refused it: recorded like any grant refusal (#2973).
    if (binding.targetKind === 'agent') {
      const action = CONNECTION_TOOLS.find((t) => t.tool === parsed.suffix)?.action;
      recordGrantDecision({ agentId, toolName, decision: 'refused', reason: 'no_grant', actions: action ? [action] : [], targetKind: 'connection' });
    }
    return refuse('tool_denied', `${parsed.suffix} is turned off on this wire.`);
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
        return refuse('invalid_args', `Missing required argument: ${field}`);
      }
    }

    // Check types of provided fields
    for (const [key, value] of Object.entries(args)) {
      const propSchema = properties[key];
      if (propSchema?.type && !matchesJsonSchemaType(value, propSchema.type)) {
        return refuse('invalid_args', `Invalid type for argument "${key}": expected ${propSchema.type}, got ${typeof value}`);
      }
    }
  }

  // Defense in depth: for group-project targets, verify the caller is authorized
  // to invoke this tool at call time, not just at listing time. A tool switched
  // off on this wire was refused above already, so only the admin rule is left (#3176).
  if (binding.targetKind === 'group-project') {
    const project = await groupProjectRegistry.getSync(binding.targetId);
    if (deniedGroupProjectTools(project?.metadata, agentId).has(parsed.suffix)) {
      return refuse('tool_denied', 'Only a project admin can invoke this tool.');
    }
  }

  const localized = localizeAgentArgs(template.grant, args);
  if ('message' in localized) return refuse('other_machine', localized.message);
  args = localized.args;
  const targets = await resolveArgTargets(agentId, template.grant, args);
  const granted = checkToolGrant(agentId, template.grant, args, wireOf(binding), targets);
  if (granted.ok === false) {
    const outcome = await grantRefusal(agentId, toolName, granted, args, grantApprovalContext(agentId, toolName, args, template.grant, targets, wireOf(binding)));
    if ('refusal' in outcome) return outcome.refusal;
  }

  // A wire to an agent on another machine runs there, which checks it again against its own store (#3064).
  if (binding.targetKind === 'agent' && remoteMachineOf(binding.targetId)) {
    return forwardAgentCall(agentId, binding.targetId, binding.targetName || binding.label || 'That agent', parsed.suffix, args);
  }

  return withSettingsSurface('mcp', agentId, () => template.handler(binding.targetId, agentId, args));
}

/**
 * Runs one of this machine's agent wire tools for a caller on another machine
 * (#3064), once that machine and this one have both checked the call. The
 * caller has no binding here; the tool reads who it is from the call context.
 */
export async function runAgentToolForRemoteCaller(tool: string, targetId: string, callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const template = toolTemplates.get('agent')?.find((t) => t.nameSuffix === tool);
  if (!template) return refuse('unknown_tool', `Unknown tool action: ${tool}`);
  const schema = template.definition.inputSchema as Record<string, unknown> | undefined;
  const required = (schema?.required as string[]) || [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null) return refuse('invalid_args', `Missing required argument: ${field}`);
  }
  const properties = (schema?.properties as Record<string, { type?: string }>) || {};
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (propSchema?.type && !matchesJsonSchemaType(value, propSchema.type)) {
      return refuse('invalid_args', `Invalid type for argument "${key}": expected ${propSchema.type}, got ${typeof value}`);
    }
  }
  return withSettingsSurface('mcp', callerId, () => template.handler(targetId, callerId, args));
}

/** What the grant check needs about a wire. */
function wireOf(binding: McpBinding): GrantCheckWire {
  return {
    binding,
    ...(binding.targetKind === 'group-project' && { groupMetadata: groupProjectRegistry.getSync(binding.targetId)?.metadata }),
  };
}

/**
 * A call no grant covers (#2968), or one the user is asked about first
 * (#2970). An approval retains the user's original scope; a refusal never
 * says whether the target exists.
 */
async function grantRefusal(agentId: string, toolName: string, check: Extract<GrantCheck, { ok: false }>, args: Record<string, unknown>, context: string): Promise<{ refusal: McpToolResult } | { approval: ConsumedCallApproval }> {
  if (check.reason === 'ask_first') {
    const outcome = await askFirst(agentId, toolName, args, check.asks, context);
    if (outcome.kind === 'approved') return { approval: outcome.approval };
    // Only a new request is recorded: a retry while it waits, or a request that couldn't be placed, isn't an ask.
    if (outcome.created) recordGrantDecision({ agentId, toolName, decision: 'asked', reason: 'ask_first', actions: [...new Set(check.asks.map((a) => a.action))] });
    return { refusal: refuse('ask_first', outcome.text) };
  }
  appLog('core:mcp', 'info', 'Tool call refused: no Clubhouse permission covers it', { meta: { agentId, toolName, reason: check.reason } });
  recordGrantDecision({ agentId, toolName, decision: 'refused', reason: check.reason, actions: check.action ? [check.action] : [], ...(check.targetKind && { targetKind: check.targetKind }) });
  if (toolName === 'create_managed_agent' && args.connectToDispatcher === true) {
    const receiptId = randomUUID();
    const recorded = recordDispatcherControl({ tool: toolName, actorId: agentId, targets: [], requested: { receiptId }, outcome: 'refused', code: check.reason });
    return { refusal: refuse('no_grant', JSON.stringify({
      status: 'refused', connectedToDispatcher: false, receipt: { id: receiptId, outcome: 'refused' }, error: check.message,
      ...(!recorded && { audit_warning: 'Local telemetry recording is off, so this is not in the audit record.' }),
    })) };
  }
  return { refusal: refuse('no_grant', check.message) };
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
// orchestration or crossProject gate flips. The bridge server sends tools/list_changed.
onOrchestrationGateChange((agentId) => { toolListCache.delete(agentId); });

/** For testing: clear all registered templates and global tools. */
export function _resetForTesting(): void {
  connectedToDispatcher = () => false;
  toolTemplates.clear();
  targetTemplates.clear();
  globalTools.clear();
  toolListCache.clear();
}
