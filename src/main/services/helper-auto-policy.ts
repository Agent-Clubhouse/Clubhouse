/**
 * How Auto picks a provider for a fresh helper (#2887, epic #2886,
 * docs/helper-auto-routing.md). Pure and deterministic, with the clock and the
 * rotation state passed in, so a decision can be explained, replayed and tested.
 *
 * Auto balances plan consumption: the provider whose own plan shows less of its
 * weekly limit used is generally favored. Nothing here knows who asked, which
 * provider was chosen last, or the order providers were registered in.
 *
 * Every number here is a tunable starting proposal, not a measured value. Each
 * decision records HELPER_ROUTING_POLICY_VERSION, so telemetry can tune them.
 * Percent used is only ever a share of a provider's own plan window. It is never
 * derived from tokens, cost or helper counts, and two plans' percents say nothing
 * about equal absolute capacity.
 */

import { QUOTA_NEAR_LIMIT_PERCENT, type HelperRoutingReason, type QuotaState, type QuotaUnknownReason } from '../../shared/helper-routing';

export const AUTO_COOLDOWN_AUTH_MS = 10 * 60_000;
export const AUTO_COOLDOWN_QUOTA_MS = 30 * 60_000;
export const AUTO_COOLDOWN_AVAILABILITY_MS = 5 * 60_000;

/**
 * The weekly window's length. Both readers name a window `week` only when the
 * provider declares it seven days (Claude's `seven_day`, Codex's 10080 minutes),
 * so this is the provider's figure, not a guess.
 */
export const AUTO_WEEK_MS = 7 * 24 * 60 * 60_000;

/** Pressures this close (basis points) count as a tie. 0: only an equal reading ties. */
export const AUTO_TIE_BAND_BP = 0;
/** Legacy interval-proxy inputs stay off. Production explicitly enables only qualified aggregate pressure. */
export const AUTO_USE_BURN_FORECASTS = false;

/**
 * - `weekly_used`: lower weekly percent used wins.
 * - `reset_schedule`: lower weekly percent used, less the share of the week
 *   already gone, wins: a plan that resets sooner has more left to use before
 *   it's lost. Used only when every measured candidate has a reset inside one
 *   week from now; otherwise the decision falls back to `weekly_used`. With equal
 *   resets it orders exactly as `weekly_used` does.
 */
export type AutoScoreBasis = 'weekly_used' | 'reset_schedule';

export interface AutoPolicyOptions {
  basis?: AutoScoreBasis;
  tieBandBp?: number;
  useBurnForecasts?: boolean;
}

export type AutoSkipReason = 'cli_disabled' | 'cli_unavailable' | 'auto_disabled' | 'no_valid_mapping' | 'cooling_down' | 'quota_near_limit' | 'quota_exhausted';

/**
 * In order of preference. `headroom`: under the low mark on every counted window,
 * with a weekly reading. `unmeasured`: no weekly reading, so its capacity is
 * unknown; it's used only when no measured provider has headroom left, and is
 * never scored. `low`: some counted window, the 5-hour or the mapped model's
 * included, is past the low mark. Short and model windows constrain; they aren't
 * added to the weekly figure. `last_resort`: quota cannot be read at all
 * (`not_supported`), so it waits behind every other eligible tier.
 */
export const AUTO_TIERS = ['headroom', 'unmeasured', 'low', 'last_resort'] as const;
export type AutoTier = (typeof AUTO_TIERS)[number];

export interface AutoCandidate {
  /**
   * The provider this would run under, on its one local login. A proxy for a
   * subscription, never more.
   */
  key: string;
  provider: string;
  /** From every window that counts for the mapped model: weekly, 5-hour and the model's own. */
  quotaState: QuotaState;
  quotaUnknownReason?: QuotaUnknownReason;
  /** The provider's weekly window, as read. Absent when there is none. */
  weekly?: { usedPercent: number | null; resetsAtMs: number | null };
  /** False when the model list may be out of date, so the mapping couldn't be checked. Ranks behind one that could. */
  verified: boolean;
  /** Helpers on this provider now: live ones and reservations. Load, not consumption. */
  load: number;
  /** Qualified mean remaining pressure for this subscription group, including the proposed start. */
  expectedBurnBp?: number;
  /** One calibrated aggregate for active work plus this start, strictly beyond the quota sample. */
  remainingPressure?: Array<{ usedBp: number; upperBp: number }>;
}

export interface AutoPolicyInput {
  now: number;
  /** Those still eligible after the checks that need no comparison. Order doesn't matter. */
  candidates: readonly AutoCandidate[];
  /** The last key chosen for each tie set, by {@link tieSetKey}. */
  cursors: Readonly<Record<string, string>>;
  options?: AutoPolicyOptions;
}

export interface AutoScore {
  basis: AutoScoreBasis | 'unmeasured';
  weeklyUsedBp?: number;
  cyclePhaseBp?: number;
  targetBp?: number;
  pressureBp?: number;
}

export interface AutoEvaluation {
  key: string;
  provider: string;
  excluded?: Extract<AutoSkipReason, 'quota_exhausted' | 'quota_near_limit'>;
  tier?: AutoTier;
  verified: boolean;
  load: number;
  score: AutoScore;
  /** 0 = best, among those not excluded. */
  rank?: number;
}

export interface AutoTie {
  /** Every key that tied, sorted. */
  set: string[];
  bandBp: number;
  /** Load decided among them. */
  byLoad: boolean;
  /** Present when more than one stayed tied after load: the rotation decided. */
  cursorKey?: string;
  cursorBefore?: string;
  cursorAfter?: string;
}

export type AutoDecision =
  | { ok: true; key: string; provider: string; reason: HelperRoutingReason; basis: AutoScoreBasis; tier: AutoTier; evaluations: AutoEvaluation[]; tie: AutoTie }
  | { ok: false; basis: AutoScoreBasis; evaluations: AutoEvaluation[] };

/** The rotation state's key for a set of tied candidates: the same set always gets the same key. */
export function tieSetKey(keys: readonly string[]): string {
  return JSON.stringify([...keys].sort());
}

function weeklyUsed(c: AutoCandidate): number | undefined {
  const used = c.weekly?.usedPercent;
  return typeof used === 'number' && Number.isFinite(used) ? used : undefined;
}

function tierOf(c: AutoCandidate): AutoTier {
  if (c.quotaState === 'unknown' && c.quotaUnknownReason === 'not_supported') return 'last_resort';
  if (c.quotaState === 'low') return 'low';
  return c.quotaState === 'known' && weeklyUsed(c) !== undefined ? 'headroom' : 'unmeasured';
}

/** The share of the week gone, when the reset is a real one inside the coming week. */
function cyclePhaseBp(c: AutoCandidate, now: number): number | undefined {
  const resetsAt = c.weekly?.resetsAtMs;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  const left = resetsAt - now;
  if (left <= 0 || left > AUTO_WEEK_MS) return undefined;
  return Math.round(10_000 * (1 - left / AUTO_WEEK_MS));
}

function scoreOf(c: AutoCandidate, now: number, basis: AutoScoreBasis, useForecasts: boolean): AutoScore {
  const used = weeklyUsed(c);
  if (used === undefined) return { basis: 'unmeasured' };
  const weeklyUsedBp = Math.round(used * 100);
  // Excluded, or without a usable state: the reading is kept, but nothing ranks on it.
  if (tierOf(c) === 'unmeasured' || tierOf(c) === 'last_resort') return { basis: 'unmeasured', weeklyUsedBp };
  const expected = useForecasts ? c.expectedBurnBp : undefined;
  const burn = useForecasts && typeof expected === 'number' && Number.isFinite(expected) && expected >= 0 && expected <= 10_000 ? Math.round(expected) : 0;
  if (basis === 'weekly_used') return { basis, weeklyUsedBp, pressureBp: weeklyUsedBp + burn };
  const phase = cyclePhaseBp(c, now)!;
  return { basis, weeklyUsedBp, cyclePhaseBp: phase, targetBp: phase, pressureBp: weeklyUsedBp - phase + burn };
}

/**
 * Exhausted and near the limit are out. Then the best tier, verified mappings
 * ahead of unverified ones. In it, the lowest pressure wins; candidates within
 * the tie band of it tie, and so do all unmeasured ones, since nothing ranks them.
 * Among a tie the lowest load wins, then the rotation: the key after the one this
 * same set chose last, in sorted order.
 */
export function decideAutoProvider(input: AutoPolicyInput): AutoDecision {
  const { now, candidates, cursors } = input;
  const useForecasts = input.options?.useBurnForecasts ?? AUTO_USE_BURN_FORECASTS;
  const bandBp = Math.max(0, input.options?.tieBandBp ?? AUTO_TIE_BAND_BP);
  const measured = candidates.filter((c) => tierOf(c) !== 'unmeasured' && tierOf(c) !== 'last_resort');
  const wanted = input.options?.basis ?? 'weekly_used';
  const basis: AutoScoreBasis = wanted === 'reset_schedule' && measured.every((c) => cyclePhaseBp(c, now) !== undefined) ? 'reset_schedule' : 'weekly_used';

  const evaluations: AutoEvaluation[] = candidates.map((c) => {
    const base = { key: c.key, provider: c.provider, verified: c.verified, load: c.load, score: scoreOf(c, now, basis, useForecasts) };
    if (c.quotaState === 'exhausted') return { ...base, excluded: 'quota_exhausted' as const };
    if (c.quotaState === 'near_limit') return { ...base, excluded: 'quota_near_limit' as const };
    if (useForecasts && c.remainingPressure?.some((w) => Number.isFinite(w.usedBp) && Number.isFinite(w.upperBp)
      && w.upperBp >= 0 && w.upperBp <= 10_000 && w.usedBp >= 0 && w.usedBp <= 10_000 && w.usedBp + w.upperBp >= QUOTA_NEAR_LIMIT_PERCENT * 100)) {
      return { ...base, excluded: 'quota_near_limit' as const };
    }
    return { ...base, tier: tierOf(c) };
  });
  const usable = evaluations.filter((e) => !e.excluded);
  if (usable.length === 0) return { ok: false, basis, evaluations };

  const order = (e: AutoEvaluation) => AUTO_TIERS.indexOf(e.tier!) * 2 + (e.verified ? 0 : 1);
  const ranked = [...usable].sort((a, b) => order(a) - order(b) || (a.score.pressureBp ?? 0) - (b.score.pressureBp ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  ranked.forEach((e, i) => { e.rank = i; });
  const best = ranked[0];
  const group = ranked.filter((e) => order(e) === order(best));
  const tied = best.tier === 'unmeasured' || best.tier === 'last_resort'
    ? group
    : group.filter((e) => (e.score.pressureBp ?? 0) - (best.score.pressureBp ?? 0) <= bandBp);

  const lightest = Math.min(...tied.map((e) => e.load));
  const light = tied.filter((e) => e.load === lightest);
  const set = tied.map((e) => e.key).sort();
  const tie: AutoTie = { set, bandBp, byLoad: light.length < tied.length };
  let chosen = light[0];
  if (light.length > 1) {
    const cursorKey = tieSetKey(set);
    const before = cursors[cursorKey];
    const from = before === undefined ? -1 : set.indexOf(before);
    const lightKeys = new Set(light.map((e) => e.key));
    const next = [...set.slice(from + 1), ...set.slice(0, from + 1)].find((key) => lightKeys.has(key))!;
    chosen = light.find((e) => e.key === next)!;
    Object.assign(tie, { cursorKey, ...(before !== undefined && { cursorBefore: before }), cursorAfter: next });
  }

  const reason: HelperRoutingReason = best.tier === 'last_resort' ? 'last_resort_unmeasured'
    : candidates.length === 1 ? 'only_candidate'
    : best.tier === 'unmeasured' && measured.some((c) => c.quotaState !== 'exhausted' && c.quotaState !== 'near_limit') ? 'unknown_fallback'
      : tie.cursorKey ? 'fair_rotation'
        : tie.byLoad ? 'lower_load'
          : group.length > tied.length ? 'lower_pressure'
            : 'better_quota_tier';
  return { ok: true, key: chosen.key, provider: chosen.provider, reason, basis, tier: chosen.tier!, evaluations, tie };
}
