/**
 * The helper header (#2232, decided 18 October): a helper's view is a normal
 * agent view, in chat or terminal, with this one line under the toolbar
 * naming its orchestrator, with a link to it. A disposable helper gets a
 * quiet note that its orchestrator may dispose of it. An orchestrator in
 * another project (#2514) is named with its project, and the link switches to
 * it. Renders nothing for an agent without a parent.
 */

import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectPath } from '../details/AgentDetails';
import { AgentAvatar } from '../AgentAvatar';
import { openAgent, useHelperLink } from './orchestration-hooks';
import { useParentProjectName } from './cross-project';

export function HelperHeader({ agent }: { agent: Agent }) {
  const projectPath = useProjectPath(agent.projectId);
  const link = useHelperLink(agent, projectPath);
  const parent = useAgentStore((s) => (link ? s.agents[link.parentAgentId] : undefined));
  const iconUrl = useAgentStore((s) => (parent ? s.agentIcons[parent.id] : undefined));
  const parentProject = useParentProjectName({ parentProjectPath: link?.parentProjectPath, parentProjectId: agent.parentProjectId });
  if (!link) return null;
  return (
    <div
      className="h-7 flex-shrink-0 flex items-center gap-1.5 pl-3.5 pr-3 border-b border-surface-0 bg-ctp-base text-xs text-ctp-overlay1 min-w-0"
      data-testid="helper-header"
    >
      <span className="flex-shrink-0">Helper of</span>
      {parent ? (
        <button
          type="button"
          onClick={() => openAgent(parent.projectId, parent.id)}
          className="flex items-center gap-1.5 min-w-0 text-ctp-accent hover:underline cursor-pointer"
          data-testid="helper-header-parent"
        >
          <AgentAvatar agent={parent} size="2xs" iconUrl={iconUrl} />
          <span className="truncate">{parent.name}</span>
        </button>
      ) : (
        <span className="text-ctp-subtext1" data-testid="helper-header-parent-missing">an agent that’s no longer here</span>
      )}
      {parentProject && (
        <span className="min-w-0 truncate" data-testid="helper-header-parent-project">in {parentProject}</span>
      )}
      {link.disposable && parent && (
        <span className="min-w-0 truncate" data-testid="helper-header-disposable">
          · {parent.name} may dispose of it when the work is done
        </span>
      )}
    </div>
  );
}
