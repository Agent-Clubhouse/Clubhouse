import type { Agent } from '../../../../shared/types';
import { useOtherProjectParentText } from './cross-project';

/**
 * The muted line under a helper's row in a sidebar when its orchestrator is
 * in another project (#2514): "Helper of {orchestrator} in {project}". The
 * helper is a root in its own project, so this is the only place the link shows.
 */
export function OtherProjectParentLine({ agent, paddingLeft, className = '' }: {
  agent: Pick<Agent, 'id' | 'parentAgentId' | 'parentProjectPath' | 'parentProjectId'>;
  paddingLeft: number;
  className?: string;
}) {
  const text = useOtherProjectParentText(agent);
  if (!text) return null;
  return (
    <div data-testid={`other-project-parent-${agent.id}`} className={`pr-2 truncate text-xs text-ctp-overlay1 ${className}`} style={{ paddingLeft }} title={text}>
      {text}
    </div>
  );
}
