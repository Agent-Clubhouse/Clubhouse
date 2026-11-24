// Typings for usage-rollup.mjs.

export type UsageRollupDimension = 'day' | 'provider' | 'driver' | 'model' | 'effort' | 'role' | 'agentId' | 'parentAgentId' | 'source';
export type UsageRollupFigure = 'input' | 'cachedInput' | 'cacheWrite' | 'output' | 'reasoning';

export declare const USAGE_ROLLUP_DIMENSIONS: readonly UsageRollupDimension[];
export declare const USAGE_ROLLUP_FIGURES: readonly UsageRollupFigure[];

export interface UsageRollupTotals extends Record<UsageRollupFigure, number> {
  turns: number;
  /** Turns that reported no figure at all. */
  turnsWithoutUsage: number;
  /** Input minus cached input, from turns that report both. */
  uncachedInput: number;
  /** Per figure, the turns that didn't report it. */
  missing: Partial<Record<UsageRollupFigure, number>>;
  /** Turns per usage source (provider_turn, summed_calls, cumulative_delta, unknown). */
  sources: Record<string, number>;
}

export type UsageRollupRow = Partial<Record<UsageRollupDimension, string>> & UsageRollupTotals;

export interface UsageRollup {
  groupBy: UsageRollupDimension[];
  rows: UsageRollupRow[];
  totals: UsageRollupTotals;
  /** Session total lines seen and, by design, not added. */
  sessionTotalsSkipped: number;
  /** Turn lines already counted (same agent, session and turn id). */
  repeats: number;
  malformed: number;
}

export declare function rollupUsage(
  records: Iterable<unknown>,
  options?: { groupBy?: UsageRollupDimension[]; since?: string; until?: string },
): UsageRollup;
