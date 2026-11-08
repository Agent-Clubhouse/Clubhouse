/**
 * The CLI an agent runs on (#2975): its own choice, else its project's
 * "Agents run on", else Claude Code. Main resolves it the same way
 * (`resolveOrchestrator`), from the same projects.json value.
 */
import { useProjectStore } from '../../stores/projectStore';

export const FALLBACK_ORCHESTRATOR = 'claude-code';

export function effectiveOrchestratorOf(
  agent: { orchestrator?: string | null },
  project: { orchestrator?: string | null } | undefined,
): string {
  return agent.orchestrator || project?.orchestrator || FALLBACK_ORCHESTRATOR;
}

/** effectiveOrchestratorOf, with the agent's project read from the project store. */
export function useEffectiveOrchestrator(agent: { orchestrator?: string | null; projectId: string }): string {
  const projectCli = useProjectStore((s) => s.projects.find((p) => p.id === agent.projectId)?.orchestrator);
  return effectiveOrchestratorOf(agent, { orchestrator: projectCli });
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
