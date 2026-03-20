import { useAgentStore } from '../stores/agentStore';
import { useProjectStore } from '../stores/projectStore';
import type { Agent } from '../../shared/types';
import type { RestartSessionEntry, RestartSessionState } from '../../shared/types';
import type { ResumeStatus } from '../features/app/ResumeBanner';

const RESUME_TIMEOUT_MS = 60_000;

/**
 * Process pending resume entries after an update restart.
 * Sequential per workspace, parallel across workspaces.
 */
export async function processResumeQueue(state: RestartSessionState): Promise<void> {
  const store = useAgentStore.getState();

  // Group by projectPath for sequential processing
  const byProject = new Map<string, RestartSessionEntry[]>();
  for (const entry of state.sessions) {
    const key = entry.projectPath;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(entry);
  }

  // Set initial statuses
  for (const entry of state.sessions) {
    const status: ResumeStatus = entry.resumeStrategy === 'manual' ? 'manual' : 'pending';
    store.setResumeStatus(entry.agentId, status);
  }

  // Process all workspaces in parallel, but sequential within each workspace
  await Promise.allSettled(
    [...byProject.entries()].map(([_projectPath, entries]) =>
      processWorkspaceQueue(entries),
    ),
  );
}

async function processWorkspaceQueue(entries: RestartSessionEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.resumeStrategy === 'manual') continue;
    await resumeAgent(entry);
  }
}

/**
 * Look up the renderer's projectId from a filesystem path.
 * Returns the project ID or the path itself as fallback.
 */
function resolveProjectId(projectPath: string): string {
  const projects = useProjectStore.getState().projects;
  const match = projects.find((p) => p.path === projectPath);
  return match?.id || projectPath;
}

async function resumeAgent(entry: RestartSessionEntry): Promise<void> {
  useAgentStore.getState().setResumeStatus(entry.agentId, 'resuming');

  try {
    const cwd = entry.worktreePath || entry.projectPath;
    const projectId = resolveProjectId(entry.projectPath);

    // Add the agent to the renderer store BEFORE calling spawnAgent.
    // This mirrors how spawnDurableAgent works in agentLifecycleSlice —
    // the store entry must exist so the PTY data listener and exit
    // handler can find the agent, and so waitForAgentRunning resolves.
    const agent: Agent = {
      id: entry.agentId,
      projectId,
      name: entry.agentName,
      kind: entry.kind,
      status: 'running',
      color: 'gray',
      resuming: true,
      orchestrator: entry.orchestrator,
      model: entry.model,
      mission: entry.mission,
      worktreePath: entry.worktreePath,
    };

    useAgentStore.setState((s) => ({
      agents: { ...s.agents, [entry.agentId]: agent },
      agentSpawnedAt: { ...s.agentSpawnedAt, [entry.agentId]: Date.now() },
    }));

    await window.clubhouse.agent.spawnAgent({
      agentId: entry.agentId,
      projectPath: entry.projectPath,
      cwd,
      kind: entry.kind,
      resume: true,
      sessionId: entry.sessionId || undefined,
      orchestrator: entry.orchestrator,
      model: entry.model,
      mission: entry.mission,
    });

    // Clear the resuming spinner overlay and mark resume complete
    useAgentStore.setState((s) => {
      const agent = s.agents[entry.agentId];
      if (!agent) return s;
      return { agents: { ...s.agents, [entry.agentId]: { ...agent, resuming: undefined } } };
    });
    useAgentStore.getState().setResumeStatus(entry.agentId, 'resumed');
  } catch (err) {
    // If we had a specific sessionId and it failed, try --continue fallback
    if (entry.sessionId && entry.resumeStrategy === 'auto') {
      try {
        const cwd = entry.worktreePath || entry.projectPath;
        await window.clubhouse.agent.spawnAgent({
          agentId: entry.agentId,
          projectPath: entry.projectPath,
          cwd,
          kind: entry.kind,
          resume: true,
          sessionId: undefined, // --continue instead of --resume <id>
          orchestrator: entry.orchestrator,
          model: entry.model,
          mission: entry.mission,
        });
        useAgentStore.setState((s) => {
          const agent = s.agents[entry.agentId];
          if (!agent) return s;
          return { agents: { ...s.agents, [entry.agentId]: { ...agent, resuming: undefined } } };
        });
        useAgentStore.getState().setResumeStatus(entry.agentId, 'resumed');
        return;
      } catch { /* fall through to failure */ }
    }
    // Clear resuming flag on failure too
    useAgentStore.setState((s) => {
      const agent = s.agents[entry.agentId];
      if (!agent) return s;
      return { agents: { ...s.agents, [entry.agentId]: { ...agent, resuming: undefined } } };
    });
    useAgentStore.getState().setResumeStatus(entry.agentId, 'failed');
    console.error(`Failed to resume agent ${entry.agentId}:`, err instanceof Error ? err.message : String(err));
  }
}

export async function resumeManualAgent(agentId: string, entry: RestartSessionEntry): Promise<void> {
  await resumeAgent(entry);
}
