import { useState } from 'react';
import type { SatelliteConnection } from '../../stores/annexClientStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { getAgentColorHex } from '../../../shared/name-generator';
import { Button } from '../../components/Button';

interface Props {
  satellites: SatelliteConnection[];
}


function StatusDot({ state, lastError }: { state: SatelliteConnection['state']; lastError?: string | null }) {
  const isIncompatible = lastError?.toLowerCase().includes('incompatible');
  const colors: Record<string, string> = {
    connected: 'bg-ctp-success',
    connecting: 'bg-ctp-warning animate-pulse',
    discovering: 'bg-ctp-info animate-pulse',
    disconnected: 'bg-surface-2',
  };
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isIncompatible ? 'bg-ctp-error' : colors[state] || 'bg-surface-2'}`} />;
}

function stateLabel(state: SatelliteConnection['state'], lastError?: string | null): string {
  if (lastError?.toLowerCase().includes('incompatible')) return 'Incompatible';
  switch (state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting…';
    case 'discovering': return 'Discovering…';
    case 'disconnected': return 'Offline';
  }
}

export function PairedSatelliteList({ satellites }: Props) {
  const disconnect = useAnnexClientStore((s) => s.disconnect);
  const retry = useAnnexClientStore((s) => s.retry);
  const forgetSatellite = useAnnexClientStore((s) => s.forgetSatellite);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);

  // Sort: connected first, then alphabetical
  const sorted = [...satellites].sort((a, b) => {
    if (a.state === 'connected' && b.state !== 'connected') return -1;
    if (a.state !== 'connected' && b.state === 'connected') return 1;
    return a.alias.localeCompare(b.alias);
  });

  return (
    <div data-testid="paired-satellite-list">
      {sorted.map((sat) => (
        <div
          key={sat.id}
          className="flex items-center gap-3 min-h-[46px] py-2 border-t border-surface-0"
        >
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div
              className="w-[18px] h-[18px] rounded flex items-center justify-center text-xs font-bold leading-none shrink-0"
              style={{ backgroundColor: `${getAgentColorHex(sat.color)}33`, color: getAgentColorHex(sat.color) }}
              aria-hidden="true"
            >
              {sat.alias.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] text-ctp-text truncate">{sat.alias}</div>
              <div className="flex items-center gap-1.5 text-xs text-ctp-overlay1 min-w-0">
                <StatusDot state={sat.state} lastError={sat.lastError} />
                <span>{stateLabel(sat.state, sat.lastError)}</span>
                {sat.lastError && sat.state === 'disconnected' && (
                  <span className="text-ctp-error truncate">({sat.lastError})</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-1.5 shrink-0">
            {sat.state === 'disconnected' && (
              <Button onClick={() => retry(sat.fingerprint)} kind="ghost">
                Retry
              </Button>
            )}
            {sat.state === 'connected' && (
              <Button onClick={() => disconnect(sat.fingerprint)} kind="ghost">
                Disconnect
              </Button>
            )}
            {confirmForget === sat.fingerprint ? (
              <>
                <Button onClick={() => setConfirmForget(null)} kind="ghost">
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    forgetSatellite(sat.fingerprint);
                    setConfirmForget(null);
                  }}
                  kind="danger"
                >
                  Confirm
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirmForget(sat.fingerprint)} kind="danger">
                Forget
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
