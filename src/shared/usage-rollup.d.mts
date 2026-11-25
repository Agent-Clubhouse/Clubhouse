// Typings for usage-rollup.mjs.

export type UsageRollupDimension = 'day' | 'provider' | 'driver' | 'model' | 'effort' | 'role' | 'agentId' | 'parentAgentId' | 'source';
export type UsageRollupFigure = 'input' | 'cachedInput' | 'cacheWrite' | 'output' | 'reasoning';

export declare const USAGE_ROLLUP_DIMENSIONS: readonly UsageRollupDimension[];
export declare const USAGE_ROLLUP_FIGURES: readonly UsageRollupFigure[];

/** Each figure summed over the turns that reported it; `null` when none did (never shown as 0). */
export interface UsageRollupTotals extends Record<UsageRollupFigure, number | null> {
  turns: number;
  /** Turns that reported no figure at all. */
  turnsWithoutUsage: number;
  /** Turns whose line had no turn id: added, but a repeat of one can't be detected. */
  turnsWithoutId: number;
  /** Input minus cached input, from turns that report both; `null` when none did. */
  uncachedInput: number | null;
  /** Per figure, the turns that didn't report it. */
  missing: Partial<Record<UsageRollupFigure, number>>;
  /** Turns per usage source (provider_turn, summed_calls, cumulative_delta, unknown). */
  sources: Record<string, number>;
}

export type UsageRollupRow = Partial<Record<UsageRollupDimension, string>> & UsageRollupTotals;

export interface UsageRollup {
  groupBy: UsageRollupDimension[];
  rows: UsageRollupRow[];
  /** Rows for each `alsoGroupBy` grouping, from the same pass, in order. */
  also: UsageRollupRow[][];
  totals: UsageRollupTotals;
  /** No turn line was found (logging off, nothing ran, or a build without usage lines): not zero use. */
  noLines: boolean;
  /** Session total lines seen and, by design, not added. */
  sessionTotalsSkipped: number;
  /** Turn lines already counted (same agent, session and turn id). */
  repeats: number;
  /** Unreadable usage lines, and usage lines without their fields. */
  malformed: number;
}

export declare function rollupUsage(
  records: Iterable<unknown>,
  options?: { groupBy?: UsageRollupDimension[]; alsoGroupBy?: UsageRollupDimension[][]; since?: string; until?: string },
): UsageRollup;
