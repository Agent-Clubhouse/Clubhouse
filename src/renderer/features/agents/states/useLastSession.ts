import { useEffect, useState } from 'react';
import type { Agent } from '../../../../shared/types';

/** Where a sleeping agent left off: its last session and the state of its branch. */
export interface LastSessionInfo {
  sessionId: string | null;
  summary: string | null;
  filesModified: string[];
  lastActiveAt: number | null;
  durationMs: number;
  costUsd: number;
  /** Commits ahead of the upstream, and its name, when the branch tracks one. */
  ahead: number;
  remote: string;
  uncommitted: number;
  hasGit: boolean;
}

/**
 * Loads the last session summary (`getSessionSummary` with the config's
 * `lastSessionId`) and the branch state (`git.info` on the agent's worktree).
 * Local durable agents only; returns null until loaded or when there is nothing.
 */
export function useLastSession(agent: Agent, projectPath: string | undefined, enabled: boolean): LastSessionInfo | null {
  const [info, setInfo] = useState<LastSessionInfo | null>(null);

  useEffect(() => {
    if (!enabled || !projectPath || agent.kind !== 'durable') {
      setInfo(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let sessionId: string | null = null;
      let summary: Awaited<ReturnType<typeof window.clubhouse.agent.getSessionSummary>> = null;
      try {
        const configs = await window.clubhouse.agent.listDurable(projectPath);
        const config = Array.isArray(configs) ? configs.find((c: { id: string }) => c.id === agent.id) : undefined;
        sessionId = config?.lastSessionId ?? null;
        if (sessionId) {
          summary = await window.clubhouse.agent.getSessionSummary(projectPath, agent.id, sessionId, agent.orchestrator) ?? null;
        }
      } catch {
        // telemetry-exempt: optional session history; the view just omits it
      }

      let git = { ahead: 0, remote: '', uncommitted: 0, hasGit: false };
      try {
        const gi = await window.clubhouse.git.info(agent.worktreePath || projectPath);
        if (gi?.hasGit) git = { ahead: gi.ahead ?? 0, remote: gi.remote ?? '', uncommitted: gi.status?.length ?? 0, hasGit: true };
      } catch {
        // telemetry-exempt: not a repo or git unavailable; the branch line is omitted
      }

      if (cancelled) return;
      const lastActive = summary?.lastActiveAt ? Date.parse(summary.lastActiveAt) : NaN;
      setInfo({
        sessionId,
        summary: summary?.summary ?? null,
        filesModified: summary?.filesModified ?? [],
        lastActiveAt: Number.isFinite(lastActive) ? lastActive : null,
        durationMs: summary?.totalDurationMs ?? 0,
        costUsd: summary?.totalCostUsd ?? 0,
        ...git,
      });
    })();
    return () => { cancelled = true; };
  }, [agent.id, agent.kind, agent.orchestrator, agent.worktreePath, projectPath, enabled]);

  return info;
}
