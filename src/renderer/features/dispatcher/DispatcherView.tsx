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
import { useDispatcherWorkOpen } from './dispatcherDebug';
import { DispatcherWorkView } from './DispatcherWorkView';
import { usePopouts } from '../../hooks/usePopouts';
import { PoppedOutPlaceholder } from '../popout/PoppedOutPlaceholder';
import { useFollowedLead } from './leadStore';
import { FollowerDispatcherView } from './FollowerDispatcherView';
import { useRemoteDispatcherSelection } from './remoteDispatcherSelection';
import { parseNamespacedId, useRemoteProjectStore } from '../../stores/remoteProjectStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';

/**
 * The Dispatcher's own view (#2538): the same agent pane a project agent
 * gets (chat or terminal, the sleeping view, Agent details), shown without
 * an active project. Its settings live in Settings > Dispatcher, which the
 * ⋯ menu and the details Settings card link to.
 *
 * Until it is set up (#3047) the view shows setup instead, and setup opened
 * again from the chat or its menu shows here too. After Set up later, a line
 * above the chat offers it again.
 *
 * With the debug view on (#3188), its controller's row shows that agent's chat
 * here instead, read-only.
 *
 * While its chat is popped out (#3235) the view shows where it went, as a
 * project agent's pane does; setup still shows here.
 *
 * On a computer following another's lead (#3352), the view is the lead's chat
 * (FollowerDispatcherView) until a person takes back.
 */
export function DispatcherView() {
  const agentId = useDispatcherAgentId();
  const agent = useAgentStore((s) => (agentId ? s.agents[agentId] : undefined));
  const loadError = useDispatcherStore((s) => s.loadError);
  const retryLoad = useDispatcherStore((s) => s.retryLoad);
  const state = useDispatcherStore((s) => s.state);
  const setupOpen = useDispatcherStore((s) => s.setupOpen);
  const setSetupOpen = useDispatcherStore((s) => s.setSetupOpen);
  const workOpen = useDispatcherWorkOpen();
  const { findAgentPopout } = usePopouts();
  const followed = useFollowedLead();
  const remoteId = useRemoteDispatcherSelection((s) => s.agentId);
  const localSelected = useRemoteDispatcherSelection((s) => s.local);
  const remoteAgent = useRemoteProjectStore((s) => remoteId ? s.remoteAgents[remoteId] : undefined);
  const remoteSatellite = remoteId ? parseNamespacedId(remoteId)?.satelliteId : undefined;
  const remoteMachine = useAnnexClientStore((s) => s.satellites.find((sat) => sat.id === remoteSatellite)?.fingerprint.toLowerCase());
  const selectedLead = !!remoteId && !!followed && (remoteId === followed.agent?.id || remoteMachine === followed.state.lead?.machine);

  // A false→true change is what moves focus into the terminal (AgentTerminal).
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setFocused(true));
    return () => cancelAnimationFrame(raf);
  }, [agentId]);

  if (remoteId && !selectedLead) return remoteAgent
    ? <AgentRuntimePane key={remoteId} agent={{ ...remoteAgent, executionMode: 'chat' }} terminal={null} canSwitch={false} />
    : <p role="status">Waiting for the other Dispatcher to connect.</p>;

  if (workOpen && state?.agentId) return <DispatcherWorkView agentId={state.agentId} />;

  // Following another computer's lead (#3352): its chat, with this computer's kept one click away.
  if (followed && state?.chatAgentId) {
    return <FollowerDispatcherView earlier={localSelected} onEarlierChange={(earlier) => useRemoteDispatcherSelection.getState().select(null, earlier)} lead={followed} localChatId={state.chatAgentId} localName={agent?.name ?? state.config?.name ?? 'Dispatcher'} />;
  }

  const setupStatus = state?.setup?.status;
  if (state?.config && (setupStatus === 'pending' || setupOpen)) {
    return (
      <div className="relative h-full bg-ctp-base" data-testid="dispatcher-view" data-agent-id={agentId ?? undefined}>
        <DispatcherSetup state={state} reopened={setupStatus !== 'pending'} onClose={() => setSetupOpen(false)} />
      </div>
    );
  }

  const popout = agentId ? findAgentPopout(agentId) : undefined;
  if (agent && popout) {
    return (
      <div className="relative h-full bg-ctp-base" data-testid="dispatcher-view" data-agent-id={agent.id}>
        <PoppedOutPlaceholder type="agent" name={agent.name} agentId={agent.id} windowId={popout.windowId} />
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
