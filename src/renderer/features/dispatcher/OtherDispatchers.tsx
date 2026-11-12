import { useId } from 'react';
import type { DispatcherFederationPeer } from '../../../shared/dispatcher-federation';
import { formatAgo } from '../agents/states/format';

const PRESENCE: Record<DispatcherFederationPeer['presence'], string> = {
  online: 'Online', working: 'Working', asleep: 'Asleep', offline: 'Offline', unavailable: 'Unavailable',
};

const LINK: Record<DispatcherFederationPeer['link'], string> = {
  active: 'Link active', paused: 'Link paused', tripped: 'Link tripped', unavailable: 'Link unavailable',
};

const REASON: Record<NonNullable<DispatcherFederationPeer['reason']>, string> = {
  local_dispatcher_off: 'The Dispatcher on this machine is turned off.',
  dispatcher_off: 'The Dispatcher on that machine is turned off.',
  status_unknown: 'Dispatcher information has not arrived from that machine yet.',
  causal_depth: 'The cross-machine request depth limit was reached.',
  rate_limit: 'Too many calls reached this controller link.',
  queue_limit: 'Too many requests are waiting on this controller link.',
};

/** Read-only on every surface, including a phone. Membership owns the links. */
export function OtherDispatchers({ peers, compact = false, now = Date.now() }: {
  peers: readonly DispatcherFederationPeer[];
  compact?: boolean;
  now?: number;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="min-w-0">
      <h3 id={heading} className="text-sm font-medium text-ctp-text">Other machines</h3>
      {peers.length === 0 ? (
        <p className="mt-1 text-xs text-ctp-subtext0">No other computers in this Annex Network.</p>
      ) : (
        <ul className={`mt-2 space-y-2 ${compact ? 'text-xs' : 'text-sm'}`}>
          {peers.map((peer) => {
            const label = `${peer.name} on ${peer.machineName}`;
            const seen = peer.lastSeen ? Date.parse(peer.lastSeen) : NaN;
            const presence = peer.presence === 'offline' && Number.isFinite(seen)
              ? `Offline, last seen ${formatAgo(seen, now)}` : PRESENCE[peer.presence];
            const reason = peer.reason ? REASON[peer.reason] : null;
            return (
              <li key={peer.machineId} className="min-w-0" aria-label={`${label}: ${presence}. ${LINK[peer.link]}.`}>
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 break-words text-ctp-text">{label}</span>
                  <span className="text-ctp-subtext0">{presence}</span>
                </div>
                <p className={`mt-0.5 break-words text-xs ${peer.link === 'tripped' ? 'text-ctp-warning' : 'text-ctp-subtext0'}`}>
                  {LINK[peer.link]}{reason ? `. ${reason}` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
