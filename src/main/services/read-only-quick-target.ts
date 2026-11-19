import { knownQuickAgents, type QuickAgentRun } from './quick-agent-events';
import { peekProjectsChecked } from './project-store';
import { captureReadOnlyProjectWitness } from './read-only-agent-target-witness';
import type { AgentConfigTarget } from './agent-config-reader';

export interface ReadOnlyQuickTarget {
  kind: 'quick';
  run: QuickAgentRun;
  project: AgentConfigTarget['project'];
  current(): boolean;
}

/** Only a retained exact quick ID in its registered project; no name resolution or config creation. */
export async function resolveReadOnlyQuickTarget(agentId: string, authorized: () => boolean): Promise<ReadOnlyQuickTarget | null> {
  if (!authorized()) throw new Error('revoked');
  const run = knownQuickAgents().get(agentId);
  if (!run) return null;
  const finishedAt = run.finishedAt;
  const inventory = await peekProjectsChecked({ strict: true });
  if (!authorized()) throw new Error('revoked');
  if (!inventory.readable) throw new Error('Project inventory unreadable.');
  const projects = inventory.projects.filter((p) => p.path === run.projectPath);
  if (projects.length !== 1) throw new Error('Quick project is not registered.');
  const project = projects[0];
  const witness = captureReadOnlyProjectWitness(project);
  const current = () => authorized() && knownQuickAgents().get(agentId) === run && run.finishedAt === finishedAt && witness.current();
  if (!current()) throw new Error('Quick target changed.');
  return { kind: 'quick', run, project, current };
}
