import React, { useMemo, useState, useEffect } from 'react';
import type { AgentCanvasView as AgentCanvasViewType, CanvasView } from './canvas-types';
import type { PluginAPI, AgentInfo } from '../../../../shared/plugin-types';

interface AgentCanvasViewProps {
  view: AgentCanvasViewType;
  api: PluginAPI;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

export function AgentCanvasView({ view, api, onUpdate }: AgentCanvasViewProps) {
  const [agentTick, setAgentTick] = useState(0);

  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);

  const agents = useMemo(() => api.agents.list(), [api, agentTick]);
  const assignedAgent = useMemo(
    () => view.agentId ? agents.find((a) => a.id === view.agentId) : null,
    [agents, view.agentId],
  );

  const handlePickAgent = (agent: AgentInfo) => {
    onUpdate({ agentId: agent.id, projectId: agent.projectId, title: agent.name || agent.id } as Partial<AgentCanvasViewType>);
  };

  // No agent assigned — show picker
  if (!view.agentId || !assignedAgent) {
    return (
      <div className="flex flex-col h-full p-2">
        <div className="text-xs text-ctp-subtext0 mb-2">Select an agent:</div>
        <div className="flex-1 overflow-y-auto space-y-1">
          {agents.length === 0 ? (
            <div className="text-xs text-ctp-overlay0 italic">No agents running</div>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[11px] text-ctp-text hover:bg-ctp-surface0 transition-colors text-left"
                onClick={() => handlePickAgent(agent)}
                data-testid={`canvas-agent-pick-${agent.id}`}
              >
                <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                <span className="truncate">{agent.name || agent.id}</span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  // Agent assigned — show terminal or sleeping widget
  // Use the agent's status from the agent list to determine running state
  const isRunning = assignedAgent.status === 'running' || assignedAgent.status === 'creating';

  if (isRunning) {
    return React.createElement(api.widgets.AgentTerminal, {
      agentId: view.agentId,
    });
  }

  return React.createElement(api.widgets.SleepingAgent, {
    agentId: view.agentId,
  });
}
