export interface UpdateGateAgent {
  agentId: string;
  agentName: string;
  projectPath: string;
  orchestrator: string;
  isWorking: boolean;
  resumeStrategy: 'auto' | 'manual';
}

interface UpdateGateModalProps {
  agents: UpdateGateAgent[];
  onCancel: () => void;
  onConfirm: () => void;
  onResolveAgent: (agentId: string, action: 'wait' | 'interrupt' | 'kill') => void;
}

export function UpdateGateModal({ agents, onCancel, onConfirm, onResolveAgent }: UpdateGateModalProps) {
  const workingAgents = agents.filter((a) => a.isWorking);
  const idleAgents = agents.filter((a) => !a.isWorking);
  const hasWorking = workingAgents.length > 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onCancel}>
      <div className="bg-ctp-mantle rounded-xl shadow-xl max-w-lg w-full mx-4 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-ctp-text text-sm font-semibold mb-3">Update Ready — Active Agents</h2>

        {workingAgents.length > 0 && (
          <div className="mb-3">
            <div className="text-ctp-subtext0 text-xs mb-2">These agents are still working:</div>
            {workingAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between bg-surface-0 rounded-lg px-3 py-2 mb-1">
                <div>
                  <span className="text-ctp-red mr-2 text-xs">●</span>
                  <span className="text-ctp-text text-xs font-medium">{agent.agentName}</span>
                  <span className="text-ctp-subtext0 text-xs ml-2">actively generating</span>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => onResolveAgent(agent.agentId, 'wait')} className="px-2 py-0.5 text-xs rounded bg-ctp-blue/20 hover:bg-ctp-blue/30 text-ctp-blue transition-colors cursor-pointer">Wait</button>
                  <button onClick={() => onResolveAgent(agent.agentId, 'interrupt')} className="px-2 py-0.5 text-xs rounded bg-ctp-peach/20 hover:bg-ctp-peach/30 text-ctp-peach transition-colors cursor-pointer">Interrupt & Resume</button>
                  <button onClick={() => onResolveAgent(agent.agentId, 'kill')} className="px-2 py-0.5 text-xs rounded bg-ctp-red/20 hover:bg-ctp-red/30 text-ctp-red transition-colors cursor-pointer">Kill</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {idleAgents.length > 0 && (
          <div className="mb-3">
            <div className="text-ctp-subtext0 text-xs mb-2">
              {workingAgents.length > 0 ? 'These agents will resume after restart:' : 'All agents will resume after restart:'}
            </div>
            {idleAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between bg-surface-0 rounded-lg px-3 py-2 mb-1">
                <div>
                  <span className={`mr-2 text-xs ${agent.resumeStrategy === 'auto' ? 'text-ctp-yellow' : 'text-ctp-blue'}`}>●</span>
                  <span className="text-ctp-text text-xs font-medium">{agent.agentName}</span>
                </div>
                <span className="text-ctp-subtext0 text-xs">
                  {agent.resumeStrategy === 'auto' ? '✓ Will auto-resume' : '⚠ Manual resume after restart'}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded bg-surface-1 hover:bg-surface-2 text-ctp-subtext0 transition-colors cursor-pointer">Cancel</button>
          <button
            data-testid="update-gate-restart-btn"
            onClick={onConfirm}
            disabled={hasWorking}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${hasWorking ? 'bg-ctp-info/10 text-ctp-info/40 cursor-not-allowed' : 'bg-ctp-info/20 hover:bg-ctp-info/30 text-ctp-info cursor-pointer'}`}
          >Restart Now</button>
        </div>
      </div>
    </div>
  );
}
