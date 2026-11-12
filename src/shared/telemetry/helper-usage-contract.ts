/**
 * The contract between helper routing and helper usage telemetry (#2747,
 * epic #2886). Types and closed value sets only: no behavior, no imports from
 * main, so routing code and the telemetry that records it agree on one shape.
 *
 * Routing produces a {@link HelperDecisionRecord} and calls the recorders in
 * main/telemetry/helper-usage.ts. Nothing here is a routing rule: a policy
 * fills the fields it has and leaves the rest absent.
 *
 * Rules every field follows:
 * - Absent means unavailable. `0` means the source reported zero. Never default
 *   a missing number to 0.
 * - Percentages are integer basis points (0..10000) of the provider's own plan
 *   window. They are never derived from tokens or dollars.
 * - Times are epoch milliseconds.
 * - No prompt, task text, path, account name or credential appears anywhere.
 *   A model id is recorded only as a salted hash plus a closed family.
 */

import type { HelperDifficulty, HelperRoutingFallback, HelperRoutingFieldSource, HelperRoutingMode, HelperRoutingReason, HelperRoutingSkip, QuotaSource, QuotaState, QuotaUnknownReason } from '../helper-routing';

/** Bump when a field is renamed or changes meaning; adding an optional field does not. */
export const HELPER_TELEMETRY_SCHEMA_VERSION = 1;

// --- Limits (stated so the budget is visible in one place) ---------------------

export const HELPER_TELEMETRY_LIMITS = {
  /** Candidate events per decision (one per registered provider). */
  maxCandidatesPerDecision: 8,
  /** Usage samples one helper run may write: one per finished turn, then the closing one. */
  maxUsageSamplesPerRun: 200,
  /** Quota samples per provider per hour, apart from the first reading after start. */
  maxQuotaSamplesPerProviderPerHour: 12,
  /** Least time between two quota samples of one provider unless its state changed. */
  quotaSampleMinGapMs: 5 * 60_000,
  /** An unchanged reading is sampled at most this often. */
  quotaSampleIntervalMs: 15 * 60_000,
  /** A window that moved this much (basis points) between readings is a change worth a sample. */
  quotaSampleChangeBp: 100,
  /** Every helper-telemetry event of all kinds, per hour. Past it they are dropped and counted. */
  maxEventsPerHour: 2_000,
  /** Helpers the join ledger remembers once they are not running. Active helpers are never evicted. */
  maxInactiveLedgerEntries: 500,
  /** Ledger entries older than this and not running are dropped. */
  ledgerInactiveRetentionMs: 30 * 24 * 60 * 60_000,
} as const;

// --- The decision --------------------------------------------------------------

export const HELPER_DECISION_OUTCOMES = ['chosen', 'refused'] as const;
export type HelperDecisionOutcome = (typeof HELPER_DECISION_OUTCOMES)[number];
export const HELPER_REFUSAL_CODES = ['auto_off', 'no_candidate', 'no_valid_mapping', 'auto_not_supported'] as const;
export type HelperRefusalCode = (typeof HELPER_REFUSAL_CODES)[number];

/**
 * The kind of task, as a closed set, never its text. Only when the caller
 * supplied one. The difficulty a start named is a mapping input and is recorded
 * as such (`helper_routing.difficulty`); it is not an observed task type, so it
 * is never copied here. `unspecified`: nothing was supplied.
 */
export const HELPER_TASK_PROFILES = ['unspecified', 'small', 'medium', 'large'] as const;
export type HelperTaskProfile = (typeof HELPER_TASK_PROFILES)[number];

export const HELPER_FORECAST_UNAVAILABLE_REASONS = ['missing_identity', 'missing_calibration_identity', 'insufficient_samples', 'insufficient_effective_samples'] as const;
export const HELPER_FORECAST_BASELINE_UNAVAILABLE_REASONS = ['missing', 'not_fresh', 'missing_timestamp', 'future_timestamp', 'stale', 'missing_windows'] as const;
export const HELPER_CALIBRATION_IDENTITY_REASONS = ['cached_catalog', 'missing_generation', 'missing_catalog', 'fallback_catalog', 'stale_catalog', 'unresolved_model', 'unverified_mapping'] as const;
export type HelperCalibrationIdentityReason = (typeof HELPER_CALIBRATION_IDENTITY_REASONS)[number];

/** Separate from the public settings revision: one exact mapped cell and its live catalog identity. */
export interface HelperCalibrationIdentity {
  revision: string;
  model: string;
}

export const DECISION_QUOTA_WINDOW_NAMES = ['weekly', 'fiveHour', 'other', 'model'] as const;
export const DECISION_QUOTA_QUALITIES = ['fresh', 'stale', 'unknown'] as const;

/** What a candidate's quota looked like to the decision. All numbers are basis points; absent = unavailable. */
export interface DecisionQuotaWindow {
  /** `weekly`, `fiveHour`, `other` or `model`. The model's name is not recorded. */
  name: (typeof DECISION_QUOTA_WINDOW_NAMES)[number];
  usedBp?: number;
  resetsAtMs?: number;
  /** The provider itself said this limit is reached. */
  limitReached?: boolean;
}

export interface DecisionQuota {
  state: QuotaState;
  source: QuotaSource;
  /** When the reading was made. Absent when there has been none. */
  asOfMs?: number;
  unknownReason?: QuotaUnknownReason;
  /** Recent, stale or unknown, as the policy judged it. */
  quality?: (typeof DECISION_QUOTA_QUALITIES)[number];
  windows?: DecisionQuotaWindow[];
}

export const DECISION_SCORE_BASES = ['none', 'load_only', 'quota_tier', 'weekly_used', 'normalized_utilization', 'reset_schedule', 'unmeasured', 'other'] as const;
export type DecisionScoreBasis = (typeof DECISION_SCORE_BASES)[number];

/** A policy's own ranking inputs, policy-versioned by the decision's `policyVersion`. All optional. */
export interface DecisionScore {
  basis: DecisionScoreBasis;
  weeklyUsedBp?: number;
  cyclePhaseBp?: number;
  targetBp?: number;
  pressureBp?: number;
  /** Rank among the eligible candidates, 0 = best. */
  rank?: number;
}

export interface DecisionCandidate {
  provider: string;
  /** Registered and asked about, whether or not it could run this start. */
  eligible: boolean;
  excluded?: HelperRoutingSkip;
  /** The model and effort the mapping gave this provider for the difficulty. Raw ids are hashed on recording. */
  mapped?: { model: string | null; effort: string | null; source: HelperRoutingFieldSource; verified: boolean };
  load: { live: number; reserved: number };
  quota?: DecisionQuota;
  /** Logins that cannot be told apart (an API-key login, say) are marked, never guessed at. */
  accountKnown?: boolean;
  tier?: number;
  score?: DecisionScore;
  /** True for the provider this decision picked. */
  chosen?: boolean;
}

export const DECISION_TIE_REASONS = ['none', 'lower_load', 'rotation', 'registration_order', 'sticky', 'other'] as const;
export type DecisionTieReason = (typeof DECISION_TIE_REASONS)[number];

export interface DecisionTie {
  /** Candidates inside the band that decided the tie. */
  setSize: number;
  bandBp?: number;
  reason: DecisionTieReason;
  byLoad?: boolean;
  /** The rotation or tie state key (hashed on recording) and its counter before and after, as small integers. */
  cursorKey?: string;
  cursorBefore?: number;
  cursorAfter?: number;
}

export const MAPPING_KINDS = ['custom', 'builtin', 'mixed', 'none'] as const;

/** What one routing decision saw and chose. Produced by routing at the moment it decides. */
export interface HelperDecisionRecord {
  /** UUID v4 (`newDecisionId()` in main/telemetry/helper-usage.ts). Immutable, and the reservation id too. */
  decisionId: string;
  decidedAtMs: number;
  policyVersion: number;
  mode: HelperRoutingMode;
  outcome: HelperDecisionOutcome;
  refusalCode?: HelperRefusalCode;
  /** The helper this decision is for. Absent for a refusal. It is the agent id. */
  helperId?: string;
  /** The orchestrator that asked, when it was one of the known CLIs. */
  orchestratorProvider?: string;
  /** Only if supplied; absent records `unspecified`. Not inferred from difficulty. */
  taskProfile?: HelperTaskProfile;
  requested: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  resolved: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  /** Absent on a refusal: nothing was resolved, so nothing has a source. */
  source?: { provider?: HelperRoutingFieldSource; model?: HelperRoutingFieldSource; effort?: HelperRoutingFieldSource };
  /** Absent on a refusal: no reason is invented for a choice that was not made. */
  reason?: HelperRoutingReason;
  fallback?: HelperRoutingFallback;
  /** Identity of the effective mapping, bumped with each edit. Hashed on recording. */
  mappingRevision?: string;
  /** Absent on legacy or unverified identities; those observations cannot train new cohorts. */
  calibration?: HelperCalibrationIdentity;
  calibrationIdentityReason?: HelperCalibrationIdentityReason;
  /** Fingerprint across the effective cells, so two runs on the same mapping compare equal. Hashed on recording. */
  mappingFingerprint?: string;
  /** The mapping came from the user's own cells, the built-ins, or neither. */
  mappingKind?: (typeof MAPPING_KINDS)[number];
  /** Auto settings in force. Counts and booleans only. */
  settings?: { autoEnabled: boolean; enabledProviders: number };
  candidates: DecisionCandidate[];
  tie?: DecisionTie;
  /** Numeric thresholds in force (basis points, milliseconds), so the policy can be replayed from the record. */
  thresholds?: { quotaLowBp?: number; quotaNearLimitBp?: number; quotaStaleMs?: number; reservationMs?: number; stickyMs?: number; loadMargin?: number };
  /** Cooldowns in force, by provider count and kind, not the providers themselves. */
  cooldownsInForce?: { auth: number; quota: number; availability: number };
}

// --- What happened after ---------------------------------------------------------

export const HELPER_SPAWN_RESULTS = ['creation_refused', 'cancelled', 'spawn_failed', 'started', 'left_asleep'] as const;
export type HelperSpawnResult = (typeof HELPER_SPAWN_RESULTS)[number];
export const HELPER_COOLDOWN_KINDS = ['auth', 'quota', 'availability'] as const;

export interface HelperSpawnResultRecord {
  decisionId: string;
  helperId?: string;
  result: HelperSpawnResult;
  /** A failure that put the provider into a cooldown. */
  cooldownKind?: (typeof HELPER_COOLDOWN_KINDS)[number];
  /** The provider and model that actually launched, when they differ from the decision's. */
  actual?: { provider: string | null; model: string | null; effort: string | null };
}

export const HELPER_REUSE_KINDS = ['wake', 'resume'] as const;
export type HelperReuseKind = (typeof HELPER_REUSE_KINDS)[number];

export interface HelperReuseRecord {
  helperId: string;
  kind: HelperReuseKind;
}

/** How a helper's run ended. */
export const HELPER_RUN_OUTCOMES = ['completed', 'failed', 'cancelled', 'disposed', 'unknown'] as const;
export type HelperRunOutcome = (typeof HELPER_RUN_OUTCOMES)[number];

// --- Usage ------------------------------------------------------------------------

/** Where a usage number came from. */
export const USAGE_SOURCES = [
  /** The provider's own total for one finished turn. */
  'provider_turn',
  /** The provider's running total for the session or thread, as last reported. */
  'provider_session_cumulative',
  /** Our sum of the provider's per-call figures (a driver that reports each model call, not a total). */
  'summed_calls',
  /** The difference between two of the provider's running totals, taken by us (a provider that reports no per-turn figure). */
  'cumulative_delta',
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** A sample's place in the run: one finished turn, or the closing figure. */
export const USAGE_SAMPLE_KINDS = ['turn', 'final'] as const;

/** How repeats were told apart. `none` means they could not be, and the sample says so. */
export const USAGE_DEDUPS = ['turn_id', 'message_id', 'thread_cumulative', 'content_equal', 'none'] as const;
export type UsageDedup = (typeof USAGE_DEDUPS)[number];

/** Which activity a figure covers. Samples of different scopes are never added together. */
/** `unscoped`: the driver did not say, so the figure is not added to anything. */
export const USAGE_SCOPES = ['main', 'inclusive', 'unscoped'] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

/**
 * What a closing (running-total) sample covers. `run`: a native session begun by this run and never reset, so
 * the total is this run's use. `lifetime`: the run resumed a native session, whose provider total carries the
 * earlier runs' use; the run's own share is unknown from this sample (use the turn samples). `after_reset`: the
 * provider's total went down during the run (a /clear or compaction), so it covers only what came after.
 */
export const USAGE_BASELINES = ['run', 'lifetime', 'after_reset'] as const;
export type UsageBaseline = (typeof USAGE_BASELINES)[number];

export const USAGE_COMPLETENESS = ['complete', 'partial', 'none'] as const;
export type UsageCompleteness = (typeof USAGE_COMPLETENESS)[number];

/** Token figures in the contract's convention (src/shared/chat/events.ts TokenUsage). Absent = not reported. */
export interface UsageFigures {
  /** Total input, cache reads and writes included. */
  input?: number;
  cachedInput?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
}

export const USAGE_FIGURE_KEYS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const;

/** `complete` when input and output were both reported, `partial` when only some were, `none` when nothing was. */
export function usageCompleteness(figures: UsageFigures): UsageCompleteness {
  const present = USAGE_FIGURE_KEYS.filter((k) => figures[k] !== undefined).length;
  if (present === 0) return 'none';
  return figures.input !== undefined && figures.output !== undefined ? 'complete' : 'partial';
}
