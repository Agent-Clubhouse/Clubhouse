import { AGENT_COLORS } from '../../../shared/name-generator';
import type { Agent } from '../../../shared/types';

export const colorHexMap: Record<string, string> = Object.fromEntries(
  AGENT_COLORS.map((c) => [c.id, c.hex]),
);

/** Filter & sort agents to only durable ones with a worktree in the given project. */
export function getDurableWorktreeAgents(
  agents: Record<string, Agent>,
  projectId: string | undefined,
): Agent[] {
  return Object.values(agents)
    .filter((a) => a.kind === 'durable' && a.worktreePath && a.projectId === projectId)
    .sort((a, b) => a.name.localeCompare(b.name));
}
