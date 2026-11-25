/**
 * Plain text for Settings › Usage. A limit the provider can't report, or a
 * figure no turn reported, reads "unknown": never a percentage, never 0.
 */
import { formatTokenCount } from '../../../shared/dispatcher-settings-page';
import type { QuotaView, QuotaWindowView } from '../../../shared/helper-routing';
import type { UsageRollupTotals } from '../../../shared/usage-rollup.mjs';

const WINDOW_NAMES: Record<string, string> = { weekly: 'weekly limit', fiveHour: '5-hour limit' };

function day(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? undefined : at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** "62% of the weekly limit used, resets Mon 9:00 AM", or "unknown". */
export function quotaText(kind: 'reader' | 'unknown', quota: QuotaView | undefined): string {
  if (kind === 'unknown' || !quota || quota.state === 'unknown') return 'unknown';
  const name = quota.limitingWindow;
  const window: QuotaWindowView | null | undefined = name === 'weekly' ? quota.weekly : name === 'fiveHour' ? quota.fiveHour : undefined;
  if (!name || !window || window.usedPercent === null) return 'unknown';
  const used = `${Math.round(window.usedPercent)}% of the ${WINDOW_NAMES[name] ?? 'limit'} used`;
  const resets = day(window.resetsAt ?? quota.resetsAt);
  return `${window.limitReached ? 'Limit reached' : used}${resets ? `, resets ${resets}` : ''}`;
}

const tokens = (n: number | null): string => (n === null ? 'unknown' : formatTokenCount(n));

/** "12 turns, 1.2M input (1.1M cached), 40K output, 9K reasoning", or "No usage logged". */
export function usageText(t: UsageRollupTotals | undefined): string {
  if (!t || t.turns === 0) return 'No usage logged';
  const turns = t.turns === 1 ? '1 turn' : `${t.turns} turns`;
  const parts = [
    `${tokens(t.input)} input${t.cachedInput !== null ? ` (${tokens(t.cachedInput)} cached)` : ''}`,
    `${tokens(t.output)} output`,
    `${tokens(t.reasoning)} reasoning`,
  ];
  const none = t.turnsWithoutUsage > 0 ? `. ${t.turnsWithoutUsage} reported no usage` : '';
  const noId = t.turnsWithoutId > 0 ? `. ${t.turnsWithoutId === 1 ? '1 turn' : `${t.turnsWithoutId} turns`} had no id and may be counted twice` : '';
  return `${turns}, ${parts.join(', ')}${none}${noId}`;
}

const ROLE_NAMES: Record<string, string> = {
  dispatcher: 'Dispatcher',
  orchestrator: 'Orchestrators',
  helper: 'Helpers',
  quick: 'Quick agents',
  agent: 'Other agents',
  unknown: 'Not yet identified',
};

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}
