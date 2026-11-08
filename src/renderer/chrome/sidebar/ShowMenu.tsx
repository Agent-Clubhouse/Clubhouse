import { useCallback, useEffect, useRef, useState } from 'react';
import type { SatelliteConnection, SatelliteState } from '../../stores/annexClientStore';
import { holdChromeSurface } from '../telemetry';
import { useClickOutside } from './useClickOutside';
import type { ShowFilter } from './networkTree';

/**
 * Show (#3065): narrows the sidebar's one list to one machine. A dropdown, not
 * buttons, so it works with any number of machines. Every machine's agents are
 * listed together by default; this replaces the host pill, which switched the
 * whole sidebar to one machine. Shown once another machine is paired.
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

export function ShowMenu({ satellites, show, needsByHost, onShow, onRetry, onAnnexSettings }: {
  satellites: SatelliteConnection[];
  show: ShowFilter;
  /** Agents waiting on the user, keyed by machine id or LOCAL_HOST. */
  needsByHost: Record<string, number>;
  onShow: (show: ShowFilter) => void;
  onRetry: (satellite: SatelliteConnection) => void;
  onAnnexSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, open, close);

  // Keyboard: the first item takes focus on open, arrows move, Esc returns to the button.
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
  useEffect(() => (open ? holdChromeSurface('host_menu') : undefined), [open]);

  if (satellites.length === 0) return null;

  const machine = show !== 'all' && show !== 'local' ? satellites.find((s) => s.id === show) : undefined;
  const label = show === 'local' ? 'This computer' : machine ? machine.alias : 'All computers';
  // Connected first, then by name.
  const sorted = [...satellites].sort((a, b) =>
    (a.state === 'connected' ? 0 : 1) - (b.state === 'connected' ? 0 : 1) || a.alias.localeCompare(b.alias));
  const hidden = show === 'all' ? 0 : Object.entries(needsByHost)
    .filter(([host]) => host !== (show === 'local' ? LOCAL_HOST : show))
    .reduce((n, [, count]) => n + count, 0);

  const pick = (next: ShowFilter) => { setOpen(false); buttonRef.current?.focus(); onShow(next); };
  const needsLabel = (host: string) => (needsByHost[host] ? <span className="ml-auto text-ctp-warning">{needsByHost[host]} waiting</span> : null);

  return (
    <div ref={ref} className="relative flex-shrink-0 px-2 pb-1">
      <button
        ref={buttonRef}
        type="button"
        data-testid="show-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Show ${label}`}
        onClick={() => setOpen((o) => !o)}
        className="w-full h-7 px-2 rounded-md flex items-center gap-2 text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
      >
        {machine && <StateDot state={machine.state} />}
        <span className="truncate font-medium text-ctp-text">{label}</span>
        {machine && machine.state !== 'connected' && <span className="text-ctp-overlay1">{STATE_LABEL[machine.state]}</span>}
        {hidden > 0 && (
          <span className="ml-auto text-ctp-warning">{hidden} elsewhere<span className="sr-only">, waiting on computers not shown</span></span>
        )}
        <span className={`${hidden > 0 ? '' : 'ml-auto'} text-ctp-overlay1`}>{Chevron}</span>
      </button>
      {open && (
        <div ref={menuRef} onKeyDown={onMenuKeyDown} role="menu" aria-label="Show" data-testid="show-menu-list" className="absolute left-2 right-2 top-8 z-dropdown py-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl">
          <button type="button" role="menuitemradio" aria-checked={show === 'all'} data-testid="show-all" onClick={() => pick('all')} className={itemClass}>
            <span className={show === 'all' ? 'text-ctp-text font-medium' : ''}>All computers</span>
          </button>
          <button type="button" role="menuitemradio" aria-checked={show === 'local'} data-testid="show-local" onClick={() => pick('local')} className={itemClass}>
            <StateDot state="local" />
            <span className={show === 'local' ? 'text-ctp-text font-medium' : ''}>This computer</span>
            {needsLabel(LOCAL_HOST)}
          </button>
          {sorted.map((sat) => (
            <div key={sat.id} className="flex items-center">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={sat.id === show}
                data-testid={`show-${sat.id}`}
                onClick={() => pick(sat.id)}
                className={`${itemClass} min-w-0 flex-1`}
              >
                <StateDot state={sat.state} />
                <span className={`truncate ${sat.id === show ? 'text-ctp-text font-medium' : ''}`}>{sat.alias}</span>
                <span className="text-ctp-overlay1 flex-shrink-0">{STATE_LABEL[sat.state]}</span>
                {needsLabel(sat.id)}
              </button>
              {sat.state === 'disconnected' && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`show-retry-${sat.id}`}
                  onClick={() => onRetry(sat)}
                  className="flex-shrink-0 px-3 py-1.5 text-xs text-ctp-accent hover:underline cursor-pointer"
                >
                  Reconnect
                </button>
              )}
            </div>
          ))}
          <div className="h-px my-1 bg-surface-0" />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onAnnexSettings(); }} className={itemClass}>Annex Network settings</button>
        </div>
      )}
    </div>
  );
}
