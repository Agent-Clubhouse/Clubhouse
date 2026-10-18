import { useAgentStore } from '../../stores/agentStore';

/** `resume` continues the agent's last session when it has one; `new` always starts fresh. */
export type WakeMode = 'resume' | 'new';

/**
 * Wake a sleeping durable agent. Resuming is the default: the chat view shows
 * the agent's earlier conversation, so a fresh session would look continuous
 * while the CLI remembers none of it. An agent that has never run (no
 * lastSessionId) starts fresh either way, so the CLI isn't asked to continue
 * a session that doesn't exist. A resume of a session the CLI no longer has
 * clears the id and starts fresh in main (#2086), so it can't loop.
 */
export async function wakeDurableAgent(
  projectId: string,
  projectPath: string,
  agentId: string,
  mode: WakeMode = 'resume',
): Promise<void> {
  const configs = await window.clubhouse.agent.listDurable(projectPath);
  const config = configs.find((c: { id: string }) => c.id === agentId);
  // A disposed helper (#2224) has no worktree to run in.
  if (!config || config.disposedAt) return;
  const resume = mode === 'resume' && !!config.lastSessionId;
  await useAgentStore.getState().spawnDurableAgent(projectId, projectPath, config, resume);
}
