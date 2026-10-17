import { useAgentStore, useAnnexClientStore, parseNamespacedId, useProjectStore } from './host';

/**
 * Waking a sleeping durable agent from Review, optionally resuming its last
 * session and with a first prompt. The plugin API's `resume` always starts a
 * fresh session, so Review goes to the agent store directly, as SleepingAgent does.
 */

async function localDurable(agentId: string) {
  const agent = useAgentStore.getState().agents[agentId];
  if (!agent) throw new Error('This agent no longer exists.');
  if (agent.kind !== 'durable') throw new Error('Only durable agents can be woken.');
  const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
  if (!project) throw new Error('This agent\'s project isn\'t open.');
  const configs = await window.clubhouse.agent.listDurable(project.path);
  const config = configs.find((c: { id: string }) => c.id === agentId);
  if (!config) throw new Error('This agent\'s settings couldn\'t be found.');
  return { project, config };
}

/**
 * The session a resume would continue: the durable config's lastSessionId for
 * a local agent. A remote agent resumes on its host, so any id is unknown (null)
 * but resuming is still possible. `resumable` is false when a wake would start fresh.
 */
export async function resumeTarget(agentId: string): Promise<{ resumable: boolean; sessionId: string | null }> {
  if (parseNamespacedId(agentId)) return { resumable: true, sessionId: null };
  try {
    const { config } = await localDurable(agentId);
    return config.lastSessionId ? { resumable: true, sessionId: config.lastSessionId } : { resumable: false, sessionId: null };
  } catch {
    return { resumable: false, sessionId: null };
  }
}

/** Rejects with a message to show when the agent can't be woken. */
export async function wakeAgent(agentId: string, options: { resume: boolean; prompt?: string }): Promise<void> {
  const mission = options.prompt?.trim() || undefined;
  const remote = parseNamespacedId(agentId);
  if (remote) {
    await useAnnexClientStore.getState().sendAgentWake(remote.satelliteId, remote.agentId, { resume: options.resume, mission });
    return;
  }
  const { project, config } = await localDurable(agentId);
  await useAgentStore.getState().spawnDurableAgent(project.id, project.path, config, options.resume && !!config.lastSessionId, mission);
}
