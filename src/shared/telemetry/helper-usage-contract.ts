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

export type HelperDecisionOutcome = 'chosen' | 'refused';
export type HelperRefusalCode = 'auto_off' | 'no_candidate' | 'no_valid_mapping' | 'auto_not_supported';

/** What a candidate's quota looked like to the decision. All numbers are basis points; absent = unavailable. */
export interface DecisionQuotaWindow {
  /** `weekly`, `fiveHour`, `other` or `model`. The model's name is not recorded. */
  name: 'weekly' | 'fiveHour' | 'other' | 'model';
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
  quality?: 'fresh' | 'stale' | 'unknown';
  windows?: DecisionQuotaWindow[];
}

export type DecisionScoreBasis = 'none' | 'load_only' | 'quota_tier' | 'weekly_used' | 'normalized_utilization' | 'other';

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
  /** Same-plan profiles that cannot be told apart (an API-key login, say) are marked, never guessed at. */
  accountKnown?: boolean;
  tier?: number;
  score?: DecisionScore;
  /** True for the provider this decision picked. */
  chosen?: boolean;
}

export type DecisionTieReason = 'none' | 'lower_load' | 'rotation' | 'registration_order' | 'sticky' | 'other';

export interface DecisionTie {
  /** Candidates inside the band that decided the tie. */
  setSize: number;
  bandBp?: number;
  reason: DecisionTieReason;
  byLoad?: boolean;
  /** Rotation state before and after, as small integers; the key itself is hashed on recording. */
  cursorKey?: string;
  cursorBefore?: number;
  cursorAfter?: number;
}

/** What one routing decision saw and chose. Produced by routing at the moment it decides. */
export interface HelperDecisionRecord {
  /** UUID v4 from {@link newDecisionId}. Immutable, and the reservation id too. */
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
  requested: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  resolved: { provider: string | null; model: string | null; effort: string | null; difficulty: HelperDifficulty | null };
  source: { provider?: HelperRoutingFieldSource; model: HelperRoutingFieldSource; effort?: HelperRoutingFieldSource };
  reason: HelperRoutingReason;
  fallback: HelperRoutingFallback;
  /** Identity of the effective mapping, bumped with each edit. Hashed on recording. */
  mappingRevision?: string;
  /** Fingerprint across the effective cells, so two runs on the same mapping compare equal. Hashed on recording. */
  mappingFingerprint?: string;
  /** The mapping came from the user's own cells, the built-ins, or neither. */
  mappingKind?: 'custom' | 'builtin' | 'mixed' | 'none';
  /** Auto settings in force. Counts and booleans only. */
  settings?: { autoEnabled: boolean; enabledProviders: number };
  candidates: DecisionCandidate[];
  tie?: DecisionTie;
  /** Cooldowns in force, by provider count and kind, not the providers themselves. */
  cooldownsInForce?: { auth: number; quota: number; availability: number };
}

// --- What happened after ---------------------------------------------------------

export type HelperSpawnResult = 'creation_refused' | 'cancelled' | 'spawn_failed' | 'started' | 'left_asleep';

export interface HelperSpawnResultRecord {
  decisionId: string;
  helperId?: string;
  result: HelperSpawnResult;
  /** A failure that put the provider into a cooldown. */
  cooldownKind?: 'auth' | 'quota' | 'availability';
  /** The provider and model that actually launched, when they differ from the decision's. */
  actual?: { provider: string | null; model: string | null; effort: string | null };
}

export type HelperReuseKind = 'wake' | 'resume';

export interface HelperReuseRecord {
  helperId: string;
  kind: HelperReuseKind;
}

/** How a helper's run ended. */
export type HelperRunOutcome = 'completed' | 'failed' | 'cancelled' | 'killed' | 'disposed' | 'unknown';

/** A session error the run saw, by class. */
export type HelperRunErrorClass = 'auth' | 'rate_limit' | 'quota' | 'other';

// --- Usage ------------------------------------------------------------------------

/** Where a usage number came from. */
export type UsageSource =
  /** The provider's own total for one finished turn. */
  | 'provider_turn'
  /** The provider's running total for the session or thread, as last reported. */
  | 'provider_session_cumulative'
  /** Our sum of the provider's per-call figures, each counted once. */
  | 'summed_calls'
  /** Unknown scope: do not add to anything. */
  | 'unscoped';

/** How repeats were told apart. `none` means they could not be, and the sample says so. */
export type UsageDedup = 'turn_id' | 'message_id' | 'thread_cumulative' | 'content_equal' | 'none';

/** Which activity a figure covers. Samples of different scopes are never added together. */
export type UsageScope = 'main' | 'inclusive';

export type UsageCompleteness = 'complete' | 'partial' | 'none';

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
