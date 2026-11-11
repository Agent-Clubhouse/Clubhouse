/**
 * A fake-clock replay of Auto's policy (#2887), for tests: subscriptions with
 * their own plan sizes and reset times, helpers that use some of a plan while
 * they run, and quota readings that lag behind. Nothing here is a policy input.
 * `capacity` and `work` are the simulated provider's own truth, used only to
 * turn work into the percent a reading would show; the policy sees only that
 * percent, as it would from a CLI.
 */

import { QUOTA_LOW_PERCENT, QUOTA_NEAR_LIMIT_PERCENT, type QuotaState, type QuotaUnknownReason } from '../../../shared/helper-routing';
import { AUTO_WEEK_MS, decideAutoProvider, type AutoCandidate, type AutoDecision, type AutoPolicyOptions } from '../helper-auto-policy';

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

export interface SimSubscription {
  key: string;
  provider: string;
  /** Work a week's plan allows, in the simulator's own units. */
  capacity: number;
  /** The first reset. Later ones follow a week apart. */
  resetsAt: number;
  /** Already used at the start, in work units. */
  used?: number;
  /** Its readings can't be had: the policy sees `unknown`. */
  unreadable?: boolean;
  unknownReason?: QuotaUnknownReason;
  /** Use from outside Clubhouse, in work units per hour. */
  outsidePerHour?: number;
  /** When it can be chosen: a provider removed, then back. Default always. */
  available?: (t: number) => boolean;
}

export interface SimConfig {
  subscriptions: SimSubscription[];
  start: number;
  end: number;
  tickMs: number;
  /** Helpers asking to start in the tick beginning at `t`. */
  arrivals: (t: number) => number;
  /** What one helper uses over its run. */
  work: number;
  runMs: number;
  /** How old a reading may be. 0: every decision sees the true value. */
  sampleEveryMs: number;
  options?: AutoPolicyOptions;
  /** The rotation's saved state, as a restart would find it. */
  cursors?: Record<string, string>;
}

export interface SimResult {
  picks: Record<string, number>;
  /** In order, for checking rotation. */
  sequence: string[];
  refused: number;
  reasons: Record<string, number>;
  /** Largest gap in true weekly percent used between any two subscriptions, sampled each tick, basis points. */
  maxSpreadBp: number;
  /** Mean of that gap over the run, basis points. */
  meanSpreadBp: number;
  /** Percent of each plan left unused at each of its resets. */
  unusedAtReset: Record<string, number[]>;
  /** The least headroom any subscription had, in percent of its own plan. */
  minHeadroomPercent: number;
  /** When each subscription first reached its limit. */
  exhaustedAt: Record<string, number>;
  /** Decisions that chose an unmeasured subscription. */
  unknownChosen: number;
  decisions: AutoDecision[];
  /** The rotation at the end, as a clean shutdown would have saved it. */
  cursors: Record<string, string>;
}

interface Running { key: string; from: number; until: number; rate: number }

function stateFor(percent: number, limitReached: boolean): QuotaState {
  if (limitReached) return 'exhausted';
  if (percent >= QUOTA_NEAR_LIMIT_PERCENT) return 'near_limit';
  return percent >= QUOTA_LOW_PERCENT ? 'low' : 'known';
}

export function runReplay(config: SimConfig): SimResult {
  const subs = config.subscriptions.map((s) => ({ ...s, used: s.used ?? 0, resetsAt: s.resetsAt }));
  const seen = new Map<string, { percent: number; resetsAt: number; at: number }>();
  const running: Running[] = [];
  const cursors: Record<string, string> = { ...(config.cursors ?? {}) };
  const result: SimResult = {
    picks: Object.fromEntries(subs.map((s) => [s.key, 0])), sequence: [], refused: 0, reasons: {},
    maxSpreadBp: 0, meanSpreadBp: 0, unusedAtReset: Object.fromEntries(subs.map((s): [string, number[]] => [s.key, []])),
    minHeadroomPercent: 100, exhaustedAt: {}, unknownChosen: 0, decisions: [], cursors,
  };
  let spreadSum = 0;
  let ticks = 0;
  const truePercent = (s: (typeof subs)[number]) => (100 * s.used) / s.capacity;

  for (let t = config.start; t < config.end; t += config.tickMs) {
    for (const s of subs) {
      while (t >= s.resetsAt) {
        result.unusedAtReset[s.key].push(Math.max(0, 100 - truePercent(s)));
        s.used = 0;
        s.resetsAt += AUTO_WEEK_MS;
        seen.delete(s.key);
      }
    }
    for (const s of subs) {
      if (s.used >= s.capacity && result.exhaustedAt[s.key] === undefined) result.exhaustedAt[s.key] = t;
      const last = seen.get(s.key);
      if (!last || config.sampleEveryMs === 0 || t - last.at >= config.sampleEveryMs) seen.set(s.key, { percent: Math.round(truePercent(s)), resetsAt: s.resetsAt, at: t });
    }

    for (let n = config.arrivals(t); n > 0; n--) {
      const candidates: AutoCandidate[] = subs.filter((s) => s.available?.(t) ?? true).map((s) => {
        const load = running.filter((r) => r.key === s.key).length;
        if (s.unreadable) return { key: s.key, provider: s.provider, quotaState: 'unknown', quotaUnknownReason: s.unknownReason ?? 'read_failed', verified: true, load };
        const reading = seen.get(s.key)!;
        return {
          key: s.key, provider: s.provider, verified: true, load,
          quotaState: stateFor(reading.percent, s.used >= s.capacity),
          weekly: { usedPercent: reading.percent, resetsAtMs: reading.resetsAt },
        };
      });
      const decision = decideAutoProvider({ now: t, candidates, cursors, ...(config.options && { options: config.options }) });
      result.decisions.push(decision);
      if (!decision.ok) { result.refused++; continue; }
      if (decision.tie.cursorKey && decision.tie.cursorAfter) cursors[decision.tie.cursorKey] = decision.tie.cursorAfter;
      result.picks[decision.key]++;
      result.sequence.push(decision.key);
      result.reasons[decision.reason] = (result.reasons[decision.reason] ?? 0) + 1;
      if (decision.tier === 'unmeasured' || decision.tier === 'last_resort') result.unknownChosen++;
      running.push({ key: decision.key, from: t, until: t + config.runMs, rate: config.work / config.runMs });
    }

    // Use over [t, t + tick): running helpers, then outside use, never past the plan.
    const next = t + config.tickMs;
    for (const r of running) {
      const s = subs.find((x) => x.key === r.key)!;
      s.used = Math.min(s.capacity, s.used + r.rate * Math.max(0, Math.min(next, r.until) - Math.max(t, r.from)));
    }
    for (const s of subs) if (s.outsidePerHour) s.used = Math.min(s.capacity, s.used + (s.outsidePerHour * config.tickMs) / HOUR);
    for (let i = running.length - 1; i >= 0; i--) if (running[i].until <= next) running.splice(i, 1);

    const measured = subs.filter((s) => !s.unreadable);
    if (measured.length > 1) {
      const percents = measured.map(truePercent);
      const spread = Math.round(100 * (Math.max(...percents) - Math.min(...percents)));
      result.maxSpreadBp = Math.max(result.maxSpreadBp, spread);
      spreadSum += spread;
    }
    for (const s of measured) result.minHeadroomPercent = Math.min(result.minHeadroomPercent, 100 - truePercent(s));
    ticks++;
  }
  result.meanSpreadBp = ticks > 0 ? Math.round(spreadSum / ticks) : 0;
  return result;
}
