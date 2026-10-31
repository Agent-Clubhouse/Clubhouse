import type { Agent, DurableAgentConfig } from '../../../shared/types';
import { useProjectStore } from '../projectStore';
import { findProjectByPath } from '../../utils/project-path';

/**
 * A durable agent's parent link (#2224) as the rail carries it. A parent in
 * another project (#2514) adds that project's path, and its id when that
 * project is open. agents.json is the source of truth, so an unset link
 * clears all three.
 */
export function parentLinkFields(config: Pick<DurableAgentConfig, 'parentAgentId' | 'parentProjectPath'> | null | undefined): Pick<Agent, 'parentAgentId' | 'parentProjectPath' | 'parentProjectId'> {
  const parentAgentId = config?.parentAgentId || undefined;
  const parentProjectPath = parentAgentId ? config?.parentProjectPath || undefined : undefined;
  const parentProjectId = parentProjectPath
    ? findProjectByPath(useProjectStore.getState().projects, parentProjectPath)?.id
    : undefined;
  return { parentAgentId, parentProjectPath, parentProjectId };
}
