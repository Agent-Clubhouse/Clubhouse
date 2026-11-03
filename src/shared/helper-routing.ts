/**
 * Helper routing (#2671, docs/helper-auto-routing.md): what an orchestrator can
 * ask for with `difficulty`, the per-provider presets behind it, and the record
 * of what a start decided. Pure types and functions shared by main and renderer;
 * the main side lives in services/helper-routing.ts.
 *
 * Stage 2 is preset mode only. A preset stays on one CLI and only acts when an
 * orchestrator sends `difficulty`.
 */

import { isEffortValue } from './agent-helpers';
import type { HelperAutoOffReason, HelperAutoSource } from './orchestration-policy';

export const HELPER_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type HelperDifficulty = (typeof HELPER_DIFFICULTIES)[number];

export function isHelperDifficulty(value: unknown): value is HelperDifficulty {
  return (HELPER_DIFFICULTIES as readonly unknown[]).includes(value);
}

/** Recorded on each decision, so telemetry can tell which values produced it. */
export const HELPER_ROUTING_POLICY_VERSION = 1;

/** The providers presets are defined for. Copilot's list reports no per-model efforts. */
export const PRESET_PROVIDERS = ['claude-code', 'codex-cli'] as const;
export type PresetProvider = (typeof PRESET_PROVIDERS)[number];

export function isPresetProvider(value: unknown): value is PresetProvider {
  return (PRESET_PROVIDERS as readonly unknown[]).includes(value);
}

export interface PresetCell {
  model: string;
  /** Null passes no level, so the CLI picks. For a model that takes none, or a choice to leave it to the CLI. */
  effort: string | null;
}

export type ProviderPresets = Record<HelperDifficulty, PresetCell>;

/**
 * The built-in presets. These are tunable starting proposals, not measured
 * optimal values: nothing has compared them on real tasks. Every value is checked
 * against the CLI's list when it is used, and one that is no longer offered is
 * never run.
 */
export const BUILTIN_PRESETS: Readonly<Record<PresetProvider, ProviderPresets>> = {
  'claude-code': {
    easy: { model: 'haiku', effort: 'low' },
    medium: { model: 'sonnet', effort: 'medium' },
    hard: { model: 'opus', effort: 'high' },
  },
  'codex-cli': {
    easy: { model: 'gpt-6-luna', effort: 'low' },
    medium: { model: 'gpt-6.1-terra', effort: 'medium' },
    hard: { model: 'gpt-6.1-sol', effort: 'high' },
  },
};

/** The user's overrides. Only what differs from a built-in is kept. */
export type SavedPresets = Partial<Record<PresetProvider, Partial<Record<HelperDifficulty, PresetCell>>>>;

/** A model id as a CLI's list gives it: no spaces or shell syntax, since it reaches CLI arguments. */
export function isPresetModel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(value);
}

/** Keep only the valid cells of a stored value. Never throws. */
export function normalizeSavedPresets(raw: unknown): SavedPresets {
  const out: SavedPresets = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const provider of PRESET_PROVIDERS) {
    const cells = (raw as Record<string, unknown>)[provider];
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) continue;
    for (const difficulty of HELPER_DIFFICULTIES) {
      const cell = (cells as Record<string, unknown>)[difficulty] as Partial<PresetCell> | undefined;
      if (!cell || !isPresetModel(cell.model)) continue;
      const effort = cell.effort === null || cell.effort === undefined ? null : cell.effort;
      if (effort !== null && !isEffortValue(effort)) continue;
      (out[provider] ??= {})[difficulty] = { model: cell.model, effort };
    }
  }
  return out;
}

// ── Codes ────────────────────────────────────────────────────────────────

export type HelperRoutingMode = 'explicit' | 'preset' | 'auto';
export type HelperRoutingReason = 'explicit_request' | 'persona_pinned' | 'preset_on_cli' | 'only_candidate' | 'lower_load' | 'better_quota_tier' | 'sticky' | 'default_order';
export type HelperRoutingFallback = 'none' | 'builtin_preset' | 'candidate_skipped' | 'model_unverified';
export type HelperRoutingFieldSource = 'request' | 'persona' | 'orchestrator' | 'auto' | 'custom_mapping' | 'builtin_mapping' | 'cli_default';
export type HelperRoutingSkip = 'cli_disabled' | 'cli_unavailable' | 'auto_not_supported' | 'no_valid_mapping' | 'cooling_down' | 'quota_near_limit' | 'quota_exhausted';
export type { HelperAutoOffReason, HelperAutoSource } from './orchestration-policy';
export type PresetCellState = 'valid' | 'unverified' | 'stale';
export type PresetStaleReason = 'model_unavailable' | 'effort_unavailable';
export type HelperContextStatus = 'none' | 'applied' | 'reset' | 'not_applied';

/** What the desktop advertises at this stage. A client keys on these, so nothing is listed before it works. */
export const HELPER_ROUTING_MODES: readonly HelperRoutingMode[] = ['explicit', 'preset', 'auto'];
export const HELPER_ROUTING_REASONS: readonly HelperRoutingReason[] = ['explicit_request', 'persona_pinned', 'preset_on_cli', 'only_candidate', 'lower_load', 'better_quota_tier', 'sticky', 'default_order'];
export const HELPER_ROUTING_FALLBACKS: readonly HelperRoutingFallback[] = ['none', 'builtin_preset', 'candidate_skipped', 'model_unverified'];
export const HELPER_ROUTING_SKIPS: readonly HelperRoutingSkip[] = ['cli_disabled', 'cli_unavailable', 'auto_not_supported', 'no_valid_mapping', 'cooling_down', 'quota_near_limit', 'quota_exhausted'];
export const HELPER_AUTO_OFF_REASONS: readonly HelperAutoOffReason[] = ['not_enabled', 'project_off', 'persona_off', 'orchestration_off', 'mcp_off', 'dispatcher_locked'];
export const PRESET_CELL_STATES: readonly PresetCellState[] = ['valid', 'unverified', 'stale'];

/**
 * The words for every code, by family, including codes for later stages, so a
 * client can cache them once per revision. A client falls back to `generic.unknownCode`.
 */
export const HELPER_ROUTING_LABELS = {
  reason: {
    explicit_request: 'You or the orchestrator chose this',
    persona_pinned: 'Set by the persona',
    preset_on_cli: 'From the helper settings for this difficulty',
    only_candidate: 'The only provider available',
    lower_load: 'Fewer helpers running on this provider',
    better_quota_tier: 'This provider has more of its limit left',
    sticky: 'Stayed on the provider chosen last',
    default_order: 'No reason to switch',
  },
  fallback: {
    none: 'None',
    builtin_preset: 'The saved choice is no longer offered, so the default was used',
    candidate_skipped: 'Another provider was skipped',
    model_unverified: 'The model list may be out of date, so this couldn’t be checked',
    retried_after_spawn_failure: 'Started on another provider after the first failed to start',
  },
  skipped: {
    cli_disabled: 'Turned off in Settings',
    cli_unavailable: 'Not available on this computer',
    auto_not_supported: 'Auto doesn’t support this provider yet',
    no_valid_mapping: 'No choice for this difficulty is offered now',
    cooling_down: 'It failed to start recently',
    quota_near_limit: 'Close to its limit',
    quota_exhausted: 'The provider reports its limit reached',
  },
  quota: {
    known: 'Limit available',
    low: 'Limit getting low',
    near_limit: 'Close to the limit',
    exhausted: 'Limit reached',
    unknown: 'Unknown',
  },
  unknown: {
    not_read: 'Not checked yet',
    stale: 'Last checked too long ago',
    not_applicable: 'This login has no plan limit',
    read_failed: 'Couldn’t check',
    not_supported: 'This provider doesn’t report it',
  },
  window: {
    weekly: 'Weekly limit',
    fiveHour: '5-hour limit',
    other: 'Plan limit',
  },
  autoSource: {
    agent: 'Set on this agent',
    project: 'Set for this project',
    persona: 'Set by this agent’s persona',
    app: 'Set for the whole app',
    default: 'Off unless turned on',
    mcp_off: 'Clubhouse MCP is off for this agent',
    dispatcher_locked: 'Not for the Dispatcher',
  },
  autoOff: {
    not_enabled: 'It isn’t turned on',
    project_off: 'This project turned it off',
    persona_off: 'This agent’s persona turned it off',
    orchestration_off: 'This agent doesn’t orchestrate',
    mcp_off: 'Clubhouse MCP is off for this agent',
    dispatcher_locked: 'The Dispatcher doesn’t start helpers',
  },
  cell: {
    valid: 'Offered',
    unverified: 'Couldn’t be checked',
    stale: 'No longer offered',
  },
  generic: {
    unknownCode: 'Clubhouse gave a reason this version can’t show',
  },
} as const;

// ── What a start decided ─────────────────────────────────────────────────

/**
 * What a start decided, saved on the helper. It describes the decision. It is
 * absent on a helper whose start asked for nothing, and goes when the helper's
 * model or CLI is changed later, so it never names what the helper isn't using.
 */
export interface HelperRouting {
  mode: HelperRoutingMode;
  /** True only when Auto chose among providers, so nothing claims balancing for a helper an argument or a persona decided. */
  balanced: boolean;
  decidedAt: string;
  policyVersion: number;
  requested: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  resolved: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  source: { provider: HelperRoutingFieldSource; model: HelperRoutingFieldSource; effort: HelperRoutingFieldSource };
  reason: HelperRoutingReason;
  fallback: HelperRoutingFallback;
  context: { status: HelperContextStatus };
  /** A provider this start named looked unwell, as far as was known. It never blocks an explicit choice. */
  warning?: HelperStartWarning;
  /** What Auto saw, for a decision it made. Never live: these are as of `decidedAt`. */
  load?: Record<string, number>;
  quota?: Record<string, QuotaDecisionView>;
  /** `unknown_scored_as_healthy`: the chosen provider's quota was unknown, and that says nothing about its capacity. */
  quotaBasis?: 'known' | 'unknown_scored_as_healthy';
  skipped?: Record<string, HelperRoutingSkip>;
}

/**
 * What was known about a provider a start named. `message` is the words to show:
 * it says what was reported, and never promises capacity. `asOf` is when it became
 * known, so it can be old, since a warning never asks a CLI.
 */
export interface HelperStartWarning {
  code: 'quota_near_limit' | 'quota_exhausted' | 'cooling_down';
  message: string;
  asOf: string;
}

/** A provider's quota as a decision saw it. */
export type QuotaDecisionView = Pick<QuotaView, 'state' | 'unknownReason' | 'asOf' | 'limitingWindow'>;

/** The snapshot's codes-only form, for a helper in every row. */
export function minimalRouting(routing: HelperRouting) {
  const { mode, reason, resolved: { difficulty, provider, model, effort } } = routing;
  return { mode, difficulty, provider, model, effort, reason };
}

/** A string from a label family, or the generic one for a code this version doesn't have. */
export function routingLabel(family: keyof typeof HELPER_ROUTING_LABELS, code: string): string {
  const labels = HELPER_ROUTING_LABELS[family] as Record<string, string>;
  return labels[code] ?? HELPER_ROUTING_LABELS.generic.unknownCode;
}

/** One line for a person: what a helper runs on and why. */
export function describeRouting(routing: HelperRouting): string {
  const { resolved, reason } = routing;
  const what = [resolved.model ?? 'its default model', resolved.effort && `${resolved.effort} effort`].filter(Boolean).join(', ');
  return `${what}. ${routingLabel('reason', reason)}.`;
}

// ── The settings ─────────────────────────────────────────────────────────

/** One provider and difficulty, as Settings and a phone show it. */
export interface PresetCellView {
  /** What a start uses now, or null when nothing valid is left and the start is refused. */
  effective: PresetCell | null;
  source: 'custom' | 'builtin';
  state: PresetCellState;
  staleReason?: PresetStaleReason;
  fallback?: HelperRoutingFallback;
  custom: PresetCell | null;
  builtin: PresetCell;
  editable: boolean;
}

export interface PresetChoice {
  id: string;
  label: string;
  efforts: string[];
}

export type ProviderRoutingView =
  | {
    autoEligible: true;
    quota: QuotaView;
    choices: { source: 'live' | 'fallback'; asOf: string | null; models: PresetChoice[] };
    cells: Record<HelperDifficulty, PresetCellView>;
  }
  | { autoEligible: false; reason: 'auto_not_supported'; quota: QuotaView; cells: null };

export interface HelperRoutingSettings {
  revision: string;
  /** To show a reading's age from its `asOf`, whatever the client's clock says. */
  serverTime: string;
  labels: typeof HELPER_ROUTING_LABELS;
  providers: Record<string, ProviderRoutingView>;
  /** With an agent in the request: whether it can use presets, and why not. */
  agent?: { usable: boolean; reason?: 'dispatcher_locked' | 'mcp_off' | 'orchestration_off' };
  auto: HelperAutoView;
}

/** Whether `cli: "auto"` is allowed, at the scope asked about, and each level's say in it. */
export interface HelperAutoView {
  effective: boolean;
  source: HelperAutoSource;
  reason?: HelperAutoOffReason;
  scopes: {
    app: { value: boolean; editable: boolean };
    /** Only `off` or null: a project can't turn it on. */
    project?: { value: 'off' | null; choices: ['off', null]; editable: boolean };
    persona?: { value: false | null; editable: false };
    agent?: { value: boolean | null; editable: boolean };
  };
}

/** Asks each CLI again rather than using what's cached. Changes nothing saved. */
export interface HelperRoutingReadOptions {
  refresh: true;
}

export interface HelperRoutingUpdate {
  /** The revision the change was made from. */
  revision: string;
  cells?: Array<{ provider: string; difficulty: string; model: string; effort: string | null }>;
  /** Back to the built-ins: one cell, one provider, or `{}` for all. */
  reset?: { provider?: string; difficulty?: string };
  /** `cli: "auto"`, at the write's scope: a boolean app-wide, `off` or null for a project. */
  auto?: boolean | 'off' | null;
}

export type HelperRoutingUpdateResult =
  | { ok: true; settings: HelperRoutingSettings }
  | { ok: false; code: string; message: string; settings?: HelperRoutingSettings };

// ── Quota ────────────────────────────────────────────────────────────────

/**
 * These are tunable starting proposals, not measured values. Percent used is
 * only ever compared within a provider's own plan: it says nothing about cost.
 */
export const QUOTA_LOW_PERCENT = 80;
export const QUOTA_NEAR_LIMIT_PERCENT = 95;
/** A reading older than this is `unknown`, keeping its `asOf`. */
export const QUOTA_STALE_MS = 15 * 60_000;

export const QUOTA_STATES = ['known', 'low', 'near_limit', 'exhausted', 'unknown'] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];
export const QUOTA_UNKNOWN_REASONS = ['not_read', 'stale', 'not_applicable', 'read_failed', 'not_supported'] as const;
export type QuotaUnknownReason = (typeof QUOTA_UNKNOWN_REASONS)[number];
export const QUOTA_SOURCES = ['cli_query', 'session_event', 'none'] as const;
export type QuotaSource = (typeof QUOTA_SOURCES)[number];

/** One limit as a CLI reports it. A window with no `usedPercent` exists but couldn't be read. */
export interface QuotaWindow {
  /** `week`, `5h`, `week_opus`, `week:<model>`, or another duration such as `1d`. */
  name: string;
  usedPercent?: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
  /** The provider itself said this limit is reached. Used percent alone never sets this. */
  limitReached?: boolean;
  /** Epoch milliseconds: when this window was last heard. */
  asOf: number;
}

/** What a CLI says about its plan limits. `not_applicable`: this login has none (an API key, say). */
export type PlanQuotaReading = { kind: 'windows'; windows: QuotaWindow[] } | { kind: 'not_applicable' };

export type QuotaWindowName = 'weekly' | 'fiveHour' | 'other' | `model:${string}`;

export interface QuotaWindowView {
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface QuotaView {
  state: QuotaState;
  source: QuotaSource;
  /** When the reading behind this was made. Kept on a stale reading; null when there has been none. */
  asOf: string | null;
  unknownReason?: QuotaUnknownReason;
  /** The most constrained window, which sets `state`, and when it resets. */
  limitingWindow?: QuotaWindowName;
  resetsAt?: string | null;
  weekly?: QuotaWindowView | null;
  fiveHour?: QuotaWindowView | null;
  /** Limits for one model. They don't set this state, because they only apply to that model. */
  modelWindows?: Array<QuotaWindowView & { name: string }>;
  /** Windows that exist but couldn't be read, so the others decided. */
  unreadableWindows?: QuotaWindowName[];
  /** How long a fetch would return this same reading. */
  refreshAfterSeconds?: number;
}

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

function wireName(name: string): QuotaWindowName {
  if (name === 'week') return 'weekly';
  if (name === '5h') return 'fiveHour';
  return isModelWindow(name) ? `model:${name.replace(/^week[:_]/, '')}` : 'other';
}

function isModelWindow(name: string): boolean {
  return name.startsWith('week:') || name === 'week_opus' || name === 'week_sonnet';
}

function windowView(window: QuotaWindow | undefined): QuotaWindowView | null {
  return window ? { usedPercent: window.usedPercent ?? null, resetsAt: iso(window.resetsAt) } : null;
}

/**
 * The state a set of windows comes to, from the most constrained one that can
 * be read: the highest used percent, with the later reset breaking a tie. A limit
 * the provider says is reached makes it `exhausted`, whatever the percent. A
 * window past its reset says nothing any more. `model` adds that model's own
 * window, by exact name; only a choice of model should pass it.
 */
export function classifyQuota(windows: readonly QuotaWindow[], now: number, options: { model?: string } = {}): Omit<QuotaView, 'source' | 'refreshAfterSeconds'> {
  const current = windows.filter((w) => (w.resetsAt === undefined || w.resetsAt > now) && now - w.asOf <= QUOTA_STALE_MS);
  // By name, ignoring case: a provider labels a window `Fable` where the model's id is `fable`.
  const counts = (w: QuotaWindow) => !isModelWindow(w.name) || (!!options.model && wireName(w.name).toLowerCase() === `model:${options.model.toLowerCase()}`);
  const readable = current.filter((w) => counts(w) && (w.usedPercent !== undefined || w.limitReached));
  const unreadable = current.filter((w) => counts(w) && w.usedPercent === undefined && !w.limitReached).map((w) => wireName(w.name));
  const listed = {
    weekly: windowView(current.find((w) => w.name === 'week')),
    fiveHour: windowView(current.find((w) => w.name === '5h')),
    ...(current.some((w) => isModelWindow(w.name)) && {
      modelWindows: current.filter((w) => isModelWindow(w.name)).map((w) => ({ name: wireName(w.name).slice('model:'.length), ...windowView(w)! })),
    }),
    ...(unreadable.length > 0 && { unreadableWindows: unreadable }),
  };
  if (readable.length === 0) {
    const anyHeard = windows.length > 0 ? Math.max(...windows.map((w) => w.asOf)) : undefined;
    const allStale = windows.length > 0 && windows.every((w) => now - w.asOf > QUOTA_STALE_MS);
    return { state: 'unknown', unknownReason: allStale ? 'stale' : 'read_failed', asOf: iso(anyHeard), ...listed };
  }
  const reached = readable.filter((w) => w.limitReached);
  const pool = reached.length > 0 ? reached : readable;
  const limiting = [...pool].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0) || (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
  const used = limiting.usedPercent ?? 0;
  const state: QuotaState = reached.length > 0 ? 'exhausted'
    : used >= QUOTA_NEAR_LIMIT_PERCENT ? 'near_limit'
      : used >= QUOTA_LOW_PERCENT ? 'low' : 'known';
  return {
    state,
    // The oldest reading that counted, so a fresh event can't vouch for an old window.
    asOf: iso(Math.min(...readable.map((w) => w.asOf))),
    limitingWindow: wireName(limiting.name),
    resetsAt: iso(limiting.resetsAt),
    ...listed,
  };
}

/** The least a client waits before fetching again, whatever a provider says, so a 0 can't make it spin. */
export const QUOTA_REFETCH_FLOOR_SECONDS = 5;

/**
 * How long to wait before fetching the page again, in seconds: the soonest any
 * provider's reading would be new, and never under the floor. A provider with no
 * `refreshAfterSeconds` asks for nothing, and with none at all there's no timer.
 * Reading another provider early does no harm, since its reading is cached.
 */
export function quotaRefetchDelaySeconds(providers: Readonly<Record<string, { quota?: Pick<QuotaView, 'refreshAfterSeconds'> }>>): number | null {
  const delays = Object.values(providers).map((p) => p.quota?.refreshAfterSeconds).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  return delays.length > 0 ? Math.max(Math.min(...delays), QUOTA_REFETCH_FLOOR_SECONDS) : null;
}
