/**
 * The Dispatchers on this person's other computers (#3349): each one's name on
 * its machine, whether it is there and busy, and the state of the controller
 * link to it. Read-only. Settings › Dispatcher shows the full list; the
 * Dispatcher's Details shows the compact one.
 */
import {
  CONTROLLER_LINK_STATE_LABELS,
  REMOTE_DISPATCHER_STATE_LABELS,
  type RemoteDispatcherPresence,
} from '../../../shared/dispatcher-presence';
import { formatAgo } from '../agents/states/format';

/** "Offline, last seen 2h ago", or the state's words. */
export function presenceStateText(remote: RemoteDispatcherPresence, now: number = Date.now()): string {
  const words = REMOTE_DISPATCHER_STATE_LABELS[remote.state];
  if (remote.state !== 'offline' || !remote.lastSeen) return words;
  const at = Date.parse(remote.lastSeen);
  return Number.isFinite(at) ? `${words}, last seen ${formatAgo(at, now)}` : words;
}

/** "Link active", or "Link paused: <reason>". */
export function presenceLinkText(remote: RemoteDispatcherPresence): string {
  const words = CONTROLLER_LINK_STATE_LABELS[remote.link.state];
  return remote.link.state !== 'active' && remote.link.reason ? `${words}: ${remote.link.reason}` : words;
}

/** "2 of 3 online": the ones that are there now, of all. */
export function otherMachinesSummary(remotes: RemoteDispatcherPresence[]): string {
  const there = remotes.filter((r) => r.state === 'online' || r.state === 'working' || r.state === 'asleep').length;
  return `${there} of ${remotes.length} online`;
}

export function OtherMachinesList({ remotes, compact = false, now }: {
  remotes: RemoteDispatcherPresence[];
  compact?: boolean;
  now?: number;
}) {
  if (remotes.length === 0) {
    return (
      <p className="text-xs text-ctp-overlay1" data-testid="other-machines-empty">
        No other computers in your Annex Network.
      </p>
    );
  }
  return (
    <ul aria-label="Dispatchers on other machines" data-testid="other-machines">
      {remotes.map((remote) => {
        const state = presenceStateText(remote, now);
        const link = presenceLinkText(remote);
        return (
          <li
            key={remote.machineId}
            className={`flex flex-col min-w-0 border-t border-surface-0 first:border-t-0 ${compact ? 'py-1' : 'py-2'}`}
            data-testid={`other-machine-${remote.machineId}`}
            aria-label={[remote.label, state, link].map((part) => part.replace(/\.$/, '')).join('. ') + '.'}
          >
            <span className="text-[13px] text-ctp-text break-words">
              {remote.dispatcherName ?? 'Dispatcher'}
              <span className="text-ctp-overlay1"> on {remote.machineName}</span>
            </span>
            <span className="text-xs text-ctp-subtext0 break-words" data-testid={`other-machine-${remote.machineId}-state`}>
              {state}
              {!compact && <span className="text-ctp-overlay1">. {link}</span>}
              {compact && remote.link.state !== 'active' && <span className="text-ctp-overlay1">. {CONTROLLER_LINK_STATE_LABELS[remote.link.state]}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
