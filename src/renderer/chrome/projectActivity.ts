/**
 * The idle rule (docs/chrome-redesign-spec.md §2, §5.4). The rule itself lives
 * in shared/project-state.ts, so main applies it to the Annex snapshot too
 * (#2458); the sidebar reads it from here.
 */

import { isProjectIdle, type IdleInput } from '../../shared/project-state';

export { ACTIVITY_WRITE_INTERVAL_MS, DEFAULT_IDLE_DAYS, IDLE_DAY_CHOICES, isProjectIdle, type IdleInput } from '../../shared/project-state';

/** Split projects into the ones shown in the tree and the ones folded into "N idle projects", keeping order. */
export function partitionIdle<T extends { id: string }>(projects: readonly T[], input: IdleInput): { active: T[]; idle: T[] } {
  const active: T[] = [];
  const idle: T[] = [];
  for (const p of projects) (isProjectIdle(p.id, input) ? idle : active).push(p);
  return { active, idle };
}
