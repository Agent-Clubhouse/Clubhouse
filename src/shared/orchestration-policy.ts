import type { FreeAgentPermissionMode, HelperCascadeResult } from './types';
import type { PermissionLevel } from './chat/capabilities';

/**
 * Orchestration policy (#2228): whether an agent may start and manage helper
 * agents, what access its helpers get, how much the user is asked, and how
 * many helpers it may run. Pure types and functions shared by main and
 * renderer; the main side lives in services/orchestration-policy.ts.
 */

/**
 * The launch access an agent runs with, lowest first:
 * - `standard`: Free Agent Mode off, the CLI asks for permissions.
 * - `auto`: Free Agent Mode on with the `auto` permission mode.
 * - `bypass`: Free Agent Mode on with `skip-all` (no permission prompts).
 */
export type AgentAccessLevel = 'standard' | 'auto' | 'bypass';

export const ACCESS_LEVELS: readonly AgentAccessLevel[] = ['standard', 'auto', 'bypass'];

/**
 * A helper's access: `same` as the orchestrator (the default, including
 * bypass), or a fixed level. A fixed level is a ceiling request only; the
 * helper never gets more than its orchestrator has at start time.
 */
export type OrchestrationAccess = 'same' | AgentAccessLevel;

/**
 * How much the user is asked:
 * - `hands-off` (default): no approvals; the orchestrator may still ask.
 * - `ask-before-start`: helper starts wait for a batched approval.
 * - `ask-everything`: starts and every dispose come to the user.
 */
export type OrchestrationControl = 'hands-off' | 'ask-before-start' | 'ask-everything';

export const ORCHESTRATION_CONTROLS: readonly OrchestrationControl[] = ['hands-off', 'ask-before-start', 'ask-everything'];

export interface OrchestrationPolicy {
  /** "Let this agent orchestrate": exposes the orchestration MCP tools. */
  orchestrate: boolean;
  access: OrchestrationAccess;
  control: OrchestrationControl;
  /** Live helpers this agent may have at once. */
  maxHelpers: number;
  /** "Cross-project helpers" (#2512): may start helpers in other registered projects. */
  crossProjectHelpers: boolean;
  /**
   * "Connect to Dispatcher" (#2534): the Dispatcher may message this agent and
   * get its reports. Independent of `orchestrate`, which only supplies its
   * default (#2578), and always false on a helper: see resolveOrchestrationPolicy.
   */
  connectToDispatcher: boolean;
}

/**
 * What is stored on DurableAgentConfig.orchestration and in persona
 * front-matter: only the fields set explicitly. Unset fields fall back to the
 * persona's front-matter, then to ORCHESTRATION_DEFAULTS.
 */
export type OrchestrationPolicyConfig = Partial<OrchestrationPolicy>;

export const DEFAULT_MAX_HELPERS = 5;
/** Default app-wide cap on live helpers across every orchestrator. */
export const DEFAULT_GLOBAL_HELPER_CAP = 20;
/** Upper bound accepted for either limit, so a typo can't mean "unlimited". */
export const MAX_HELPER_LIMIT = 100;

/** The most helpers one agent may have: the app cap, and never above the hard limit. */
export function maxHelpersCeiling(globalCap: number): number {
  return Math.max(1, Math.min(MAX_HELPER_LIMIT, globalCap));
}

export const ORCHESTRATION_DEFAULTS: Readonly<OrchestrationPolicy> = Object.freeze({
  orchestrate: false,
  access: 'same',
  control: 'hands-off',
  maxHelpers: DEFAULT_MAX_HELPERS,
  crossProjectHelpers: false,
  connectToDispatcher: false,
});

/** The refusal an orchestration tool returns for an agent with orchestration off. */
export const ORCHESTRATION_OFF_MESSAGE = 'Orchestration is turned off for this agent.';

/** The refusal a cross-project tool returns for an agent with cross-project helpers off. */
export const CROSS_PROJECT_OFF_MESSAGE = 'Cross-project helpers are turned off for this agent.';

/** The refusal for turning orchestration or the Dispatcher connection on where Clubhouse MCP is off (#2589). */
export const MCP_REQUIRED_MESSAGE = 'This needs Clubhouse MCP, which is off for this agent. Turn it on first.';

/** Where each field of a resolved policy came from. */
export type OrchestrationPolicySource = 'agent' | 'persona' | 'default';

/** The switches that need Clubhouse MCP (#2589). */
export type McpDependentSwitches = Pick<OrchestrationPolicy, 'orchestrate' | 'crossProjectHelpers' | 'connectToDispatcher'>;

export interface ResolvedOrchestrationPolicy extends OrchestrationPolicy {
  sources: Record<keyof OrchestrationPolicy, OrchestrationPolicySource>;
  /**
   * Set only while Clubhouse MCP is off for this agent (#2589). The switches
   * above then read false, and this holds what they resolve to from the saved
   * settings, which come back when MCP does.
   */
  mcpOff?: McpDependentSwitches;
}

/** What `orchestrate` resolves to from the saved settings, MCP on or off. */
export function savedOrchestrate(policy: Pick<ResolvedOrchestrationPolicy, 'orchestrate' | 'mcpOff'>): boolean {
  return policy.mcpOff ? policy.mcpOff.orchestrate : policy.orchestrate;
}

/** Whether a patch sets one of the switches that need Clubhouse MCP to on. Clearing or turning off never does. */
export function patchTurnsOnMcpSwitch(patch: { [K in keyof McpDependentSwitches]?: boolean | null }): boolean {
  return patch.orchestrate === true || patch.crossProjectHelpers === true || patch.connectToDispatcher === true;
}

function isAccess(value: unknown): value is OrchestrationAccess {
  return value === 'same' || (ACCESS_LEVELS as readonly unknown[]).includes(value);
}

function isControl(value: unknown): value is OrchestrationControl {
  return (ORCHESTRATION_CONTROLS as readonly unknown[]).includes(value);
}

function isLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_HELPER_LIMIT;
}

/**
 * Keep only the valid fields of a stored or front-matter policy. Returns
 * undefined when nothing valid is left. Never throws.
 */
export function normalizeOrchestrationConfig(raw: unknown): OrchestrationPolicyConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: OrchestrationPolicyConfig = {};
  if (typeof r.orchestrate === 'boolean') out.orchestrate = r.orchestrate;
  if (isAccess(r.access)) out.access = r.access;
  if (isControl(r.control)) out.control = r.control;
  if (isLimit(r.maxHelpers)) out.maxHelpers = r.maxHelpers;
  if (typeof r.crossProjectHelpers === 'boolean') out.crossProjectHelpers = r.crossProjectHelpers;
  if (typeof r.connectToDispatcher === 'boolean') out.connectToDispatcher = r.connectToDispatcher;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a policy patch from IPC or a tool. Unlike normalize, an invalid
 * field is an error, so a bad request never half-applies. `null` for a field
 * clears it back to the persona or default value.
 */
export function validateOrchestrationPatch(raw: unknown): { [K in keyof OrchestrationPolicy]?: OrchestrationPolicy[K] | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Orchestration policy must be an object');
  const r = raw as Record<string, unknown>;
  const out: { [K in keyof OrchestrationPolicy]?: OrchestrationPolicy[K] | null } = {};
  for (const [key, value] of Object.entries(r)) {
    if (value === undefined) continue;
    switch (key) {
      case 'orchestrate':
        if (value !== null && typeof value !== 'boolean') throw new Error('orchestrate must be a boolean');
        out.orchestrate = value as boolean | null;
        break;
      case 'access':
        if (value !== null && !isAccess(value)) throw new Error(`access must be one of same, ${ACCESS_LEVELS.join(', ')}`);
        out.access = value as OrchestrationAccess | null;
        break;
      case 'control':
        if (value !== null && !isControl(value)) throw new Error(`control must be one of ${ORCHESTRATION_CONTROLS.join(', ')}`);
        out.control = value as OrchestrationControl | null;
        break;
      case 'maxHelpers':
        if (value !== null && !isLimit(value)) throw new Error(`maxHelpers must be a whole number from 1 to ${MAX_HELPER_LIMIT}`);
        out.maxHelpers = value as number | null;
        break;
      case 'crossProjectHelpers':
        if (value !== null && typeof value !== 'boolean') throw new Error('crossProjectHelpers must be a boolean');
        out.crossProjectHelpers = value as boolean | null;
        break;
      case 'connectToDispatcher':
        if (value !== null && typeof value !== 'boolean') throw new Error('connectToDispatcher must be a boolean');
        out.connectToDispatcher = value as boolean | null;
        break;
      default:
        throw new Error(`Unknown orchestration policy field: ${key}`);
    }
  }
  return out;
}

/** Apply a validated patch to a stored config. Returns undefined when nothing is left set. */
export function applyOrchestrationPatch(
  stored: OrchestrationPolicyConfig | undefined,
  patch: ReturnType<typeof validateOrchestrationPatch>,
): OrchestrationPolicyConfig | undefined {
  const next: Record<string, unknown> = { ...(stored ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return normalizeOrchestrationConfig(next);
}

/**
 * Layer a policy: the agent's own fields, then its persona's front-matter,
 * then ORCHESTRATION_DEFAULTS.
 *
 * An unset `connectToDispatcher` follows the resolved `orchestrate` (#2578),
 * with `default` as its source, so agents that orchestrate connect without a
 * bulk write.
 *
 * A helper talks only to its parent, so with `helper` it is always false,
 * whatever the agent or persona says. Its source is `default` then, since no
 * stored value is in effect.
 *
 * No Clubhouse MCP, no orchestration (#2589): with `mcpOff`, `orchestrate`,
 * `crossProjectHelpers` and `connectToDispatcher` read false and `mcpOff` holds
 * what they would otherwise be. Sources still describe the saved settings,
 * which stay in place and can still be cleared.
 */
export function resolveOrchestrationPolicy(
  agentConfig: OrchestrationPolicyConfig | undefined,
  personaDefaults: OrchestrationPolicyConfig | undefined,
  options: { helper?: boolean; mcpOff?: boolean } = {},
): ResolvedOrchestrationPolicy {
  const agent = normalizeOrchestrationConfig(agentConfig) ?? {};
  const persona = normalizeOrchestrationConfig(personaDefaults) ?? {};
  const keys = Object.keys(ORCHESTRATION_DEFAULTS) as Array<keyof OrchestrationPolicy>;
  const policy = { ...ORCHESTRATION_DEFAULTS } as OrchestrationPolicy;
  const sources = {} as ResolvedOrchestrationPolicy['sources'];
  for (const key of keys) {
    if (agent[key] !== undefined) {
      (policy as unknown as Record<string, unknown>)[key] = agent[key];
      sources[key] = 'agent';
    } else if (persona[key] !== undefined) {
      (policy as unknown as Record<string, unknown>)[key] = persona[key];
      sources[key] = 'persona';
    } else {
      sources[key] = 'default';
    }
  }
  if (options.helper) {
    policy.connectToDispatcher = false;
    sources.connectToDispatcher = 'default';
  } else if (sources.connectToDispatcher === 'default') {
    policy.connectToDispatcher = policy.orchestrate;
  }
  if (options.mcpOff) {
    const { orchestrate, crossProjectHelpers, connectToDispatcher } = policy;
    return {
      ...policy, orchestrate: false, crossProjectHelpers: false, connectToDispatcher: false, sources,
      mcpOff: { orchestrate, crossProjectHelpers, connectToDispatcher },
    };
  }
  return { ...policy, sources };
}

// ── Access ───────────────────────────────────────────────────────────────

/** The launch settings an agent starts or runs with, as spawnAgent takes them. */
export interface AgentLaunchAccess {
  freeAgentMode: boolean;
  /**
   * Always set on settings Clubhouse produces for a helper, even with Free
   * Agent Mode off: an unset mode is filled from project settings at spawn,
   * and some providers read it without Free Agent Mode (Copilot adds
   * --allow-all-tools for skip-all).
   */
  permissionMode: FreeAgentPermissionMode;
}

/**
 * The access level of a running agent's launch settings. Anything not known
 * to be higher reads as standard: Free Agent Mode with no recorded mode is
 * standard, never bypass.
 */
export function accessLevelOf(launch: { freeAgentMode?: boolean; permissionMode?: FreeAgentPermissionMode } | undefined): AgentAccessLevel {
  if (!launch?.freeAgentMode) return 'standard';
  if (launch.permissionMode === 'skip-all') return 'bypass';
  if (launch.permissionMode === 'auto') return 'auto';
  return 'standard';
}

/** The launch settings for an access level, with the permission mode pinned. */
export function launchAccessFor(level: AgentAccessLevel): AgentLaunchAccess {
  switch (level) {
    case 'standard': return { freeAgentMode: false, permissionMode: 'auto' };
    case 'auto': return { freeAgentMode: true, permissionMode: 'auto' };
    case 'bypass': return { freeAgentMode: true, permissionMode: 'skip-all' };
  }
}

/**
 * The access a provider's real launch flags give for these settings, in
 * terminal and chat. Checked against the provider mappings:
 * - claude-code: FAM off, no flags; auto, --permission-mode auto (chat
 *   `auto`); skip-all, --dangerously-skip-permissions (chat
 *   bypassPermissions).
 * - codex-cli: FAM off, no flags; auto, workspace-write sandbox with no
 *   approvals; skip-all, --dangerously-bypass-approvals-and-sandbox.
 * - copilot-cli: any FAM adds --yolo --autopilot (allow everything), and
 *   skip-all adds --allow-all-tools even with FAM off. Over ACP there is no
 *   `auto` level, only ask and allow-all. So FAM ranks as bypass, and
 *   skip-all without FAM as auto.
 * An unknown provider is ranked like Copilot, the most permissive mapping.
 */
export function providerAccessLevel(
  providerId: string | undefined,
  launch: { freeAgentMode?: boolean; permissionMode?: FreeAgentPermissionMode },
): AgentAccessLevel {
  if (providerId === 'claude-code' || providerId === 'codex-cli') {
    // Both read an unset mode with FAM as auto.
    if (!launch.freeAgentMode) return 'standard';
    return launch.permissionMode === 'skip-all' ? 'bypass' : 'auto';
  }
  if (launch.freeAgentMode) return 'bypass';
  return launch.permissionMode === 'skip-all' ? 'auto' : 'standard';
}

/** A chat agent's live permission level as launch settings (lower levels read as standard). */
export function launchAccessForChatLevel(level: PermissionLevel): AgentLaunchAccess {
  switch (level) {
    case 'full_access': return launchAccessFor('bypass');
    case 'auto': return launchAccessFor('auto');
    default: return launchAccessFor('standard');
  }
}

function rank(level: AgentAccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

function lower(a: AgentAccessLevel, b: AgentAccessLevel): AgentAccessLevel {
  return rank(a) <= rank(b) ? a : b;
}

export interface HelperAccessResolution extends AgentLaunchAccess {
  level: AgentAccessLevel;
  /** The orchestrator's live level, the ceiling. Standard when it isn't running or its mode is unknown. */
  ceiling: AgentAccessLevel;
  /** True when the helper got less than the policy asked for. */
  clamped: boolean;
  /** The provider the level was ranked for. */
  helperProvider?: string;
}

/**
 * A helper's launch access. `orchestratorLive` is what the orchestrator runs
 * with now (undefined when it isn't running); `same` follows it, bypass
 * included, and a fixed level is lowered to it. The level is then lowered
 * until the helper provider's real flags don't exceed the ceiling, so a
 * Copilot helper of an `auto` orchestrator starts standard, not --yolo.
 */
export function resolveHelperAccess(
  orchestratorLive: { freeAgentMode?: boolean; permissionMode?: FreeAgentPermissionMode } | undefined,
  access: OrchestrationAccess,
  helperProvider?: string,
): HelperAccessResolution {
  const ceiling = accessLevelOf(orchestratorLive);
  const requested = access === 'same' ? ceiling : access;
  let level = lower(requested, ceiling);
  while (rank(level) > 0 && rank(providerAccessLevel(helperProvider, launchAccessFor(level))) > rank(ceiling)) {
    level = ACCESS_LEVELS[rank(level) - 1];
  }
  return {
    ...launchAccessFor(level),
    level,
    ceiling,
    clamped: rank(level) < rank(requested),
    ...(helperProvider && { helperProvider }),
  };
}

export function isAccessLevel(value: unknown): value is AgentAccessLevel {
  return (ACCESS_LEVELS as readonly unknown[]).includes(value);
}

/** True when `a` is a lower access level than `b`. */
export function isLowerAccess(a: AgentAccessLevel, b: AgentAccessLevel): boolean {
  return rank(a) < rank(b);
}

export interface HelperLaunch extends AgentLaunchAccess {
  /** What the helper's CLI really gets with these settings. */
  level: AgentAccessLevel;
  /** True when the helper got less than the policy or the request asked for. */
  clamped: boolean;
}

/**
 * The launch settings for a helper on `provider`: the policy's resolution
 * (already under the orchestrator's live ceiling), lowered to `requested`
 * (the access start_helper asked for) when that asks for less, then ranked
 * for the provider's real flags so the helper never gets more than the lower
 * of the two. `level` is the level those flags give.
 */
export function rankHelperLaunch(
  resolved: HelperAccessResolution,
  requested: string | undefined,
  provider: string | undefined,
): HelperLaunch {
  let target = resolved.level;
  const asked = isAccessLevel(requested) ? requested : undefined;
  if (asked && rank(asked) < rank(target)) target = asked;
  const ranked = resolveHelperAccess(launchAccessFor(target), 'same', provider);
  const launch = { freeAgentMode: ranked.freeAgentMode, permissionMode: ranked.permissionMode };
  const level = providerAccessLevel(provider, launch);
  const wanted = asked ?? resolved.level;
  return { ...launch, level, clamped: resolved.clamped || rank(level) < rank(wanted) };
}

// ── Limits ───────────────────────────────────────────────────────────────

export type HelperLimitCheck =
  | { ok: true; helperCount: number; totalHelperCount: number; maxHelpers: number; globalCap: number }
  | {
    ok: false;
    reason: 'orchestration-off' | 'agent-limit' | 'global-cap';
    message: string;
    helperCount: number;
    totalHelperCount: number;
    maxHelpers: number;
    globalCap: number;
  };

/**
 * Whether an orchestrator may start one more helper: its live helpers must be
 * under its own limit, and live helpers app-wide under the global cap.
 */
export function checkHelperLimit(counts: {
  helperCount: number;
  totalHelperCount: number;
  maxHelpers: number;
  globalCap: number;
}): HelperLimitCheck {
  const { helperCount, totalHelperCount, maxHelpers, globalCap } = counts;
  if (helperCount >= maxHelpers) {
    return {
      ok: false,
      reason: 'agent-limit',
      message: `This agent already has ${helperCount} of ${maxHelpers} helpers. Dispose or hand off one before starting another.`,
      ...counts,
    };
  }
  if (totalHelperCount >= globalCap) {
    return {
      ok: false,
      reason: 'global-cap',
      message: `Clubhouse already has ${totalHelperCount} of ${globalCap} helpers running across all orchestrators.`,
      ...counts,
    };
  }
  return { ok: true, ...counts };
}

// ── Turning orchestration off ────────────────────────────────────────────

/** What happens to an agent's helpers when orchestration is turned off. */
export type OrchestrationOffChoice = 'keep' | 'dispose' | 'cancel';

/** An orchestrator's live direct helpers in one project. */
export interface HelperProjectGroup {
  projectPath: string;
  helperIds: string[];
}

/** An orchestrator's live direct helpers in every project, home project first. */
export interface HelperSummary {
  hasHelpers: boolean;
  helperIds: string[];
  projects: HelperProjectGroup[];
}

export interface SetOrchestrationPolicyResult {
  ok: boolean;
  message: string;
  policy?: ResolvedOrchestrationPolicy;
  /**
   * Set when the patch turns orchestration off while the agent has live
   * helpers. Nothing changed; call turnOffOrchestration with a choice.
   */
  needsHelperChoice?: { helperIds: string[]; projects: HelperProjectGroup[] };
  /**
   * Set when the patch turned cross-project helpers off while the agent has
   * live helpers in other projects: how many. Nothing is settled; they keep
   * running and can still be managed.
   */
  crossProjectHelpersKept?: number;
  /** Set when the patch turns on a switch that needs Clubhouse MCP while it is off. Nothing changed. */
  mcpRequired?: boolean;
}

/**
 * The result of turnOffOrchestration. With `keep` or `dispose` the helper
 * fields are the cascade's, as for an orchestrator delete; orchestration is
 * off only when `ok` is true. `cancel` changes nothing and returns `cancelled`.
 */
export interface TurnOffOrchestrationResult extends HelperCascadeResult {
  cancelled?: boolean;
  policy?: ResolvedOrchestrationPolicy;
}

/** A policy patch as IPC takes it: a field set to null goes back to the persona or default value. */
export type OrchestrationPolicyPatch = ReturnType<typeof validateOrchestrationPatch>;
