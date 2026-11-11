import { useState } from 'react';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useAgentStore } from '../../../stores/agentStore';
import { useDispatcherStore, visibleDispatcherAgentId } from '../../dispatcher/dispatcherStore';
import { DISPATCHER_PROJECT_ID } from '../../../../shared/dispatcher-types';
import { requestLeaveAgentSettings } from '../agentSettingsPages';
import { useAgentDetailsStore } from '../details/detailsStore';
import { openAgent } from './orchestration-hooks';

/** The same route to connection controls from permissions settings and canvas wires. */
export function AgentConnectionSummary({ agentId, onNavigate }: { agentId: string; onNavigate?: () => void }) {
  const bindings = useMcpBindingStore((s) => s.bindings);
  const agent = useAgentStore((s) => s.agents[agentId]);
  const dispatcher = useDispatcherStore((s) => s.state);
  const [error, setError] = useState(false);
  const count = new Set(bindings.filter((b) => b.agentId === agentId && b.targetKind === 'agent').map((b) => b.targetId)).size;

  const edit = () => {
    const isDispatcher = dispatcher?.agentId === agentId || dispatcher?.chatAgentId === agentId;
    const id = isDispatcher ? visibleDispatcherAgentId() : agent?.id;
    const projectId = isDispatcher ? DISPATCHER_PROJECT_ID : agent?.projectId;
    if (!id || !projectId) {
      setError(true);
      return;
    }
    requestLeaveAgentSettings(() => {
      openAgent(projectId, id);
      useAgentDetailsStore.getState().reveal({ agentId: id, card: 'connections' });
      onNavigate?.();
    });
  };

  return (
    <div className="mb-2 space-y-1 text-xs text-ctp-overlay1" data-testid="agent-connection-summary">
      <p>{count} outgoing {count === 1 ? 'connection' : 'connections'}.</p>
      {count === 0 && <p>These grants currently reach no agents because there are no outgoing connections.</p>}
      <p>Connected-agent tools also need the sender's Clubhouse permission and the tool's per-direction switch. The reverse direction has its own switches.</p>
      <button type="button" className="text-ctp-link hover:underline cursor-pointer focus-ring rounded-sm" onClick={edit}>Edit connections</button>
      {error && <p role="alert">Couldn't open this agent's Connections card. Open the agent and try again.</p>}
    </div>
  );
}
