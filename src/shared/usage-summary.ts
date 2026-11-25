/**
 * What Settings › Usage shows (docs/usage-attribution.md): each provider's
 * plan limits as the provider reports them, and the tokens Clubhouse's agents
 * used, from the local `core:usage` log lines. A limit a provider can't report
 * is `unknown`, never a percentage; a figure no turn reported is `null`, never 0.
 */
import type { QuotaView } from './helper-routing';
import type { UsageRollupTotals } from './usage-rollup.mjs';

/** Days of usage the page can ask for: today (UTC) or the last seven. */
export const USAGE_SUMMARY_DAYS = [1, 7] as const;
export type UsageSummaryDays = (typeof USAGE_SUMMARY_DAYS)[number];

export interface UsageSummaryProvider {
  id: string;
  name: string;
  /** Whether Clubhouse can read the provider's plan limits without spending tokens. */
  quotaKind: 'reader' | 'unknown';
  /** Absent for a provider whose limits can't be read. */
  quota?: QuotaView;
  /** Tokens its agents used in the period. Absent when none of its turns were logged. */
  usage?: UsageRollupTotals;
}

export interface UsageSummary {
  days: UsageSummaryDays;
  /** First UTC day counted, `YYYY-MM-DD`. */
  since: string;
  providers: UsageSummaryProvider[];
  /** Turns by agent role (dispatcher, orchestrator, helper, quick, agent, unknown). */
  roles: Array<{ role: string } & UsageRollupTotals>;
  /** Usage from providers with no descriptor (an id Clubhouse doesn't know). */
  otherProviders: Array<{ provider: string } & UsageRollupTotals>;
  /** No usage line was found for the period: logging off, nothing ran, or older builds. Not zero use. */
  noLines: boolean;
  /** Whether the logging settings let usage lines be written now (logging on, `core:usage` on, level info or lower). */
  linesRecorded: boolean;
}
