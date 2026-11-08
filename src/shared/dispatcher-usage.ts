/**
 * What the Dispatcher used, split into conversations and background work
 * (#3040). Background work is what it does on its own: Clubhouse's hidden
 * memory upkeep and check-ins, and the Actions it set up for itself. Every
 * other turn, the user's chat and the work it hands over, is a conversation.
 *
 * Main counts the turns from chat events (services/dispatcher/dispatcher-usage.ts);
 * Settings › Dispatcher and Details › Today read the split, and telemetry
 * (#3052) reads the same numbers. No UI names how the work is divided between
 * its agents.
 */

/** Which side of the split a turn counts toward. */
export type DispatcherUsageKind = 'conversations' | 'background';

export const DISPATCHER_USAGE_KINDS: readonly DispatcherUsageKind[] = ['conversations', 'background'];

/**
 * Totals for one side of the split. Token figures add up what the provider
 * reported; a turn that reported nothing is counted in `turnsWithoutUsage`
 * instead of as zero.
 */
export interface DispatcherUsageTotals {
  turns: number;
  turnsWithoutUsage: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** Dollars, from providers that report a cost. */
  costUsd: number;
  /** True when any of the cost is an API-price estimate (e.g. on a subscription). */
  costIsEstimate: boolean;
}

export interface DispatcherUsageSplit {
  /** The local calendar day, `YYYY-MM-DD`. */
  day: string;
  conversations: DispatcherUsageTotals;
  background: DispatcherUsageTotals;
}

export function emptyUsageTotals(): DispatcherUsageTotals {
  return { turns: 0, turnsWithoutUsage: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, costIsEstimate: false };
}

export function emptyUsageSplit(day: string): DispatcherUsageSplit {
  return { day, conversations: emptyUsageTotals(), background: emptyUsageTotals() };
}
