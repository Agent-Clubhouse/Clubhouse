import { useEffect, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import { rendererLog } from '../../../plugins/renderer-logger';

/** Where a sleeping agent left off: its last session and the state of its branch. */
export interface LastSessionInfo {
  sessionId: string | null;
  /**
   * The summary or branch state is still loading. `sessionId` is already final,
   * so resume-vs-fresh never waits on these (#2277).
   */
  loading: boolean;
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

type Summary = Awaited<ReturnType<typeof window.clubhouse.agent.getSessionSummary>>;

/**
 * Loads the last session id from the agent's config, then the session summary
 * (`getSessionSummary`) and the branch state (`git.info` on the agent's
 * worktree) in parallel. Local durable agents only; returns null until the
 * config is read, then fills in the summary and branch as each arrives.
 * A slow or failed summary leaves `sessionId` as it is.
 */
export function useLastSession(agent: Agent, projectPath: string | undefined, enabled: boolean): LastSessionInfo | null {
  const [info, setInfo] = useState<LastSessionInfo | null>(null);

  useEffect(() => {
    if (!enabled || !projectPath || agent.kind !== 'durable') {
      setInfo(null);
      return;
    }
    let cancelled = false;
    setInfo(null);
    const update = (patch: Partial<LastSessionInfo>) => {
      if (!cancelled) setInfo((prev) => (prev ? { ...prev, ...patch } : prev));
    };
    // Local per-stage timing: durations and flags only, never session content
    const timing: Record<string, unknown> = { provider: agent.orchestrator ?? 'default' };
    const start = performance.now();
    const since = (t: number) => Math.round(performance.now() - t);

    (async () => {
      let sessionId: string | null = null;
      try {
        const configs = await window.clubhouse.agent.listDurable(projectPath);
        const config = Array.isArray(configs) ? configs.find((c: { id: string }) => c.id === agent.id) : undefined;
        sessionId = config?.lastSessionId ?? null;
      } catch {
        // telemetry-exempt: optional session history; the view just omits it
        timing.configFailed = true;
      }
      timing.configMs = since(start);
      timing.hasSession = !!sessionId;
      if (cancelled) return;
      setInfo({
        sessionId,
        loading: true,
        summary: null,
        filesModified: [],
        lastActiveAt: null,
        durationMs: 0,
        costUsd: 0,
        ahead: 0,
        remote: '',
        uncommitted: 0,
        hasGit: false,
      });

      const loadSummary = async () => {
        if (!sessionId) return;
        const t = performance.now();
        let summary: Summary = null;
        try {
          summary = await window.clubhouse.agent.getSessionSummary(projectPath, agent.id, sessionId, agent.orchestrator) ?? null;
        } catch {
          // telemetry-exempt: optional session history; the view just omits it
          timing.summaryFailed = true;
        }
        timing.summaryMs = since(t);
        timing.summaryFound = !!summary;
        if (!summary) return;
        const lastActive = summary.lastActiveAt ? Date.parse(summary.lastActiveAt) : NaN;
        update({
          summary: summary.summary ?? null,
          filesModified: summary.filesModified ?? [],
          lastActiveAt: Number.isFinite(lastActive) ? lastActive : null,
          durationMs: summary.totalDurationMs ?? 0,
          costUsd: summary.totalCostUsd ?? 0,
        });
      };

      const loadGit = async () => {
        const t = performance.now();
        try {
          const gi = await window.clubhouse.git.info(agent.worktreePath || projectPath);
          if (gi?.hasGit) update({ ahead: gi.ahead ?? 0, remote: gi.remote ?? '', uncommitted: gi.status?.length ?? 0, hasGit: true });
        } catch {
          // telemetry-exempt: not a repo or git unavailable; the branch line is omitted
          timing.gitFailed = true;
        }
        timing.gitMs = since(t);
      };

      await Promise.all([loadSummary(), loadGit()]);
      update({ loading: false });
      timing.totalMs = since(start);
      rendererLog('core:agents', 'debug', 'Last session timing', { meta: timing });
    })();
    return () => { cancelled = true; };
  }, [agent.id, agent.kind, agent.orchestrator, agent.worktreePath, projectPath, enabled]);

  return info;
}
