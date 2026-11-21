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

import { QUOTA_LOW_PERCENT, QUOTA_NEAR_LIMIT_PERCENT, QUOTA_STALE_MS, type HelperRoutingReason, type QuotaState, type QuotaUnknownReason } from '../../shared/helper-routing';
import { isRetainedPercent, AUTO_RESERVE_PROVIDERS, type AutoBudgetQuota, type AutoBudgetReceipt, type AutoBudgetRules } from '../../shared/helper-auto-budget';

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
  /** Absent is byte-for-byte legacy behavior. Pending restrictions can enforce admission without enabling urgency. */
  budget?: AutoBudgetRules;
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
  remainingPressure?: Array<{ name?: AutoBudgetQuota['windows'][number]['name']; resetsAtMs?: number; usedBp: number; upperBp: number }>;
  budgetQuota?: AutoBudgetQuota;
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
  excluded?: 'quota_exhausted' | 'quota_near_limit' | 'auto_reserve' | 'quota_incomplete' | 'auto_budget_invalid';
  budget?: AutoBudgetReceipt;
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
  return input.options?.budget ? decideBudgetAutoProvider(input, input.options.budget) : decideLegacyAutoProvider(input);
}

function decideLegacyAutoProvider(input: AutoPolicyInput): AutoDecision {
  const { now, candidates, cursors } = input;
  const useForecasts = input.options?.useBurnForecasts ?? AUTO_USE_BURN_FORECASTS;
  const bandBp = Math.max(0, input.options?.tieBandBp ?? AUTO_TIE_BAND_BP);
  const measured = candidates.filter((c) => tierOf(c) !== 'unmeasured' && tierOf(c) !== 'last_resort');
  // Missing mean coverage cannot be treated as zero burn against another provider's qualified mean.
  const comparableForecasts = useForecasts && measured.filter((c) => c.quotaState !== 'exhausted' && c.quotaState !== 'near_limit')
    .every((c) => typeof c.expectedBurnBp === 'number' && Number.isFinite(c.expectedBurnBp) && c.expectedBurnBp >= 0 && c.expectedBurnBp <= 10_000);
  const wanted = input.options?.basis ?? 'weekly_used';
  const basis: AutoScoreBasis = wanted === 'reset_schedule' && measured.every((c) => cyclePhaseBp(c, now) !== undefined) ? 'reset_schedule' : 'weekly_used';

  const evaluations: AutoEvaluation[] = candidates.map((c) => {
    const base = { key: c.key, provider: c.provider, verified: c.verified, load: c.load, score: scoreOf(c, now, basis, comparableForecasts) };
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

/** Calendar-based opt-in. No historical rate collection, fabricated forecast or extra provider read. */
function decideBudgetAutoProvider(input: AutoPolicyInput, rules: AutoBudgetRules): AutoDecision {
  const validBp = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10_000;
  const enabledForecasts = input.options?.useBurnForecasts ?? AUTO_USE_BURN_FORECASTS;
  const invalid = rules.mode === 'invalid' || AUTO_RESERVE_PROVIDERS.some((p) => !isRetainedPercent(rules.reserves[p]));
  const evaluations: AutoEvaluation[] = [];
  const admitted: AutoCandidate[] = [];
  for (const c of input.candidates) {
    const e: AutoEvaluation = { key: c.key, provider: c.provider, verified: c.verified, load: c.load,
      score: scoreOf(c, input.now, 'weekly_used', false) };
    evaluations.push(e);
    if (invalid) {
      e.excluded = 'auto_budget_invalid';
      e.budget = { mode: 'invalid', urgency: 'none', forecast: 'unavailable', block: 'invalid_policy' };
      continue;
    }
    const quota = c.budgetQuota;
    if (c.quotaState === 'exhausted' || quota?.windows.some((w) => w.limitReached)) { e.excluded = 'quota_exhausted'; continue; }
    // Copilot has no quota reader. Preserve its distinct, unscored last-resort status and saved allowance.
    if (c.provider === 'copilot-cli' && c.quotaState === 'unknown' && c.quotaUnknownReason === 'not_supported') {
      e.tier = 'last_resort'; e.score = { basis: 'unmeasured' }; admitted.push(c); continue;
    }
    const provider = AUTO_RESERVE_PROVIDERS.find((p) => p === c.provider);
    const retained = provider ? rules.reserves[provider] : undefined;
    e.budget = { mode: rules.mode, ...(retained !== undefined && { retainedPercent: retained, ceilingBp: 10_000 - retained * 100 }),
      urgency: 'none', forecast: 'unavailable' };
    if (!provider || !quota || !quota.complete || c.quotaState === 'unknown'
      || !Number.isFinite(quota.asOfMs) || quota.asOfMs! > input.now || input.now - quota.asOfMs! > QUOTA_STALE_MS
      || !quota.windows.length || quota.windows.some((w) => !validBp(w.usedBp)
        || (w.resetsAtMs !== undefined && (!Number.isFinite(w.resetsAtMs) || w.resetsAtMs <= input.now)))) {
      e.excluded = 'quota_incomplete'; e.budget.block = 'incomplete_quota'; continue;
    }
    const ceiling = e.budget.ceilingBp!;
    if (quota.windows.some((w) => w.usedBp! >= ceiling)) {
      e.excluded = 'auto_reserve'; e.budget.block = 'observed_reserve'; continue;
    }
    // A single aggregate beyond this exact sample must cover EVERY applicable window. Unknown is not zero.
    const bounds = c.remainingPressure;
    const qualified = enabledForecasts && !!bounds?.length && quota.windows.every((w) =>
      bounds.some((b) => b.name === w.name && b.usedBp === w.usedBp && w.resetsAtMs !== undefined && b.resetsAtMs === w.resetsAtMs && validBp(b.upperBp)));
    if (qualified) {
      e.budget.forecast = 'qualified';
      if (quota.windows.some((w) => w.usedBp! + bounds!.find((b) => b.name === w.name && b.usedBp === w.usedBp && b.resetsAtMs === w.resetsAtMs)!.upperBp >= ceiling)) {
        e.excluded = 'auto_reserve'; e.budget.block = 'predicted_reserve'; continue;
      }
    }
    const weekly = quota.windows.find((w) => w.name === 'weekly');
    const left = weekly?.resetsAtMs === undefined ? undefined : weekly.resetsAtMs - input.now;
    if (weekly) e.budget.usableBp = Math.max(0, ceiling - weekly.usedBp!);
    if (left !== undefined && left > 0 && left <= AUTO_WEEK_MS) {
      e.budget.resetsAtMs = weekly!.resetsAtMs;
      if (rules.mode === 'reset_aware' && c.verified && e.budget.usableBp! > 0) {
        e.budget.urgency = left <= 24 * 60 * 60_000 ? 'within_24h' : left <= 48 * 60 * 60_000 ? 'within_48h' : 'none';
      }
    }
    const low = quota.windows.some((w) => w.usedBp! >= QUOTA_LOW_PERCENT * 100);
    const measured = weekly !== undefined && weeklyUsed(c) !== undefined;
    e.tier = low ? 'low' : measured ? 'headroom' : 'unmeasured';
    admitted.push({ ...c, quotaState: low ? 'low' : 'known',
      // Admission has already enforced the user's configured reserve. Do not reapply legacy's different 95% reserve.
      remainingPressure: undefined, expectedBurnBp: qualified ? c.expectedBurnBp : undefined });
  }

  const urgency = (e: AutoEvaluation) => e.budget?.urgency === 'within_24h' ? 2 : e.budget?.urgency === 'within_48h' ? 1 : 0;
  const eligible = evaluations.filter((e) => !e.excluded);
  const band = Math.max(0, ...eligible.map(urgency));
  let peers = admitted;
  if (band > 0) {
    const urgent = eligible.filter((e) => urgency(e) === band);
    const reset = Math.min(...urgent.map((e) => e.budget!.resetsAtMs!));
    const keys = new Set(urgent.filter((e) => e.budget!.resetsAtMs === reset).map((e) => e.key));
    peers = admitted.filter((c) => keys.has(c.key)).map((c) => ({ ...c, quotaState: 'known' }));
  }
  const decision = decideLegacyAutoProvider({ ...input, candidates: peers,
    options: { ...input.options, basis: 'weekly_used' } });
  for (const comparison of decision.evaluations) {
    const original = evaluations.find((e) => e.key === comparison.key)!;
    original.score = comparison.score;
    if (comparison.rank !== undefined) original.rank = comparison.rank;
  }
  if (!decision.ok) return { ...decision, evaluations };
  return { ...decision, evaluations, tier: evaluations.find((e) => e.key === decision.key)!.tier!,
    reason: band > 0 ? 'reset_urgency' : decision.reason };
}
