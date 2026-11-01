import { useCallback, useMemo, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { BranchChanges } from '../../../../shared/git-branch';
import { useProjectStore } from '../../../stores/projectStore';
import { agentCwd, useBranchChanges } from '../details/AgentDetails';
import { useAgentDetailsStore } from '../details/detailsStore';
import type { ReviewView } from '../pane/AgentPaneToolbar';

/**
 * An agent pane's branch against main, shared by its Agent details and its
 * Changes review, and whether the review is showing (#2032). With `enabled`
 * false (popouts, canvas cards) it reads nothing and offers no review.
 */
export function useAgentReview(agent: Agent, refreshKey: unknown, enabled = true): {
  cwd: string | undefined;
  branch: BranchChanges | null;
  reload: () => void;
  active: boolean;
  open: () => void;
  /** The toolbar's Changes button; absent where there's no folder to review. */
  view: ReviewView | undefined;
} {
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === agent.projectId)?.path);
  const cwd = enabled ? agentCwd(agent, projectPath) : undefined;
  const [tick, setTick] = useState(0);
  const branch = useBranchChanges(cwd, `${String(refreshKey)}:${tick}`);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const active = useAgentDetailsStore((s) => !!s.review[agent.id]) && !!cwd;
  const setReview = useAgentDetailsStore((s) => s.setReview);
  const open = useCallback(() => setReview(agent.id, true), [setReview, agent.id]);
  const close = useCallback(() => setReview(agent.id, false), [setReview, agent.id]);
  const count = branch?.files.length;
  const view = useMemo<ReviewView | undefined>(
    () => (cwd ? { active, count, onOpen: open, onClose: close } : undefined),
    [cwd, active, count, open, close],
  );
  return { cwd, branch, reload, active, open, view };
}
