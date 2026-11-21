import type { HelperDisposeChecks } from './types';

export function helpersSummary(live: number, maxHelpers: number | undefined, starting: number, waiting = 0): string {
  const parts: string[] = [];
  if (live > 0) parts.push(maxHelpers ? `${live} of ${maxHelpers}` : String(live));
  if (live > 0 && starting > 0) parts.push(`${starting} starting`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  return parts.length ? parts.join(' · ') : 'none';
}

/** The same short work line in local and remote helper lists. */
export function workSummary(checks: HelperDisposeChecks | undefined): string | null {
  if (!checks) return null;
  if (checks.error) return 'couldn’t check';
  const parts: string[] = [];
  if (checks.dirty > 0) parts.push(`${checks.dirty} uncommitted`);
  if (checks.unpushed > 0) parts.push(`${checks.unpushed > 99 ? '99+' : checks.unpushed} unpushed`);
  return parts.length ? parts.join(', ') : 'clean';
}
