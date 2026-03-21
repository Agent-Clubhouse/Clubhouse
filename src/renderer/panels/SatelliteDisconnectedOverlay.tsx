/**
 * Overlay shown when a remote project's satellite is not connected.
 *
 * Renders a semi-transparent dimmed layer over the content so the last
 * snapshot is faintly visible underneath, with a connection status message
 * and a retry button.
 */
import { useCallback } from 'react';
import { useAnnexClientStore, type SatelliteState } from '../stores/annexClientStore';

interface Props {
  satelliteId: string;
  satelliteAlias: string;
  satelliteState: SatelliteState;
}

export function SatelliteDisconnectedOverlay({ satelliteId, satelliteAlias, satelliteState }: Props) {
  const retry = useAnnexClientStore((s) => s.retry);

  const handleRetry = useCallback(() => {
    retry(satelliteId);
  }, [retry, satelliteId]);

  const isRetrying = satelliteState === 'connecting' || satelliteState === 'discovering';

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-ctp-base/80 z-10" data-testid="satellite-disconnected-overlay">
      <div className="text-center">
        {/* Disconnected icon */}
        <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-surface-2 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-subtext0">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
        </div>
        <p className="text-sm text-ctp-subtext0 font-medium">
          Connection to {satelliteAlias} is not live
        </p>
        <p className="text-xs text-ctp-overlay0 mt-1">
          {isRetrying ? 'Attempting to reconnect\u2026' : 'The remote machine may be offline or unreachable'}
        </p>
        {!isRetrying ? (
          <button
            onClick={handleRetry}
            className="mt-3 px-3 py-1.5 text-xs font-medium rounded-md bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 transition-colors"
            data-testid="satellite-retry-button"
          >
            Retry Connection
          </button>
        ) : (
          <div className="mt-3 flex items-center justify-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-xs text-ctp-overlay0">Reconnecting</span>
          </div>
        )}
      </div>
    </div>
  );
}
