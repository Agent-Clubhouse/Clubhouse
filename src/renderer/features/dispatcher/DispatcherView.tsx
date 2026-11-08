import { useEffect, useState } from 'react';
import { useAgentStore } from '../../stores/agentStore';
import { AgentTerminal } from '../agents/AgentTerminal';
import { AgentRuntimePane } from '../agents/chat/AgentRuntimePane';
import { SleepingAgent } from '../agents/SleepingAgent';
import { HeadlessAgentView } from '../agents/HeadlessAgentView';
import { Button } from '../../components/Button';
import { useDispatcherAgentId, useDispatcherStore } from './dispatcherStore';
import { DispatcherSetup } from './DispatcherSetup';
import { SetupOffer } from './SetupOffer';

/**
 * The Dispatcher's own view (#2538): the same agent pane a project agent
 * gets (chat or terminal, the sleeping view, Agent details), shown without
 * an active project. Its settings live in Settings > Dispatcher, which the
 * ⋯ menu and the details Settings card link to.
 *
 * Until it is set up (#3047) the view shows setup instead, and setup opened
 * again from the chat or its menu shows here too. After Set up later, a line
 * above the chat offers it again.
 */
export function DispatcherView() {
  const agentId = useDispatcherAgentId();
  const agent = useAgentStore((s) => (agentId ? s.agents[agentId] : undefined));
  const loadError = useDispatcherStore((s) => s.loadError);
  const retryLoad = useDispatcherStore((s) => s.retryLoad);
  const state = useDispatcherStore((s) => s.state);
  const setupOpen = useDispatcherStore((s) => s.setupOpen);
  const setSetupOpen = useDispatcherStore((s) => s.setSetupOpen);

  // A false→true change is what moves focus into the terminal (AgentTerminal).
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setFocused(true));
    return () => cancelAnimationFrame(raf);
  }, [agentId]);

  const setupStatus = state?.setup?.status;
  if (state?.config && (setupStatus === 'pending' || setupOpen)) {
    return (
      <div className="relative h-full bg-ctp-base" data-testid="dispatcher-view" data-agent-id={agentId ?? undefined}>
        <DispatcherSetup state={state} reopened={setupStatus !== 'pending'} onClose={() => setSetupOpen(false)} />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-ctp-base" data-testid="dispatcher-view">
        {loadError ? (
          <>
            <p role="alert" className="max-w-md text-center text-sm text-ctp-error" data-testid="dispatcher-load-error">
              Couldn’t load the Dispatcher. {loadError}
            </p>
            <Button onClick={retryLoad}>Retry</Button>
          </>
        ) : (
          <p className="text-sm text-ctp-subtext0" role="status">Loading the Dispatcher</p>
        )}
      </div>
    );
  }

  let pane: React.ReactNode;
  if (agent.status === 'sleeping' || agent.status === 'error') pane = <SleepingAgent agent={agent} details />;
  else if (agent.headless) pane = <HeadlessAgentView agent={agent} />;
  else pane = <AgentRuntimePane key={agent.id} agent={agent} terminal={<AgentTerminal agentId={agent.id} focused={focused} />} />;

  if (setupStatus === 'later') {
    return (
      <div className="relative h-full flex flex-col bg-ctp-base" data-testid="dispatcher-view" data-agent-id={agent.id}>
        <SetupOffer name={agent.name} />
        <div className="flex-1 min-h-0">{pane}</div>
      </div>
    );
  }

  return (
    <div className="relative h-full bg-ctp-base" data-testid="dispatcher-view" data-agent-id={agent.id}>
      {pane}
    </div>
  );
}
