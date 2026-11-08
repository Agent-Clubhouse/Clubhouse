/**
 * The CLI an agent runs on (#2975): its own choice, else its project's
 * "Agents run on", else Claude Code. Main resolves it the same way
 * (`resolveOrchestrator`), from the same projects.json value, and also skips
 * a project value it doesn't know (a removed CLI).
 */
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { isRemoteProjectId, useRemoteProjectStore } from '../../stores/remoteProjectStore';

export const FALLBACK_ORCHESTRATOR = 'claude-code';

/**
 * `known`, when given and not empty, is every CLI the app has: a project value
 * outside it is skipped, as main skips it.
 */
export function effectiveOrchestratorOf(
  agent: { orchestrator?: string | null },
  project: { orchestrator?: string | null } | undefined,
  known?: ReadonlyArray<{ id: string }>,
): string {
  if (agent.orchestrator) return agent.orchestrator;
  const projectCli = project?.orchestrator;
  if (projectCli && (!known || known.length === 0 || known.some((o) => o.id === projectCli))) return projectCli;
  return FALLBACK_ORCHESTRATOR;
}

/**
 * effectiveOrchestratorOf, reading the agent's project from the project store,
 * or for an agent on a paired satellite, from that satellite's projects.
 */
export function useEffectiveOrchestrator(agent: { orchestrator?: string | null; projectId: string }): string {
  const remote = isRemoteProjectId(agent.projectId);
  const localCli = useProjectStore((s) => (remote ? undefined : s.projects.find((p) => p.id === agent.projectId)?.orchestrator));
  const remoteCli = useRemoteProjectStore((s) => {
    if (!remote) return undefined;
    for (const list of Object.values(s.satelliteProjects)) {
      const found = list.find((p) => p.id === agent.projectId);
      if (found) return found.orchestrator;
    }
    return undefined;
  });
  const known = useOrchestratorStore((s) => s.allOrchestrators);
  return effectiveOrchestratorOf(agent, { orchestrator: remote ? remoteCli : localCli }, known);
}

/**
 * The CLI a new agent form starts on: the project's "Agents run on" when it's
 * one of the CLIs offered, else the first one offered.
 */
export function newAgentOrchestrator(
  project: { orchestrator?: string | null } | undefined,
  offered: ReadonlyArray<{ id: string }>,
): string {
  const projectCli = project?.orchestrator;
  if (projectCli && offered.some((o) => o.id === projectCli)) return projectCli;
  return offered[0]?.id || FALLBACK_ORCHESTRATOR;
}
