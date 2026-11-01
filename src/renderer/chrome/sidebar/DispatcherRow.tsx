import { useLayoutEffect, useRef } from 'react';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { AgentRow } from './AgentRow';
import { agentDot } from './treeModel';

/**
 * The Dispatcher's pinned row (#2538), above every project and shown with
 * none: the usual agent row (status dot, name, provider, activity, hover card
 * and menu), with a flat fill while its view is open. Its menu leaves out what
 * doesn't apply to it (useAgentRowActions). The row is a one-item tree of its
 * own, so it has its own tab stop rather than joining the project tree's.
 */
export function DispatcherRow({ agent, detailed, active, projectPath, onSelect }: {
  agent: Agent;
  detailed?: AgentDetailedStatus;
  active: boolean;
  projectPath?: string;
  onSelect: (agent: Agent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // AgentRow leaves the tab stop to its tree, as ProjectTree sets it.
  useLayoutEffect(() => {
    const item = ref.current?.querySelector<HTMLElement>('[role="treeitem"]');
    if (item) item.tabIndex = 0;
  });
  return (
    <div ref={ref} role="tree" aria-label="Dispatcher" data-testid="dispatcher-row" className="flex-shrink-0 px-1.5 pb-1">
      <AgentRow
        agent={agent}
        dot={agentDot(agent, detailed)}
        detailed={detailed}
        active={active}
        indent={8}
        projectPath={projectPath}
        onSelect={onSelect}
        level={1}
      />
    </div>
  );
}
