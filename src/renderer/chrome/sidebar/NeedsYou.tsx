import type { Agent } from '../../../shared/types';
import { AgentAvatar } from '../../features/agents/AgentAvatar';
import type { NeedsAttentionItem } from './treeModel';
import { StatusDot } from './AgentRow';

/**
 * Pinned list of agents waiting on the user (docs/chrome-redesign-spec.md §2).
 * Hidden when empty. Each row gets a second line saying what is being asked.
 */
export function NeedsYou({ items, projectNames, activeAgentId, onSelect, onReview }: {
  items: NeedsAttentionItem[];
  projectNames: Record<string, string>;
  activeAgentId: string | null;
  onSelect: (agent: Agent) => void;
  onReview?: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label="Needs you" data-testid="needs-you" className="flex-shrink-0 pb-1">
      <div className="flex items-center px-3 pt-2 pb-1 text-xs font-semibold text-ctp-warning">
        <span>Needs you</span>
        <span className="ml-auto font-normal text-ctp-subtext0">{items.length}</span>
        {onReview && (
          <button type="button" onClick={onReview} className="ml-2 font-normal text-ctp-accent hover:underline cursor-pointer">
            Review
          </button>
        )}
      </div>
      <div className="flex flex-col gap-px px-1.5">
        {items.map(({ agent, reason, message }) => {
          const active = agent.id === activeAgentId;
          return (
            <button
              key={agent.id}
              type="button"
              data-testid={`needs-you-row-${agent.id}`}
              data-agent-id={agent.id}
              onClick={() => onSelect(agent)}
              className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer ${active ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
            >
              <span className="mt-1.5"><StatusDot dot={reason === 'permission' ? 'needs' : 'error'} /></span>
              <span className="mt-0.5 flex-shrink-0"><AgentAvatar agent={agent} size="2xs" /></span>
              <span className="min-w-0 flex-1 flex flex-col">
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="text-[13px] font-medium text-ctp-text truncate">{agent.name}</span>
                  <span className="text-xs text-ctp-overlay1 truncate">{projectNames[agent.projectId]}</span>
                </span>
                <span className={`text-xs truncate ${reason === 'permission' ? 'text-ctp-warning' : 'text-ctp-error'}`}>{message}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
