/**
 * How Auto picks a provider for a helper (#2671, docs/helper-auto-routing.md).
 * Pure and deterministic, so a decision can be explained and tested.
 *
 * Every number here is a tunable starting proposal, not a measured value. Each
 * decision records HELPER_ROUTING_POLICY_VERSION, so telemetry can tune them.
 *
 * This balances how many helpers each provider runs. It says nothing about cost:
 * percent used is only ever compared within a provider's own plan.
 */

import type { HelperRoutingReason, QuotaState } from '../../shared/helper-routing';

/** Leave the anchor only for a provider at least this many helpers lighter. */
export const AUTO_LOAD_MARGIN = 2;
/** A provider stays the anchor for this long after the last Auto choice for that orchestrator and difficulty. */
export const AUTO_STICKY_MS = 30 * 60_000;
/** The backstop on a reservation that was never released. */
export const AUTO_RESERVATION_MS = 5 * 60_000;
export const AUTO_COOLDOWN_AUTH_MS = 10 * 60_000;
export const AUTO_COOLDOWN_QUOTA_MS = 30 * 60_000;
export const AUTO_COOLDOWN_AVAILABILITY_MS = 5 * 60_000;

export type AutoSkipReason = 'cli_disabled' | 'cli_unavailable' | 'no_valid_mapping' | 'cooling_down' | 'quota_near_limit' | 'quota_exhausted';

export interface AutoCandidate {
  provider: string;
  quotaState: QuotaState;
  /** Its model list may be out of date, so its preset couldn't be checked. Ranks behind one that could. */
  unverified?: boolean;
}

export interface AutoDecisionInput {
  /** Those still eligible after the checks that need no comparison, in registration order. */
  candidates: readonly AutoCandidate[];
  /** Helpers per provider, reservations included. */
  load: Readonly<Record<string, number>>;
  orchestratorCli?: string;
  /** The provider last chosen for this orchestrator and difficulty, if that hasn't expired. */
  sticky?: string;
}

export type AutoDecision =
  | { ok: true; provider: string; reason: HelperRoutingReason; skipped: Record<string, AutoSkipReason> }
  | { ok: false; skipped: Record<string, AutoSkipReason> };

/**
 * Near the limit and exhausted are out. `known` and `unknown` share the best
 * tier, so a login that can't report isn't starved, though it stays unknown in
 * everything shown. `low` is used only if nothing better is left. Within the tier
 * the anchor (sticky, else the orchestrator's CLI, else registration order) holds
 * unless another provider is {@link AUTO_LOAD_MARGIN} lighter.
 */
export function decideAutoProvider(input: AutoDecisionInput): AutoDecision {
  const skipped: Record<string, AutoSkipReason> = {};
  const usable: AutoCandidate[] = [];
  for (const candidate of input.candidates) {
    if (candidate.quotaState === 'exhausted') skipped[candidate.provider] = 'quota_exhausted';
    else if (candidate.quotaState === 'near_limit') skipped[candidate.provider] = 'quota_near_limit';
    else usable.push(candidate);
  }
  if (usable.length === 0) return { ok: false, skipped };
  const best = usable.filter((c) => c.quotaState !== 'low');
  const quotaTier = best.length > 0 ? best : usable;
  const verified = quotaTier.filter((c) => !c.unverified);
  const tier = verified.length > 0 ? verified : quotaTier;
  const inTier = (provider: string | undefined) => !!provider && tier.some((c) => c.provider === provider);
  const anchor = inTier(input.sticky) ? input.sticky! : inTier(input.orchestratorCli) ? input.orchestratorCli! : tier[0].provider;
  const loadOf = (provider: string) => input.load[provider] ?? 0;
  const lighter = tier.filter((c) => loadOf(anchor) - loadOf(c.provider) >= AUTO_LOAD_MARGIN);
  const moved = [...lighter].sort((a, b) => loadOf(a.provider) - loadOf(b.provider))[0];
  const provider = moved?.provider ?? anchor;
  const stoodDown = usable.length > quotaTier.length;
  const reason: HelperRoutingReason = usable.length === 1 && input.candidates.length === 1 ? 'only_candidate'
    : moved ? 'lower_load'
      : stoodDown ? 'better_quota_tier'
        : anchor === input.sticky ? 'sticky' : 'default_order';
  return { ok: true, provider, reason, skipped };
}
