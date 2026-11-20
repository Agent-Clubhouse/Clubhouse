import { useRef } from 'react';
import type { SatelliteSnapshot } from '../../../shared/types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { CardNote, CardRow, DetailsCard } from '../agents/details/DetailsCard';
import { OtherMachinesList, otherMachinesSummary, presenceLinkText } from './OtherMachinesList';
import { CONTROLLER_LINK_STATE_LABELS, REMOTE_DISPATCHER_STATE_LABELS, type RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
import { useDispatcherPresence } from './useDispatcherPresence';

/** Why there is no chat to show for it on this computer, in words. */
function explain(remote: RemoteDispatcherPresence, connected: boolean): string {
  switch (remote.state) {
    case 'offline': return `${remote.machineName} is offline. Its Dispatcher’s chat shows here when it’s connected.`;
    case 'off': return `${remote.machineName}’s Dispatcher is turned off. Its chat shows here when it’s on.`;
    case 'unknown': return `${remote.machineName} hasn’t shared its Dispatcher yet.`;
    default: return connected
      ? `${remote.machineName} hasn’t shared a Dispatcher chat identity. Available host snapshot observations are shown alongside.`
      : `This computer isn’t connected to ${remote.machineName} yet. Its Dispatcher’s chat shows here once it is.`;
  }
}

/**
 * What the Dispatcher pane shows for another computer's Dispatcher while this
 * computer has no chat from it (it isn't connected from this side, or the
 * Dispatcher is off). Picking it never does nothing, and the chat takes this
 * place as soon as it arrives.
 */
export function RemoteDispatcherDetails({ machineId }: { machineId: string }) {
  const presence = useDispatcherPresence();
  const machine = machineId.toLowerCase();
  const remote = presence?.remotes.find((r) => r.machineId.toLowerCase() === machine);
  const satellite = useAnnexClientStore((s) => s.satellites.find((sat) => sat.fingerprint.toLowerCase() === machine));
  const connected = satellite?.state === 'connected';
  const invalidated = useRef(new WeakSet<SatelliteSnapshot>());
  const admitted = useRef<{ machine: string; snapshot: SatelliteSnapshot } | null>(null);
  let limitation = satellite?.needsPairing ? 'Pairing with this host is unavailable. Access must be renewed before reading host details.'
    : !connected ? 'This computer has no connected read from the selected host.'
      : satellite.snapshotUnavailable || !satellite.snapshot ? 'The host snapshot is unavailable. Earlier private fields are withheld.'
        : satellite.snapshot.sessionPaused ? 'Host sharing is paused. Earlier private fields are withheld.' : null;
  // A reconnect or renewed pairing cannot make an earlier private snapshot fresh.
  if (limitation) {
    if (satellite?.snapshot) invalidated.current.add(satellite.snapshot);
    if (admitted.current?.machine === machine) invalidated.current.add(admitted.current.snapshot);
  } else if (satellite?.snapshot && invalidated.current.has(satellite.snapshot)) {
    limitation = 'Waiting for a new host snapshot after connection or access changed. Earlier private fields are withheld.';
  }
  const snapshot = limitation ? null : satellite?.snapshot;
  if (snapshot) admitted.current = { machine, snapshot };
  const omitted = (field: string) => !!snapshot?.snapshotTruncated && (!snapshot.snapshotTruncated.omitted || snapshot.snapshotTruncated.omitted.includes(field));
  const enabled = !omitted('dispatcher') ? snapshot?.dispatcher?.enabled : undefined;
  const peers = !omitted('dispatcherPresence') ? snapshot?.dispatcherPresence?.remotes : undefined;
  const identityLimit = 'The host has not shared an existing Dispatcher chat identity. Detailed settings, Connections and Actions are unavailable without that identity.';
  const settingsLimit = limitation ?? (omitted('dispatcher') ? 'Dispatcher settings were omitted from this host snapshot.' : enabled === undefined ? 'This host snapshot does not report Dispatcher settings. Its version or role state may not support them.' : identityLimit);
  const unavailable = limitation ?? identityLimit;
  return (
    <div className="h-full min-h-0 flex bg-ctp-base" data-testid="remote-dispatcher-details">
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-2 px-7 text-center" role="status">
        {remote ? (
          <>
            <p className="text-sm font-medium text-ctp-text">{remote.label}</p>
            <p className="max-w-md text-sm text-ctp-subtext0">{explain(remote, connected)}</p>
            <p className="text-xs text-ctp-overlay1">
              {REMOTE_DISPATCHER_STATE_LABELS[remote.state]}. {CONTROLLER_LINK_STATE_LABELS[remote.link.state]}{remote.link.reason ? `: ${remote.link.reason}` : ''}
            </p>
          </>
        ) : (
          <p className="max-w-md text-sm text-ctp-subtext0">This computer’s list of Dispatchers on other computers doesn’t have that one.</p>
        )}
        <p className="text-xs text-ctp-overlay1">Published presence and link observed by this computer.</p>
      </div>
      <aside className="w-[340px] flex-shrink-0 min-h-0 overflow-y-auto flex flex-col gap-2 py-3 pr-3.5" aria-label="Dispatcher snapshot details" data-testid="remote-dispatcher-snapshot-cards">
        <p className="px-3 text-xs text-ctp-overlay1">Read-only observations. {snapshot ? 'From the selected host’s shared snapshot.' : 'Current host details are unavailable.'}</p>
        <DetailsCard embedded id="settings" title="Settings" summary={enabled === undefined ? 'unavailable' : enabled ? 'On · host snapshot' : 'Turned off · host snapshot'} open onToggle={() => {}}>
          {enabled !== undefined && <CardRow label="Dispatcher">{enabled ? 'On' : 'Turned off'}</CardRow>}
          <CardNote>{settingsLimit}</CardNote>
          {enabled === false && <CardNote>The snapshot does not say whether a Dispatcher was previously created.</CardNote>}
        </DetailsCard>
        <DetailsCard embedded id="connections" title="Connections" summary={remote ? 'published link only' : 'unavailable'} open onToggle={() => {}}>
          {remote && <><CardRow label="Link from here" labelWidth="wide">{presenceLinkText(remote)}</CardRow><CardNote>This computer’s published controller-link observation. It is not the selected host’s connection inventory.</CardNote></>}
          <CardNote>{unavailable}</CardNote>
        </DetailsCard>
        <DetailsCard embedded id="other-machines" title="Other machines" summary={peers ? otherMachinesSummary(peers) : 'unavailable'} open onToggle={() => {}}>
          {peers ? <OtherMachinesList compact remotes={peers} /> : <CardNote>{limitation ?? (omitted('dispatcherPresence') ? 'Other machines were omitted from this host snapshot.' : 'The selected host has not shared its Other machines list. An absent list is not an empty network.')}</CardNote>}
        </DetailsCard>
        <DetailsCard embedded id="actions" title="Actions" summary="unavailable" open onToggle={() => {}}>
          <CardNote>{unavailable}</CardNote><CardNote>No host Action inventory has been read for this selection.</CardNote>
        </DetailsCard>
      </aside>
    </div>
  );
}
