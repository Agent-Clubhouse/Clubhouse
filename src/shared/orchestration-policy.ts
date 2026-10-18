import type { FreeAgentPermissionMode, HelperCascadeResult } from './types';

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

export const ORCHESTRATION_DEFAULTS: Readonly<OrchestrationPolicy> = Object.freeze({
  orchestrate: false,
  access: 'same',
  control: 'hands-off',
  maxHelpers: DEFAULT_MAX_HELPERS,
});

/** The refusal an orchestration tool returns for an agent with orchestration off. */
export const ORCHESTRATION_OFF_MESSAGE = 'Orchestration is turned off for this agent.';

/** Where each field of a resolved policy came from. */
export type OrchestrationPolicySource = 'agent' | 'persona' | 'default';

export interface ResolvedOrchestrationPolicy extends OrchestrationPolicy {
  sources: Record<keyof OrchestrationPolicy, OrchestrationPolicySource>;
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
 */
export function resolveOrchestrationPolicy(
  agentConfig: OrchestrationPolicyConfig | undefined,
  personaDefaults: OrchestrationPolicyConfig | undefined,
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
  return { ...policy, sources };
}

// ── Access ───────────────────────────────────────────────────────────────

/** The launch settings an agent starts with, as spawnAgent takes them. */
export interface AgentLaunchAccess {
  freeAgentMode: boolean;
  /** Set only with Free Agent Mode on. */
  permissionMode?: FreeAgentPermissionMode;
}

/** The access level of a set of launch settings. Free Agent Mode with no mode reads as bypass, the app default. */
export function accessLevelOf(launch: { freeAgentMode?: boolean; permissionMode?: FreeAgentPermissionMode }): AgentAccessLevel {
  if (!launch.freeAgentMode) return 'standard';
  return launch.permissionMode === 'auto' ? 'auto' : 'bypass';
}

/** The launch settings for an access level. */
export function launchAccessFor(level: AgentAccessLevel): AgentLaunchAccess {
  switch (level) {
    case 'standard': return { freeAgentMode: false };
    case 'auto': return { freeAgentMode: true, permissionMode: 'auto' };
    case 'bypass': return { freeAgentMode: true, permissionMode: 'skip-all' };
  }
}

function rank(level: AgentAccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

export interface HelperAccessResolution extends AgentLaunchAccess {
  level: AgentAccessLevel;
  /** The orchestrator's own level, the ceiling. */
  ceiling: AgentAccessLevel;
  /** True when a fixed level above the orchestrator's was lowered to it. */
  clamped: boolean;
}

/**
 * A helper's launch access: the orchestrator's own with `same` (bypass
 * carries through), or the fixed level, lowered to the orchestrator's when
 * it asks for more. Never higher than the orchestrator.
 */
export function resolveHelperAccess(
  orchestrator: { freeAgentMode?: boolean; permissionMode?: FreeAgentPermissionMode },
  access: OrchestrationAccess,
): HelperAccessResolution {
  const ceiling = accessLevelOf(orchestrator);
  const requested = access === 'same' ? ceiling : access;
  const clamped = rank(requested) > rank(ceiling);
  const level = clamped ? ceiling : requested;
  return { ...launchAccessFor(level), level, ceiling, clamped };
}

// ── Limits ───────────────────────────────────────────────────────────────

export type HelperLimitCheck =
  | { ok: true; helperCount: number; totalHelperCount: number; maxHelpers: number; globalCap: number }
  | {
    ok: false;
    reason: 'agent-limit' | 'global-cap';
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

export interface SetOrchestrationPolicyResult {
  ok: boolean;
  message: string;
  policy?: ResolvedOrchestrationPolicy;
  /**
   * Set when the patch turns orchestration off while the agent has live
   * helpers. Nothing changed; call turnOffOrchestration with a choice.
   */
  needsHelperChoice?: { helperIds: string[] };
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
