import { Modal } from '../../components/Modal';
import { StatusDot } from '../agents/agent-status';
import type { UpdateAgentAction } from '../../../shared/types';

export interface UpdateGateActionState {
  action: UpdateAgentAction;
  status: 'pending' | 'error' | 'timeout';
  message?: string;
}

export interface UpdateGateAgent {
  agentId: string;
  agentName: string;
  projectPath: string;
  orchestrator: string;
  isWorking: boolean;
  resumeStrategy: 'auto' | 'manual';
  dispatcherRole?: 'work' | 'chat';
}

interface UpdateGateModalProps {
  agents: UpdateGateAgent[];
  actionStates?: Record<string, UpdateGateActionState>;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onResolveAgent: (agentId: string, action: UpdateAgentAction) => void;
}

export function UpdateGateModal({ agents, actionStates = {}, loading = false, error, onRetry, onCancel, onConfirm, onResolveAgent }: UpdateGateModalProps) {
  const needsAction = (agent: UpdateGateAgent) => agent.isWorking || !!actionStates[agent.agentId];
  const workingAgents = agents.filter(needsAction);
  const idleAgents = agents.filter((a) => !needsAction(a));
  const restartDisabled = loading || !!error || workingAgents.length > 0;

  return (
    <Modal open={true} onClose={onCancel} aria-label="Update ready" width="w-full max-w-lg mx-4">
        <h2 className="text-base font-semibold text-ctp-text mb-4">Update ready</h2>
        <p className="text-xs text-ctp-subtext0 mb-4">
          Interrupt ends the current turn. For agents that resume after restart, only the conversation resumes, not the interrupted turn.
          {' '}Stop now ends the agent and excludes it from resuming after restart.
        </p>
        {loading && <p role="status" className="text-xs text-ctp-subtext0 mb-2">Checking active agents.</p>}
        {error && <p role="alert" className="text-xs text-ctp-text mb-2">
          {error} <button onClick={onRetry} className="underline cursor-pointer">Try again</button>
        </p>}

        {workingAgents.length > 0 && (
          <div className="mb-4">
            <div className="text-xs text-ctp-subtext0 mb-2">Needs attention</div>
            {workingAgents.map((agent) => {
              const state = actionStates[agent.agentId];
              const pending = state?.status === 'pending';
              return (
                <div key={agent.agentId} className="bg-surface-0 border border-surface-2 rounded-lg px-3 py-2.5 mb-1.5" aria-busy={pending}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StatusDot dot="working" />
                      <span className="text-sm text-ctp-text font-medium">{agent.agentName}</span>
                      <span role={pending ? 'status' : undefined} className="text-xs text-ctp-subtext0">
                        {pending ? state.action === 'kill' ? 'Stopping...' : 'Interrupting...' : agent.isWorking ? 'Working' : 'Idle'}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        disabled={pending || state?.action === 'kill'}
                        onClick={() => onResolveAgent(agent.agentId, 'interrupt')}
                        className="px-3 py-1 text-xs rounded-md bg-surface-1 border border-surface-2 text-ctp-text
                          hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                      >
                        Interrupt
                      </button>
                      <button
                        disabled={pending}
                        onClick={() => onResolveAgent(agent.agentId, 'kill')}
                        className="px-3 py-1 text-xs rounded-md bg-surface-1 border border-surface-2 text-ctp-text
                          hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                      >
                        Stop now
                      </button>
                    </div>
                  </div>
                  {agent.dispatcherRole === 'work' && <p className="text-xs text-ctp-subtext0 mt-2">
                    The Dispatcher's background agent carries out hand-offs. Interrupt or Stop now can end work in progress.
                    After restart it resumes when next needed, not immediately.
                  </p>}
                  {state?.message && <p role="alert" className="text-xs text-ctp-text mt-2">{state.message}</p>}
                </div>
              );
            })}
          </div>
        )}

        {idleAgents.length > 0 && (
          <div className="mb-4">
            <div className="text-xs text-ctp-subtext0 mb-2">
              Conversations after restart
            </div>
            {idleAgents.map((agent) => (
              <div key={agent.agentId} className="flex items-center justify-between bg-surface-0 border border-surface-2 rounded-lg px-3 py-2.5 mb-1.5">
                <div className="flex items-center gap-2">
                  <StatusDot dot="idle" />
                  <span className="text-sm text-ctp-text font-medium">{agent.agentName}</span>
                </div>
                <span className="text-xs text-ctp-subtext0">
                  {agent.dispatcherRole === 'work' ? 'Resumes when next needed'
                    : agent.resumeStrategy === 'auto' ? 'Auto-resume' : 'Manual resume'}
                </span>
              </div>
            ))}
          </div>
        )}

        {restartDisabled && <p id="update-gate-restart-reason" className="text-xs text-ctp-subtext0">
          {loading || error
            ? 'Restart is unavailable until active agents can be checked.'
            : 'Restart is unavailable while agents are working or an action needs attention. Wait for idle, interrupt, or choose Stop now.'}
        </p>}
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
            disabled={restartDisabled}
            aria-describedby={restartDisabled ? 'update-gate-restart-reason' : undefined}
            className={`px-4 py-1.5 text-xs rounded-md transition-colors font-medium ${
              restartDisabled
                ? 'bg-surface-1 text-ctp-subtext0/40 cursor-not-allowed'
                : 'bg-ctp-accent text-ctp-on-accent hover:bg-ctp-accent/80 cursor-pointer'
            }`}
          >
            Restart now
          </button>
        </div>
    </Modal>
  );
}
