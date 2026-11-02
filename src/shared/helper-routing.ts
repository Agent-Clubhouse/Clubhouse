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

export type HelperRoutingMode = 'explicit' | 'preset';
export type HelperRoutingReason = 'explicit_request' | 'persona_pinned' | 'preset_on_cli';
export type HelperRoutingFallback = 'none' | 'builtin_preset' | 'model_unverified';
export type HelperRoutingFieldSource = 'request' | 'persona' | 'orchestrator' | 'custom_mapping' | 'builtin_mapping' | 'cli_default';
export type PresetCellState = 'valid' | 'unverified' | 'stale';
export type PresetStaleReason = 'model_unavailable' | 'effort_unavailable';
export type HelperContextStatus = 'none' | 'applied' | 'reset' | 'not_applied';

/** What the desktop advertises at this stage. A client keys on these, so nothing is listed before it works. */
export const HELPER_ROUTING_MODES: readonly HelperRoutingMode[] = ['explicit', 'preset'];
export const HELPER_ROUTING_REASONS: readonly HelperRoutingReason[] = ['explicit_request', 'persona_pinned', 'preset_on_cli'];
export const HELPER_ROUTING_FALLBACKS: readonly HelperRoutingFallback[] = ['none', 'builtin_preset', 'model_unverified'];
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
  /** False for everything but Auto, so nothing claims balancing for a helper an argument decided. */
  balanced: false;
  decidedAt: string;
  policyVersion: number;
  requested: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  resolved: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  source: { provider: HelperRoutingFieldSource; model: HelperRoutingFieldSource; effort: HelperRoutingFieldSource };
  reason: HelperRoutingReason;
  fallback: HelperRoutingFallback;
  context: { status: HelperContextStatus };
}

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
    choices: { source: 'live' | 'fallback'; asOf: string | null; models: PresetChoice[] };
    cells: Record<HelperDifficulty, PresetCellView>;
  }
  | { autoEligible: false; reason: 'auto_not_supported'; cells: null };

export interface HelperRoutingSettings {
  revision: string;
  labels: typeof HELPER_ROUTING_LABELS;
  providers: Record<string, ProviderRoutingView>;
  /** With an agent in the request: whether it can use presets, and why not. */
  agent?: { usable: boolean; reason?: 'dispatcher_locked' | 'mcp_off' | 'orchestration_off' };
}

export interface HelperRoutingUpdate {
  /** The revision the change was made from. */
  revision: string;
  cells?: Array<{ provider: string; difficulty: string; model: string; effort: string | null }>;
  /** Back to the built-ins: one cell, one provider, or `{}` for all. */
  reset?: { provider?: string; difficulty?: string };
}

export type HelperRoutingUpdateResult =
  | { ok: true; settings: HelperRoutingSettings }
  | { ok: false; code: string; message: string; settings?: HelperRoutingSettings };
