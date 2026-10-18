/**
 * The project root's Changes view (#2032, "Git, rethought"), next to the
 * start page: the root's own uncommitted files, and every agent branch
 * against main with the files two agents both touch flagged. Review opens
 * that agent's Changes review. Replaces the Git tab in the new layout.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent, Project } from '../../../shared/types';
import type { BranchChanges } from '../../../shared/git-branch';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import { agentDot, isMidTurn, StatusDot } from '../../features/agents/agent-status';
import { useAgentDetailsStore } from '../../features/agents/details/detailsStore';
import { ChangesReview } from '../../features/agents/review/ChangesReview';
import { useBranchChanges } from '../../features/agents/details/AgentDetails';

/** Agents with their own worktree: the ones that have a branch to compare. */
function useBranchAgents(projectId: string): Agent[] {
  const agents = useAgentStore((s) => s.agents);
  return useMemo(
    () => Object.values(agents).filter((a) => a.projectId === projectId && a.kind === 'durable' && !!a.worktreePath).sort((a, b) => a.name.localeCompare(b.name)),
    [agents, projectId],
  );
}

/** Branches read at once, so a project with many agents doesn't start a burst of git. */
export const BRANCH_READ_CONCURRENCY = 3;

/** Run `jobs` with at most `limit` in flight. */
export async function runLimited(jobs: Array<() => Promise<void>>, limit = BRANCH_READ_CONCURRENCY): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

/** Changes whenever one of these agents finishes a turn (or starts, stops or errors), so the branches are re-read then. */
function useTurnKey(agents: Agent[]): string {
  const detailed = useAgentStore((s) => s.agentDetailedStatus);
  // The last finished turn per agent, kept while the next turn runs, so only a turn end moves the key.
  const lastDone = useRef<Record<string, number>>({});
  return agents.map((a) => {
    const d = detailed[a.id];
    // A finished turn is idle without the mid-turn "Thinking"; its timestamp moves on each turn end.
    if (d && d.state === 'idle' && !isMidTurn(d)) lastDone.current[a.id] = d.timestamp;
    return `${a.id}:${a.status}:${lastDone.current[a.id] ?? ''}`;
  }).join('|');
}

/**
 * Each agent's branch against main, re-read when `refreshKey` changes or an
 * agent's turn ends, at most BRANCH_READ_CONCURRENCY at a time. Agents that
 * are gone drop out, so their files no longer count as overlaps.
 */
function useAgentBranches(agents: Agent[], refreshKey: unknown): Record<string, BranchChanges | null> {
  const [byId, setById] = useState<Record<string, BranchChanges | null>>({});
  const key = agents.map((a) => `${a.id}:${a.worktreePath}`).join('|');
  const turnKey = useTurnKey(agents);
  useEffect(() => {
    const ids = new Set(agents.map((a) => a.id));
    setById((s) => (Object.keys(s).every((id) => ids.has(id)) ? s : Object.fromEntries(Object.entries(s).filter(([id]) => ids.has(id)))));
    let cancelled = false;
    void runLimited(agents.filter((a) => a.worktreePath).map((a) => async () => {
      if (cancelled) return;
      try {
        const r = await window.clubhouse.git.branchChanges(a.worktreePath!, undefined, true);
        if (!cancelled) setById((s) => ({ ...s, [a.id]: r }));
      } catch {
        // telemetry-exempt: that agent's row says its branch couldn't be read.
        if (!cancelled) setById((s) => ({ ...s, [a.id]: { available: false, files: [] } }));
      }
    }));
    return () => { cancelled = true; };
    // `agents` is keyed by `key`; re-reading on each new array would undo the throttle.
  }, [key, refreshKey, turnKey]);
  return byId;
}

/** For each agent, the other agents whose branches change a file it changes too. */
export function overlaps(branches: Record<string, BranchChanges | null>, names: Record<string, string>): Record<string, { path: string; others: string[] }[]> {
  const byPath = new Map<string, string[]>();
  for (const [id, b] of Object.entries(branches)) {
    for (const f of b?.files ?? []) byPath.set(f.path, [...(byPath.get(f.path) ?? []), id]);
  }
  const out: Record<string, { path: string; others: string[] }[]> = {};
  for (const [path, ids] of byPath) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      (out[id] ??= []).push({ path, others: ids.filter((o) => o !== id).map((o) => names[o] ?? o) });
    }
  }
  return out;
}

function branchLine(b: BranchChanges | null | undefined): string {
  if (!b) return 'Reading…';
  if (!b.available) return 'not a git repository';
  if (b.noBase) return 'no main branch to compare with';
  const parts: string[] = [];
  parts.push(b.ahead ? `${b.ahead} ahead` : 'nothing committed');
  if (b.uncommitted) parts.push(`${b.uncommitted} uncommitted`);
  return parts.join(' · ');
}

export function AgentBranches({ project, refreshKey }: { project: Project; refreshKey: unknown }) {
  const agents = useBranchAgents(project.id);
  const detailed = useAgentStore((s) => s.agentDetailedStatus);
  const branches = useAgentBranches(agents, refreshKey);
  const names = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.name])), [agents]);
  const shared = useMemo(() => overlaps(branches, names), [branches, names]);

  const review = (agent: Agent) => {
    useAgentDetailsStore.getState().setReview(agent.id, true);
    useAgentStore.getState().setActiveAgent(agent.id, project.id);
    useUIStore.getState().setExplorerTab('agents', project.id);
  };

  if (agents.length === 0) {
    return <p className="px-4 py-3 text-xs text-ctp-overlay1">No agent here works in its own worktree, so there are no agent branches to compare.</p>;
  }
  return (
    <div className="flex flex-col py-1.5" data-testid="project-agent-branches">
      {agents.map((a) => {
        const b = branches[a.id];
        const clash = shared[a.id];
        const warning = clash?.length
          ? `${clash[0].path.split('/').pop()} also changed by ${clash[0].others.join(', ')}${clash.length > 1 ? ` and ${clash.length - 1} more` : ''}`
          : null;
        return (
          <div key={a.id} className="flex items-center gap-2.5 min-h-[46px] px-4 mx-2 rounded-md hover:bg-surface-0" data-testid="project-agent-branch" data-agent-id={a.id}>
            <StatusDot dot={agentDot(a, detailed[a.id])} />
            <AgentAvatar agent={a} size="2xs" />
            <div className="min-w-0 flex-1 py-1.5">
              <div className="flex items-center gap-2.5 min-w-0 text-[13px]">
                <span className="font-medium text-ctp-text">{a.name}</span>
                <span className="font-mono text-[11.5px] text-ctp-overlay1 truncate">{b?.branch ?? a.branch ?? ''}</span>
              </div>
              <div className={`text-xs mt-0.5 truncate ${warning ? 'text-ctp-warning' : 'text-ctp-overlay1'}`} data-testid="project-agent-branch-note">
                {warning ?? branchLine(b)}
              </div>
            </div>
            <span className="flex-shrink-0 text-xs text-ctp-overlay1 text-right">
              {warning ? `${branchLine(b)} · ` : ''}{b?.files.length ?? 0} {b?.files.length === 1 ? 'file' : 'files'}
            </span>
            <button type="button" onClick={() => review(a)} className="flex-shrink-0 w-[60px] text-right text-xs text-ctp-accent hover:underline" data-testid="project-agent-review">
              Review
            </button>
          </div>
        );
      })}
      <p className="px-6 pt-2.5 text-xs text-ctp-overlay1 leading-relaxed max-w-[560px]">Each agent works on its own branch in its own worktree. Review opens that agent&apos;s Changes view.</p>
    </div>
  );
}

/**
 * The project page in the new layout: a 32px bar that switches between the
 * start page (Overview) and the project's Changes.
 */
export function ProjectHome({ project, overview }: { project: Project; overview: ReactNode }) {
  const [view, setView] = useState<'overview' | 'changes'>('overview');
  useEffect(() => { setView('overview'); }, [project.id]);
  const remote = isRemoteProjectId(project.id);
  return (
    <div className="h-full flex flex-col min-h-0 bg-ctp-base">
      <div className="h-8 flex-shrink-0 flex items-center gap-2 pl-3.5 pr-1.5 border-b border-surface-0 text-xs text-ctp-overlay1" data-testid="project-page-bar">
        <span className="text-ctp-text truncate">{project.displayName || project.name}</span>
        <span className="truncate">project root</span>
        {!remote && (
          <span className="ml-auto inline-flex gap-0.5 p-0.5 rounded-[7px] bg-ctp-crust" role="radiogroup" aria-label="Project view">
            {(['overview', 'changes'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => setView(v)}
                className={`h-[22px] px-[9px] rounded-[5px] text-xs ${view === v ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'}`}
                data-testid={`project-view-${v}`}
              >
                {v === 'overview' ? 'Overview' : 'Changes'}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{view === 'changes' && !remote ? <ProjectChanges project={project} /> : overview}</div>
    </div>
  );
}

export function ProjectChanges({ project }: { project: Project }) {
  const [tick, setTick] = useState(0);
  // Re-read after a commit, stage or discard here, so the header stays right.
  const branch = useBranchChanges(project.path, tick);
  return (
    <ChangesReview
      agentName={project.displayName || project.name}
      cwd={project.path}
      branch={branch}
      onChanged={() => setTick((t) => t + 1)}
      refreshKey={tick}
      root={{ aside: <AgentBranches project={project} refreshKey={tick} /> }}
    />
  );
}
