/**
 * Project activity — derives per-project "is anything running here?" state
 * from the agent maps, and arranges rail project lists by that state.
 *
 * A project is *active* when at least one of its agents has
 * `status === 'running'`. The detailed hook state (working / needs_permission)
 * only refines how the indicator looks; it never changes membership, because
 * agents bounce between `working` and `idle` between every tool call and the
 * rail must not reshuffle on that churn.
 *
 * Works for both local agents and remote (namespaced) agents: remote agents
 * carry a namespaced `projectId` that matches the namespaced RemoteProject id.
 */
import type { Agent, AgentDetailedStatus } from '../../shared/types';

/** Visual precedence: needs_permission > working > running (idle). */
export type ProjectActivityLevel = 'needs_permission' | 'working' | 'running';

export interface ProjectActivitySummary {
  level: ProjectActivityLevel;
  running: number;
  working: number;
  needsPermission: number;
  toolError: number;
}

export type ProjectRailMode = 'all' | 'active-first' | 'active-only';

export const PROJECT_RAIL_MODES: readonly ProjectRailMode[] = ['all', 'active-first', 'active-only'];

export function isProjectRailMode(value: unknown): value is ProjectRailMode {
  return typeof value === 'string' && (PROJECT_RAIL_MODES as readonly string[]).includes(value);
}

/** Aggregate running agents into per-project summaries. Inactive projects are absent. */
export function summarizeProjectActivity(
  agents: Record<string, Agent>,
  detailedStatus: Record<string, AgentDetailedStatus>,
): Map<string, ProjectActivitySummary> {
  const summaries = new Map<string, ProjectActivitySummary>();
  for (const agent of Object.values(agents)) {
    if (agent.status !== 'running') continue;
    let summary = summaries.get(agent.projectId);
    if (!summary) {
      summary = { level: 'running', running: 0, working: 0, needsPermission: 0, toolError: 0 };
      summaries.set(agent.projectId, summary);
    }
    summary.running++;
    switch (detailedStatus[agent.id]?.state) {
      case 'working': summary.working++; break;
      case 'needs_permission': summary.needsPermission++; break;
      case 'tool_error': summary.toolError++; break;
    }
  }
  for (const summary of summaries.values()) {
    summary.level = summary.needsPermission > 0 ? 'needs_permission'
      : summary.working > 0 ? 'working'
        : 'running';
  }
  return summaries;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Human-readable status for titles / aria-labels, e.g. "2 running agents; 1 working". */
export function describeProjectActivity(summary: ProjectActivitySummary | undefined): string {
  if (!summary) return 'No running agents';
  const parts = [plural(summary.running, 'running agent')];
  if (summary.working > 0) parts.push(`${summary.working} working`);
  if (summary.needsPermission > 0) parts.push(`${summary.needsPermission} needs permission`);
  if (summary.toolError > 0) parts.push(plural(summary.toolError, 'tool error'));
  return parts.join('; ');
}

/**
 * Derive the displayed project list for a rail mode. Never mutates `projects`
 * — the input is the user's persisted manual order and must stay canonical.
 *
 * - all:          manual order
 * - active-first: stable partition (active, then inactive), manual order within each
 * - active-only:  active projects in manual order, plus `selectedId` so the
 *                 project the user is looking at never vanishes underneath them
 */
export function arrangeProjects<T extends { id: string }>(
  projects: readonly T[],
  activeIds: ReadonlySet<string>,
  mode: ProjectRailMode,
  selectedId: string | null,
): T[] {
  if (mode === 'all') return [...projects];
  const active = projects.filter((p) => activeIds.has(p.id));
  if (mode === 'active-first') {
    return [...active, ...projects.filter((p) => !activeIds.has(p.id))];
  }
  return projects.filter((p) => activeIds.has(p.id) || p.id === selectedId);
}
