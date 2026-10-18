import type { DurableCreationEvent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';

/**
 * Apply a stage of an asynchronous agent creation (#2226) to the agent store,
 * in the main window and in pop-outs alike:
 * - a creation the store does not know yet loads its project's agents (it shows as creating);
 * - ready turns the agent asleep with the config's worktree and branch;
 * - failed shows the reason, and drops the worktree and branch the failure removed;
 * - cancelled removes the agent.
 */
export function applyDurableCreationEvent(event: DurableCreationEvent): void {
  const store = useAgentStore.getState();
  const agent = store.agents[event.agentId];
  if (event.stage === 'cancelled') {
    if (agent) store.removeAgent(event.agentId);
    return;
  }
  if (!agent) {
    const project = useProjectStore.getState().projects.find((p) => p.path === event.projectPath);
    if (project) store.loadDurableAgents(project.id, project.path).catch(() => { /* best-effort */ });
    return;
  }
  if (event.stage !== 'ready' && event.stage !== 'failed') return;
  const config = event.config;
  useAgentStore.setState((s) => {
    const current = s.agents[event.agentId];
    if (!current) return s;
    const next = {
      ...current,
      ...(config ? { worktreePath: config.worktreePath, branch: config.branch } : {}),
      ...(event.stage === 'ready'
        ? { status: 'sleeping' as const, errorMessage: undefined }
        : { status: 'error' as const, errorMessage: event.reason ?? config?.creation?.reason }),
    };
    return { agents: { ...s.agents, [event.agentId]: next } };
  });
}
