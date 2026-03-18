import type { SatelliteConnection } from '../../stores/annexClientStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { AGENT_COLORS } from '../../../shared/name-generator';

interface Props {
  satellites: SatelliteConnection[];
}

function getColorHex(colorId: string): string {
  const color = AGENT_COLORS.find((c) => c.id === colorId);
  return color?.hex || '#6366f1';
}

function StatusDot({ state }: { state: SatelliteConnection['state'] }) {
  const colors: Record<string, string> = {
    connected: 'bg-emerald-500',
    connecting: 'bg-amber-500 animate-pulse',
    discovering: 'bg-cyan-500 animate-pulse',
    disconnected: 'bg-surface-2',
  };
  return <span className={`w-2 h-2 rounded-full ${colors[state] || 'bg-surface-2'}`} />;
}

function stateLabel(state: SatelliteConnection['state']): string {
  switch (state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting...';
    case 'discovering': return 'Discovering...';
    case 'disconnected': return 'Offline';
  }
}

export function PairedSatelliteList({ satellites }: Props) {
  const disconnect = useAnnexClientStore((s) => s.disconnect);
  const retry = useAnnexClientStore((s) => s.retry);

  // Sort: connected first, then alphabetical
  const sorted = [...satellites].sort((a, b) => {
    if (a.state === 'connected' && b.state !== 'connected') return -1;
    if (a.state !== 'connected' && b.state === 'connected') return 1;
    return a.alias.localeCompare(b.alias);
  });

  return (
    <div className="space-y-2">
      {sorted.map((sat) => (
        <div
          key={sat.id}
          className="flex items-center justify-between py-2 px-3 rounded bg-surface-0"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
              style={{ backgroundColor: getColorHex(sat.color) }}
            >
              {sat.alias.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-sm text-ctp-text font-medium truncate">{sat.alias}</div>
              <div className="flex items-center gap-1.5 text-xs text-ctp-subtext0">
                <StatusDot state={sat.state} />
                <span>{stateLabel(sat.state)}</span>
                {sat.lastError && sat.state === 'disconnected' && (
                  <span className="text-ctp-error ml-1 truncate">({sat.lastError})</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-1.5 shrink-0">
            {sat.state === 'disconnected' && (
              <button
                onClick={() => retry(sat.fingerprint)}
                className="px-2 py-1 text-xs rounded bg-surface-1 hover:bg-surface-2
                  transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
              >
                Retry
              </button>
            )}
            {sat.state === 'connected' && (
              <button
                onClick={() => disconnect(sat.fingerprint)}
                className="px-2 py-1 text-xs rounded bg-surface-1 hover:bg-surface-2
                  transition-colors cursor-pointer text-ctp-subtext1 hover:text-ctp-text"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
