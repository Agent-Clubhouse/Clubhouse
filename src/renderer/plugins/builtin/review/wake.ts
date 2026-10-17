import { useAgentStore, useAnnexClientStore, parseNamespacedId, useProjectStore } from './host';

/**
 * Wake a sleeping durable agent from Review, optionally resuming its last
 * session and with a first prompt. The plugin API's `resume` always starts a
 * fresh session, so Review goes to the agent store directly, as SleepingAgent does.
 */
export async function wakeAgent(agentId: string, options: { resume: boolean; prompt?: string }): Promise<void> {
  const mission = options.prompt?.trim() || undefined;
  const remote = parseNamespacedId(agentId);
  if (remote) {
    await useAnnexClientStore.getState().sendAgentWake(remote.satelliteId, remote.agentId, { resume: options.resume, mission });
    return;
  }
  const agent = useAgentStore.getState().agents[agentId];
  if (!agent || agent.kind !== 'durable') return;
  const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
  if (!project) return;
  const configs = await window.clubhouse.agent.listDurable(project.path);
  const config = configs.find((c: { id: string }) => c.id === agentId);
  if (!config) return;
  await useAgentStore.getState().spawnDurableAgent(project.id, project.path, config, options.resume && !!config.lastSessionId, mission);
}
