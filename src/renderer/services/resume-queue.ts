import { useAgentStore } from '../stores/agentStore';
import { useProjectStore } from '../stores/projectStore';
import type { Agent, DurableAgentConfig } from '../../shared/types';
import type { RestartSessionEntry, RestartSessionState } from '../../shared/types';
import { isAssistantAgent } from '../../shared/assistant-utils';
import type { ResumeStatus } from '../features/app/ResumeBanner';

/**
 * Process pending resume entries after an update restart.
 * Sequential per workspace, parallel across workspaces.
 */
export async function processResumeQueue(state: RestartSessionState): Promise<void> {
  const store = useAgentStore.getState();

  // Filter out assistant agents — they are ephemeral and should not be resumed
  const sessions = state.sessions.filter((e) => !isAssistantAgent(e.agentId));

  // Group by projectPath for sequential processing
  const byProject = new Map<string, RestartSessionEntry[]>();
  for (const entry of sessions) {
    const key = entry.projectPath;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(entry);
  }

  // Set initial statuses
  for (const entry of sessions) {
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

    // Fetch the durable config so we can restore settings that aren't
    // captured in RestartSessionEntry (color, icon, freeAgentMode, etc.).
    // This mirrors how spawnDurableAgent reads the full config in
    // agentLifecycleSlice before constructing the Agent object.
    let durableConfig: DurableAgentConfig | null = null;
    if (entry.kind === 'durable') {
      try {
        durableConfig = await window.clubhouse.agent.getDurableConfig(
          entry.projectPath,
          entry.agentId,
        );
      } catch {
        // Config unavailable — fall back to entry-only values
      }
    }

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
      color: durableConfig?.color || 'gray',
      icon: durableConfig?.icon,
      resuming: true,
      orchestrator: entry.orchestrator,
      model: entry.model || durableConfig?.model,
      mission: entry.mission,
      worktreePath: entry.worktreePath,
      branch: durableConfig?.branch,
      freeAgentMode: entry.freeAgentMode ?? durableConfig?.freeAgentMode ?? undefined,
      structuredMode: durableConfig?.structuredMode || undefined,
      mcpIds: durableConfig?.mcpIds,
    };

    useAgentStore.setState((s) => ({
      agents: { ...s.agents, [entry.agentId]: agent },
      agentSpawnedAt: { ...s.agentSpawnedAt, [entry.agentId]: Date.now() },
    }));

    // Load the agent's profile icon into the icon cache so the UI
    // renders it immediately (mirrors loadDurableAgents in agentCrudSlice).
    if (agent.icon) {
      useAgentStore.getState().loadAgentIcon(agent);
    }

    await window.clubhouse.agent.spawnAgent({
      agentId: entry.agentId,
      projectPath: entry.projectPath,
      cwd,
      kind: entry.kind,
      resume: true,
      sessionId: entry.sessionId || undefined,
      orchestrator: entry.orchestrator,
      model: entry.model || durableConfig?.model,
      mission: entry.mission,
      permissionMode: entry.permissionMode,
      freeAgentMode: entry.freeAgentMode ?? durableConfig?.freeAgentMode,
      structuredMode: durableConfig?.structuredMode,
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
        // Kill existing process before retrying to prevent orphaned agents
        window.clubhouse.pty.kill(entry.agentId);
        const cwd = entry.worktreePath || entry.projectPath;
        // Re-read durableConfig in fallback scope (original may not be accessible)
        let fallbackConfig: DurableAgentConfig | null = null;
        if (entry.kind === 'durable') {
          try {
            fallbackConfig = await window.clubhouse.agent.getDurableConfig(
              entry.projectPath,
              entry.agentId,
            );
          } catch { /* config unavailable */ }
        }
        await window.clubhouse.agent.spawnAgent({
          agentId: entry.agentId,
          projectPath: entry.projectPath,
          cwd,
          kind: entry.kind,
          resume: true,
          sessionId: undefined, // --continue instead of --resume <id>
          orchestrator: entry.orchestrator,
          model: entry.model || fallbackConfig?.model,
          mission: entry.mission,
          permissionMode: entry.permissionMode,
          freeAgentMode: entry.freeAgentMode ?? fallbackConfig?.freeAgentMode,
          structuredMode: fallbackConfig?.structuredMode,
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
