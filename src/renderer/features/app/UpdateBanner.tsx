import { useState } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { useAgentStore } from '../../stores/agentStore';

export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const applyUpdate = useUpdateStore((s) => s.applyUpdate);
  const agents = useAgentStore((s) => s.agents);
  const [confirming, setConfirming] = useState(false);

  // Only show when update is ready and not dismissed
  if (status.state !== 'ready' || dismissed) return null;

  const runningAgents = Object.values(agents).filter((a) => a.status === 'running');
  const hasRunningAgents = runningAgents.length > 0;

  const handleRestart = () => {
    if (hasRunningAgents && !confirming) {
      setConfirming(true);
      return;
    }
    applyUpdate();
  };

  const handleCancel = () => {
    setConfirming(false);
  };

  return (
    <div
      className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-ctp-info/10 border-b border-ctp-info/20 text-ctp-info text-sm"
      data-testid="update-banner"
    >
      {/* Info icon */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>

      {confirming ? (
        <span className="flex-1" data-testid="update-confirm-message">
          {runningAgents.length} running agent{runningAgents.length !== 1 ? 's' : ''} will be stopped. Continue?
        </span>
      ) : (
        <span className="flex-1">
          Update v{status.availableVersion} is ready
          {status.releaseMessage ? (
            <span className="text-ctp-info/60 ml-1" data-testid="update-release-message">&mdash; {status.releaseMessage}</span>
          ) : '.'}
        </span>
      )}

      {confirming ? (
        <>
          <button
            onClick={handleRestart}
            className="px-3 py-1 text-xs rounded bg-ctp-info/20 hover:bg-ctp-info/30
              transition-colors cursor-pointer"
            data-testid="update-confirm-restart"
          >
            Restart anyway
          </button>
          <button
            onClick={handleCancel}
            className="text-ctp-info/50 hover:text-ctp-info transition-colors cursor-pointer px-2 text-xs"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={handleRestart}
            className="px-3 py-1 text-xs rounded bg-ctp-info/20 hover:bg-ctp-info/30
              transition-colors cursor-pointer"
            data-testid="update-restart-btn"
          >
            Restart to update
          </button>
          <button
            onClick={dismiss}
            className="text-ctp-info/50 hover:text-ctp-info transition-colors cursor-pointer px-1"
            data-testid="update-dismiss-btn"
          >
            x
          </button>
        </>
      )}
    </div>
  );
}
