import { useEffect, useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { AgentTerminal } from '../agents/AgentTerminal';
import { AgentRuntimePane } from '../agents/chat/AgentRuntimePane';
import { SleepingAgent } from '../agents/SleepingAgent';
import { HeadlessAgentView } from '../agents/HeadlessAgentView';
import { useDispatcherAgentId } from './dispatcherStore';

/**
 * The Dispatcher's own view (#2538): the same agent pane a project agent
 * gets (chat or terminal, the sleeping view, Agent details), shown without
 * an active project. Its settings live in Settings > Dispatcher, which the
 * ⋯ menu and the details Settings card link to.
 */
export function DispatcherView() {
  const agentId = useDispatcherAgentId();
  const agent = useAgentStore((s) => (agentId ? s.agents[agentId] : undefined));

  // A false→true change is what moves focus into the terminal (AgentTerminal).
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setFocused(true));
    return () => cancelAnimationFrame(raf);
  }, [agentId]);

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center bg-ctp-base" data-testid="dispatcher-view">
        <p className="text-sm text-ctp-subtext0">Loading the Dispatcher</p>
      </div>
    );
  }

  let pane: React.ReactNode;
  if (agent.status === 'sleeping' || agent.status === 'error') pane = <SleepingAgent agent={agent} details />;
  else if (agent.headless) pane = <HeadlessAgentView agent={agent} />;
  else pane = <AgentRuntimePane key={agent.id} agent={agent} terminal={<AgentTerminal agentId={agent.id} focused={focused} />} />;

  return (
    <div className="relative h-full bg-ctp-base" data-testid="dispatcher-view" data-agent-id={agent.id}>
      {pane}
    </div>
  );
}
