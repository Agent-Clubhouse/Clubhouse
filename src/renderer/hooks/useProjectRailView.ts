import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';
import type { Agent, AgentDetailedStatus } from '../../shared/types';
import {
  arrangeProjects,
  summarizeProjectActivity,
  type ProjectActivitySummary,
  type ProjectRailMode,
} from '../utils/projectActivity';

/** How long activity membership must hold before the rail re-sorts/filters. */
export const ACTIVITY_SETTLE_MS = 1000;

type AgentMaps = { agents: Record<string, Agent>; detailed: Record<string, AgentDetailedStatus> };

/**
 * Compact value-comparable signature of the activity summaries. Selecting this
 * string (instead of the raw maps) means the rail only re-renders when some
 * project's indicator would actually change — not on every status heartbeat.
 */
function activitySignature({ agents, detailed }: AgentMaps): string {
  const summaries = summarizeProjectActivity(agents, detailed);
  return [...summaries]
    .map(([id, s]) => `${id}|${s.level}|${s.running}|${s.working}|${s.needsPermission}|${s.toolError}`)
    .sort()
    .join('\n');
}

function useActivity(signature: string, read: () => AgentMaps): Map<string, ProjectActivitySummary> {
  const readRef = useRef(read);
  readRef.current = read;
  // `signature` is the change key: it differs exactly when read() would summarize differently.
  return useMemo(() => {
    const { agents, detailed } = readRef.current();
    return summarizeProjectActivity(agents, detailed);
  }, [signature]);
}

/** Activity summaries for local projects, keyed by project id. */
export function useLocalProjectActivity(): Map<string, ProjectActivitySummary> {
  const pick = (s: ReturnType<typeof useAgentStore.getState>): AgentMaps =>
    ({ agents: s.agents, detailed: s.agentDetailedStatus });
  const signature = useAgentStore((s) => activitySignature(pick(s)));
  return useActivity(signature, () => pick(useAgentStore.getState()));
}

/** Activity summaries for remote projects, keyed by namespaced project id. */
export function useRemoteProjectActivity(): Map<string, ProjectActivitySummary> {
  const pick = (s: ReturnType<typeof useRemoteProjectStore.getState>): AgentMaps =>
    ({ agents: s.remoteAgents, detailed: s.remoteAgentDetailedStatus });
  const signature = useRemoteProjectStore((s) => activitySignature(pick(s)));
  return useActivity(signature, () => pick(useRemoteProjectStore.getState()));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Debounced copy of `raw`: a new membership is committed only after it has
 * held for `delayMs`, and never while `frozen` (pointer/focus inside the list,
 * so an icon doesn't jump out from under the cursor). Pending changes apply
 * once the freeze lifts and the settle delay elapses.
 */
export function useSettledSet(raw: ReadonlySet<string>, frozen: boolean, delayMs = ACTIVITY_SETTLE_MS): ReadonlySet<string> {
  const [committed, setCommitted] = useState<ReadonlySet<string>>(() => new Set(raw));
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const rawKey = [...raw].sort().join('\n');

  useEffect(() => {
    if (frozen || sameSet(rawRef.current, committed)) return;
    const timer = setTimeout(() => setCommitted(new Set(rawRef.current)), delayMs);
    return () => clearTimeout(timer);
  }, [rawKey, frozen, committed, delayMs]);

  return committed;
}

/**
 * Derive what the rail shows for a project list under the current view mode.
 * The activity dot reads `summaries` (immediate); ordering/filtering reads the
 * settled membership so the list doesn't reshuffle on transient changes.
 */
export function useProjectRailView<T extends { id: string }>({
  projects,
  summaries,
  mode,
  selectedId,
  frozen,
}: {
  projects: readonly T[];
  summaries: Map<string, ProjectActivitySummary>;
  mode: ProjectRailMode;
  selectedId: string | null;
  frozen: boolean;
}): { displayed: T[] } {
  const rawActive = useMemo(() => new Set(summaries.keys()), [summaries]);
  const settledActive = useSettledSet(rawActive, frozen);
  const displayed = useMemo(
    () => arrangeProjects(projects, settledActive, mode, selectedId),
    [projects, settledActive, mode, selectedId],
  );
  return { displayed };
}
