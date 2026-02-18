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
      className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 text-blue-200 text-sm"
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
            <span className="text-blue-300/60 ml-1" data-testid="update-release-message">&mdash; {status.releaseMessage}</span>
          ) : '.'}
        </span>
      )}

      {confirming ? (
        <>
          <button
            onClick={handleRestart}
            className="px-3 py-1 text-xs rounded bg-blue-500/20 hover:bg-blue-500/30
              transition-colors cursor-pointer"
            data-testid="update-confirm-restart"
          >
            Restart anyway
          </button>
          <button
            onClick={handleCancel}
            className="text-blue-200/50 hover:text-blue-200 transition-colors cursor-pointer px-2 text-xs"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={handleRestart}
            className="px-3 py-1 text-xs rounded bg-blue-500/20 hover:bg-blue-500/30
              transition-colors cursor-pointer"
            data-testid="update-restart-btn"
          >
            Restart to update
          </button>
          <button
            onClick={dismiss}
            className="text-blue-200/50 hover:text-blue-200 transition-colors cursor-pointer px-1"
            data-testid="update-dismiss-btn"
          >
            x
          </button>
        </>
      )}
    </div>
  );
}
