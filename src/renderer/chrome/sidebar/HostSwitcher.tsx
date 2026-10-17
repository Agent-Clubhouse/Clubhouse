import { useCallback, useEffect, useRef, useState } from 'react';
import type { SatelliteConnection, SatelliteState } from '../../stores/annexClientStore';
import { getChromeSurface, reportChromeSurface, type ChromeSurface } from '../telemetry';
import { useClickOutside } from './useClickOutside';

/**
 * The host pill (docs/chrome-redesign-spec.md §2, hosts option 1): a 28px row
 * at the top of the sidebar naming the host shown below it. Its menu lists
 * Local and every paired satellite with its connection state, Retry for one
 * that is not connected, “Pair a satellite…” and Annex settings. Shown only
 * once a satellite is paired. No default shortcut.
 */

export const LOCAL_HOST = 'local';

const STATE_LABEL: Record<SatelliteState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  discovering: 'Looking for it…',
  disconnected: 'Offline',
};

function StateDot({ state }: { state: SatelliteState | 'local' }) {
  const color = state === 'local' || state === 'connected'
    ? 'bg-ctp-success'
    : state === 'disconnected' ? 'bg-surface-2' : 'bg-ctp-warning';
  return <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${color}`} />;
}

const Chevron = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const itemClass = 'w-full px-3 py-1.5 flex items-center gap-2 text-left text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer';

export function HostSwitcher({ satellites, activeHostId, needsByHost, onSwitch, onRetry, onPair, onAnnexSettings }: {
  satellites: SatelliteConnection[];
  activeHostId: string | null;
  /** Agents waiting on the user, keyed by satellite id or LOCAL_HOST. */
  needsByHost: Record<string, number>;
  onSwitch: (hostId: string | null) => void;
  onRetry: (satellite: SatelliteConnection) => void;
  onPair: () => void;
  onAnnexSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, open, close);

  // Keyboard: the first item takes focus on open, arrows move, Esc returns to the pill.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [open]);
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false); if (e.key === 'Escape') buttonRef.current?.focus(); }
  };

  // While the menu is open it is where the user is (spec §8).
  const previousSurface = useRef<ChromeSurface | null>(null);
  useEffect(() => {
    if (!open) return;
    previousSurface.current = getChromeSurface();
    reportChromeSurface('host_menu');
    return () => { if (previousSurface.current) reportChromeSurface(previousSurface.current); };
  }, [open]);

  if (satellites.length === 0) return null;

  const active = activeHostId ? satellites.find((s) => s.id === activeHostId) : undefined;
  const elsewhere = Object.entries(needsByHost)
    .filter(([host]) => host !== (activeHostId ?? LOCAL_HOST))
    .reduce((n, [, count]) => n + count, 0);
  // Connected first, then by name, as in the legacy rail.
  const sorted = [...satellites].sort((a, b) =>
    (a.state === 'connected' ? 0 : 1) - (b.state === 'connected' ? 0 : 1) || a.alias.localeCompare(b.alias));

  const pick = (hostId: string | null) => { setOpen(false); buttonRef.current?.focus(); onSwitch(hostId); };
  const needsLabel = (host: string) => (needsByHost[host] ? <span className="ml-auto text-ctp-warning">{needsByHost[host]} waiting</span> : null);

  return (
    <div ref={ref} className="relative flex-shrink-0 px-2 pb-1">
      <button
        ref={buttonRef}
        type="button"
        data-testid="host-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full h-7 px-2 rounded-md flex items-center gap-2 text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
      >
        <StateDot state={active ? active.state : 'local'} />
        <span className="truncate font-medium text-ctp-text">{active ? active.alias : 'Local'}</span>
        {active && active.state !== 'connected' && <span className="text-ctp-overlay1">{STATE_LABEL[active.state]}</span>}
        {elsewhere > 0 && (
          <span className="ml-auto text-ctp-warning" title={`${elsewhere} waiting on other hosts`}>{elsewhere} elsewhere</span>
        )}
        <span className={`${elsewhere > 0 ? '' : 'ml-auto'} text-ctp-overlay1`}>{Chevron}</span>
      </button>
      {open && (
        <div ref={menuRef} onKeyDown={onMenuKeyDown} role="menu" aria-label="Hosts" data-testid="host-menu" className="absolute left-2 right-2 top-8 z-dropdown py-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl">
          <button type="button" role="menuitemradio" aria-checked={!activeHostId} data-testid="host-menu-local" onClick={() => pick(null)} className={itemClass}>
            <StateDot state="local" />
            <span className={!activeHostId ? 'text-ctp-text font-medium' : ''}>Local</span>
            {needsLabel(LOCAL_HOST)}
          </button>
          {sorted.map((sat) => (
            <div key={sat.id} className="flex items-center">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={sat.id === activeHostId}
                data-testid={`host-menu-${sat.id}`}
                onClick={() => pick(sat.id)}
                className={`${itemClass} min-w-0 flex-1`}
              >
                <StateDot state={sat.state} />
                <span className={`truncate ${sat.id === activeHostId ? 'text-ctp-text font-medium' : ''}`}>{sat.alias}</span>
                <span className="text-ctp-overlay1 flex-shrink-0">{STATE_LABEL[sat.state]}</span>
                {needsLabel(sat.id)}
              </button>
              {sat.state === 'disconnected' && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`host-retry-${sat.id}`}
                  onClick={() => onRetry(sat)}
                  className="flex-shrink-0 px-3 py-1.5 text-xs text-ctp-accent hover:underline cursor-pointer"
                >
                  Retry
                </button>
              )}
            </div>
          ))}
          <div className="h-px my-1 bg-surface-0" />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onPair(); }} className={itemClass}>Pair a satellite…</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onAnnexSettings(); }} className={itemClass}>Annex settings</button>
        </div>
      )}
    </div>
  );
}
