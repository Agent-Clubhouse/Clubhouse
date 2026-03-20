import { useAgentStore } from '../stores/agentStore';
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

async function resumeAgent(entry: RestartSessionEntry): Promise<void> {
  const store = useAgentStore.getState();
  store.setResumeStatus(entry.agentId, 'resuming');

  try {
    const cwd = entry.worktreePath || entry.projectPath;

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

    // Wait for agent to appear as running, with timeout
    await waitForAgentRunning(entry.agentId, RESUME_TIMEOUT_MS);
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
        await waitForAgentRunning(entry.agentId, RESUME_TIMEOUT_MS);
        useAgentStore.getState().setResumeStatus(entry.agentId, 'resumed');
        return;
      } catch { /* fall through to failure */ }
    }
    useAgentStore.getState().setResumeStatus(entry.agentId, 'failed');
    console.error(`Failed to resume agent ${entry.agentId}:`, err instanceof Error ? err.message : String(err));
  }
}

function waitForAgentRunning(agentId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      useAgentStore.getState().setResumeStatus(agentId, 'timed_out');
      resolve();
    }, timeoutMs);

    const check = () => {
      const agent = useAgentStore.getState().agents[agentId];
      if (agent?.status === 'running') {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    };

    check();
    const unsubscribe = useAgentStore.subscribe(check);
  });
}

export async function resumeManualAgent(agentId: string, entry: RestartSessionEntry): Promise<void> {
  await resumeAgent(entry);
}
