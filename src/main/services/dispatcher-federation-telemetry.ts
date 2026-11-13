import { getDispatcherPresence, onDispatcherPresenceChanged } from './dispatcher-presence';
import { recordFederationLink } from '../telemetry/dispatcher-telemetry';

/** Presence already follows membership, publications and connectivity. No timer or extra I/O. */
export function watchFederationTelemetry(): () => void {
  let previous = new Map<string, string>();
  const changed = () => {
    const next = new Map(getDispatcherPresence().remotes.map((peer) => [peer.machineId, peer.link.state] as const));
    for (const [machine, state] of next) if (previous.get(machine) !== state) recordFederationLink(machine, state);
    for (const machine of previous.keys()) if (!next.has(machine)) recordFederationLink(machine, 'removed');
    previous = next;
  };
  const stop = onDispatcherPresenceChanged(changed);
  changed();
  return stop;
}
