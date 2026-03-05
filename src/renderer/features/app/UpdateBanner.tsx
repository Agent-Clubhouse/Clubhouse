import { useState } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { useAgentStore } from '../../stores/agentStore';

export function UpdateBanner() {
  const status = useUpdateStore((s) => s.status);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const applyUpdate = useUpdateStore((s) => s.applyUpdate);
  const openUpdateDownload = useUpdateStore((s) => s.openUpdateDownload);
  const agents = useAgentStore((s) => s.agents);
  const [confirming, setConfirming] = useState(false);

  // Show when update is ready, or when apply failed with a manual download fallback
  const isReady = status.state === 'ready';
  const isApplyError = status.state === 'error' && !!status.artifactUrl;
  if ((!isReady && !isApplyError) || dismissed) return null;

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
      className={`flex-shrink-0 flex items-center gap-3 px-4 py-2 ${
        isApplyError
          ? 'bg-ctp-peach/10 border-b border-ctp-peach/20 text-ctp-peach'
          : 'bg-ctp-info/10 border-b border-ctp-info/20 text-ctp-info'
      } text-sm`}
      data-testid="update-banner"
    >
      {/* Info icon */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>

      {isApplyError ? (
        <span className="flex-1" data-testid="update-error-message">
          Update{status.availableVersion ? ` v${status.availableVersion}` : ''} failed to install
          {status.error ? <span className="opacity-60 ml-1">&mdash; {status.error}</span> : ''}
        </span>
      ) : confirming ? (
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

      {isApplyError ? (
        <>
          <button
            onClick={openUpdateDownload}
            className="px-3 py-1 text-xs rounded bg-ctp-peach/20 hover:bg-ctp-peach/30
              transition-colors cursor-pointer"
            data-testid="update-manual-download-btn"
          >
            Download manually
          </button>
          <button
            onClick={dismiss}
            className="text-ctp-peach/50 hover:text-ctp-peach transition-colors cursor-pointer px-1"
            data-testid="update-dismiss-btn"
          >
            x
          </button>
        </>
      ) : confirming ? (
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
          {status.artifactUrl && (
            <button
              onClick={openUpdateDownload}
              className="text-ctp-info/50 hover:text-ctp-info transition-colors cursor-pointer px-2 text-xs"
              data-testid="update-manual-download-btn"
            >
              Download manually
            </button>
          )}
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
