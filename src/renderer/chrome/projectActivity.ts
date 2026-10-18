/**
 * The idle rule (docs/chrome-redesign-spec.md §2, §5.4): a project is idle when
 * it is unpinned and nothing happened in it for the idle window (7 days by
 * default). Activity is an agent running or waking, a quick agent starting,
 * or the user opening one of the project's tabs; sleeping agents don't count.
 * A project the user marked inactive (#2116) is idle at once, and stays so
 * until they mark it active; new activity doesn't undo the mark, but like any
 * idle project it still shows while it is running or selected.
 * Pure, so the rule is unit-tested on its own.
 */

export const DEFAULT_IDLE_DAYS = 7;
export const IDLE_DAY_CHOICES = [3, 7, 14, 30, 0] as const; // 0: never idle
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IdleInput {
  /** Last activity per project id. A project with none yet is treated as active (it is seeded when first seen). */
  activity: Readonly<Record<string, number>>;
  pinnedIds: readonly string[];
  /** Projects with an agent running now. */
  runningIds: ReadonlySet<string>;
  /** The selected project never hides in the idle row. */
  activeProjectId: string | null;
  idleDays: number;
  now: number;
  /** Projects marked inactive by the user. */
  inactiveIds?: readonly string[];
}

export function isProjectIdle(projectId: string, input: IdleInput): boolean {
  if (input.pinnedIds.includes(projectId) || input.runningIds.has(projectId) || input.activeProjectId === projectId) return false;
  if (input.inactiveIds?.includes(projectId)) return true;
  if (input.idleDays <= 0) return false;
  const last = input.activity[projectId];
  if (last === undefined) return false;
  return input.now - last > input.idleDays * DAY_MS;
}

/** Split projects into the ones shown in the tree and the ones folded into "N idle projects", keeping order. */
export function partitionIdle<T extends { id: string }>(projects: readonly T[], input: IdleInput): { active: T[]; idle: T[] } {
  const active: T[] = [];
  const idle: T[] = [];
  for (const p of projects) (isProjectIdle(p.id, input) ? idle : active).push(p);
  return { active, idle };
}

/** Activity is written at most this often per project, so a busy agent doesn't churn storage. */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;
