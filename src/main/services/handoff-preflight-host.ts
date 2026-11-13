import { getHandoffTransferBounds } from './handoff-transfer-settings';
import * as path from 'path';
import { isDisposedAgent } from '../../shared/agent-helpers';
import type { HandoffWorktreeManifest } from '../../shared/handoff-manifest';
import { agentRegistry } from './agent-registry';
import { peekDurableConfigs } from './agent-config';
import { peekProjects } from './project-store';
import { HandoffSecretPolicy } from './handoff-secret-settings';
import { checkHandoffSnapshot } from './handoff-snapshot';

/** Source and policy are selected from the authenticated caller, never from tool arguments. */
export async function checkCallerHandoff(agentId: string, include?: Partial<HandoffWorktreeManifest['include']>, exclude?: string[]) {
  const live = agentRegistry.get(agentId);
  for (const project of await peekProjects()) {
    const config = (await peekDurableConfigs(project.path)).find((candidate) => candidate.id === agentId && !isDisposedAgent(candidate));
    if (!config && !(live && path.resolve(live.projectPath) === path.resolve(project.path))) continue;
    return checkHandoffSnapshot({
      worktreeRoot: config?.worktreePath || live?.cwd || project.path, include, exclude, bounds: await getHandoffTransferBounds(project.id),
      secretPolicy: await HandoffSecretPolicy.forProject(project.id),
    });
  }
  throw new Error('Handoff source must belong to a registered project.');
}
