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
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl shadow-2xl max-w-lg w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ctp-text mb-4">Update Ready — Active Agents</h2>

        {workingAgents.length > 0 && (
          <div className="mb-4">
            <div className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2">Still working</div>
            {workingAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between bg-surface-0 border border-surface-2 rounded-lg px-3 py-2.5 mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-ctp-red animate-pulse" />
                  <span className="text-sm text-ctp-text font-medium">{agent.agentName}</span>
                  <span className="text-xs text-ctp-subtext0">actively generating</span>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => onResolveAgent(agent.agentId, 'wait')}
                    className="px-3 py-1 text-xs rounded-md bg-surface-1 border border-surface-2 text-ctp-subtext1
                      hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer"
                  >
                    Wait
                  </button>
                  <button
                    onClick={() => onResolveAgent(agent.agentId, 'interrupt')}
                    className="px-3 py-1 text-xs rounded-md bg-ctp-peach/15 border border-ctp-peach/30 text-ctp-peach
                      hover:bg-ctp-peach/25 transition-colors cursor-pointer font-medium"
                  >
                    Interrupt & Resume
                  </button>
                  <button
                    onClick={() => onResolveAgent(agent.agentId, 'kill')}
                    className="px-3 py-1 text-xs rounded-md bg-ctp-red/15 border border-ctp-red/30 text-ctp-red
                      hover:bg-ctp-red/25 transition-colors cursor-pointer font-medium"
                  >
                    Kill
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {idleAgents.length > 0 && (
          <div className="mb-4">
            <div className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2">
              {workingAgents.length > 0 ? 'Will resume after restart' : 'All agents will resume after restart'}
            </div>
            {idleAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between bg-surface-0 border border-surface-2 rounded-lg px-3 py-2.5 mb-1.5">
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full ${agent.resumeStrategy === 'auto' ? 'bg-ctp-green' : 'bg-ctp-yellow'}`} />
                  <span className="text-sm text-ctp-text font-medium">{agent.agentName}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  agent.resumeStrategy === 'auto'
                    ? 'bg-ctp-green/10 text-ctp-green border border-ctp-green/20'
                    : 'bg-ctp-yellow/10 text-ctp-yellow border border-ctp-yellow/20'
                }`}>
                  {agent.resumeStrategy === 'auto' ? 'Auto-resume' : 'Manual resume'}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-surface-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md bg-surface-1 text-ctp-subtext1
              hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            data-testid="update-gate-restart-btn"
            onClick={onConfirm}
            disabled={hasWorking}
            className={`px-4 py-1.5 text-xs rounded-md transition-colors font-medium ${
              hasWorking
                ? 'bg-surface-1 text-ctp-subtext0/40 cursor-not-allowed'
                : 'bg-indigo-500 text-white hover:bg-indigo-600 cursor-pointer'
            }`}
          >
            Restart Now
          </button>
        </div>
      </div>
    </div>
  );
}
