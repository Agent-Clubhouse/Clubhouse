import { useEffect, useRef, useState } from 'react';
import type { ControllerReadResult } from '../../../shared/controller-chat';
import { isSelectedDispatcherDetails, type SelectedDispatcherDetails } from '../../../shared/selected-dispatcher-details';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { Button } from '../../components/Button';
import { CardNote, CardRow, DetailsCard } from '../agents/details/DetailsCard';
import { Evidence } from '../agents/details/RemoteDetailsEvidence';
import { RemoteActionsEvidence } from '../agents/details/RemoteActionsEvidence';
import { OtherMachinesList, otherMachinesSummary } from './OtherMachinesList';
import { RemoteDispatcherConnectionPages } from './RemoteDispatcherConnectionPages';
import { RemoteDispatcherActionsPages } from './RemoteDispatcherActionsPages';
import { REMOTE_ACTION_PAGE_SOURCE } from '../../../shared/remote-action-page';

type Result = ControllerReadResult<SelectedDispatcherDetails> | { status: 'loading' };
const message = (status: Result['status']) => status === 'loading' ? 'Reading Dispatcher details from the selected host…'
  : status === 'forbidden' ? 'This host does not allow this desktop to read Dispatcher details.'
    : status === 'offline' ? 'The selected host is not connected. Current Dispatcher details are withheld.'
      : status === 'unavailable' ? 'This host does not share this Dispatcher role read, or an existing role is unavailable.'
        : status === 'rate_limited' ? 'The host is busy. Try reading Dispatcher details again shortly.'
          : 'Couldn’t read current Dispatcher details from the host.';

/** Explicit role read only. No Agent/chat identity, local card hooks, paging by raw id, or shared Details cache. */
export function RemoteDispatcherRoleDetails({ machineId, dispatcherName, publishedLink }: { machineId: string; dispatcherName: string; publishedLink?: string }) {
  const machine = machineId.toLowerCase();
  const sat = useAnnexClientStore((s) => s.satellites.find((host) => host.fingerprint.toLowerCase() === machine));
  const paused = useAnnexClientStore((s) => !!(sat && s.satellitePaused[sat.id]));
  const [retry, setRetry] = useState(0), [roleRevision, setRoleRevision] = useState(0);
  const eligible = sat?.state === 'connected' && !sat.needsPairing && !sat.snapshotUnavailable && !sat.snapshot?.sessionPaused && !paused
    && Number.isSafeInteger(sat.connectionGeneration) && sat.connectionGeneration >= 0;
  const context = JSON.stringify([machine, sat?.id, sat?.state, sat?.connectionGeneration, sat?.snapshotReceipt, sat?.needsPairing, sat?.snapshotUnavailable, sat?.snapshot?.sessionPaused, paused]);
  const generation = useRef({ context, value: 0 });
  if (generation.current.context !== context) generation.current = { context, value: generation.current.value + 1 };
  const key = `${machine}:${generation.current.value}:${retry}:${roleRevision}`;
  const [read, setRead] = useState<{ key: string; result: Result } | null>(null);
  useEffect(() => window.clubhouse.annexClient.onSatelliteEvent((event) => {
    if (event.satelliteId === sat?.id && event.type === 'dispatcher:changed') setRoleRevision((n) => n + 1);
  }), [sat?.id]);
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await window.clubhouse.annexClient.dispatcherDetails(machine);
          if (active) setRead({ key, result: result.status === 'ok' && !isSelectedDispatcherDetails(result.value) ? { status: 'error' } : result });
        } catch {
          // telemetry-exempt: retryable bounded read status; no raw host errors or fallback.
          if (active) setRead({ key, result: { status: 'error' } });
        }
      })();
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [eligible, machine, key]);
  const result: Result = !eligible ? { status: sat?.needsPairing ? 'forbidden' : sat?.state !== 'connected' ? 'offline' : 'unavailable' }
    : read?.key === key ? read.result : { status: 'loading' };
  const value = result.status === 'ok' ? result.value : undefined;
  const details = value?.details, settings = details?.settings;
  // A host without the role read (404/405/409) still shares its snapshot. Under the same positive receipt, show only those snapshot fields; denials stay withheld.
  const snapshotOnly = eligible && result.status === 'unavailable';
  const snapshot = (value || snapshotOnly) && sat?.snapshotReceipt ? sat.snapshot : undefined;
  const omitted = (field: string) => !!snapshot?.snapshotTruncated && (!snapshot.snapshotTruncated.omitted || snapshot.snapshotTruncated.omitted.includes(field));
  const peers = !omitted('dispatcherPresence') ? snapshot?.dispatcherPresence?.remotes : undefined;
  const enabled = !omitted('dispatcher') ? snapshot?.dispatcher?.enabled : undefined;
  const card = (id: 'settings' | 'connections' | 'actions') => details?.cards.find((c) => c.id === id);
  const blocked = sat?.needsPairing ? 'Pairing with this host is unavailable. Access must be renewed before reading host details.'
    : sat?.state !== 'connected' ? 'This computer has no connected read from the selected host.'
      : sat.snapshotUnavailable ? 'The host snapshot is unavailable. Earlier private fields are withheld.'
        : paused || sat.snapshot?.sessionPaused ? 'Host sharing is paused. Earlier private fields are withheld.'
          : !Number.isSafeInteger(sat.connectionGeneration) ? 'This local connection cannot attest its current generation. Dispatcher details are unavailable.' : null;
  const note = blocked ?? message(result.status);
  const names = (items: string[] | null) => items === null ? 'Not shared by host' : items.join(', ') || 'None';
  return <aside className="w-[340px] flex-shrink-0 min-h-0 overflow-y-auto flex flex-col gap-2 py-3 pr-3.5" aria-label="Dispatcher host details" data-testid="remote-dispatcher-snapshot-cards">
    <p className="px-3 text-xs text-ctp-overlay1" role="status" data-testid="remote-dispatcher-role-status">{value ? `Read-only Dispatcher metadata read from ${sat?.alias || 'the selected host'} at ${new Date(details!.readAt).toLocaleTimeString()}.` : note}</p>
    <Button kind="ghost" disabled={!eligible || result.status === 'loading'} onClick={() => setRetry((n) => n + 1)}>Refresh Dispatcher details</Button>
    <DetailsCard embedded id="settings" title="Settings" summary={settings ? `${settings.provider} · ${settings.model}` : enabled === undefined ? 'unavailable' : enabled ? 'On · host snapshot' : 'Turned off · host snapshot'} open onToggle={() => {}}>
      {enabled !== undefined && <CardRow label="Dispatcher">{enabled ? 'On' : 'Turned off'} · host snapshot</CardRow>}
      {snapshotOnly && enabled === false && <CardNote>The snapshot does not say whether a Dispatcher was previously created.</CardNote>}
      {(value || snapshotOnly) && enabled === undefined && <CardNote>{omitted('dispatcher') ? 'Dispatcher settings were omitted from this host snapshot.' : 'Dispatcher on/off state is not included in the host snapshot.'}</CardNote>}
      {settings && <>
        <CardRow label="CLI">{settings.provider}</CardRow><CardRow label="Model">{settings.model}</CardRow>
        <CardRow label="Next start">{settings.runtime === 'chat' ? 'Chat' : 'CLI'}</CardRow><CardRow label="Access">{settings.access}</CardRow>
        <CardRow label="Sandbox and approvals" labelWidth="wide">{settings.executionPolicy}</CardRow>
        {settings.autoSleep !== null && <CardRow label="Auto-sleep">{settings.autoSleep}</CardRow>}
        {settings.context !== null && <CardRow label="Context">{settings.context}</CardRow>}
        {settings.setup.state === 'ok' ? <>
          {settings.setup.managed && <CardRow label="Managed">By Clubhouse{settings.setup.template ? ` · ${settings.setup.template}` : ''}</CardRow>}
          <CardRow label="Instructions">{settings.setup.instructions}</CardRow><CardRow label="Skills">{names(settings.setup.skills)}</CardRow><CardRow label="MCP servers">{names(settings.setup.mcps)}</CardRow>
          {settings.setup.waiting && <CardNote>Setup changed. Applies when it restarts or next wakes.</CardNote>}
        </> : <CardNote>The host’s configured setup summary is unavailable.</CardNote>}
        <CardNote>Configured on the host for its next start. Provider loading and runtime use are not confirmed here.</CardNote>
      </>}
      {card('settings') ? <Evidence card={card('settings')!} /> : <CardNote>{note}</CardNote>}
    </DetailsCard>
    <DetailsCard embedded id="connections" title="Connections" summary={card('connections')?.summary || 'unavailable'} open onToggle={() => {}}>
      {publishedLink && <><CardRow label="Link from here" labelWidth="wide">{publishedLink}</CardRow><CardNote>This computer’s published controller-link observation. It is not the selected host’s connection inventory.</CardNote></>}
      {value && eligible && value.details.connectionPages === 1
        ? <RemoteDispatcherConnectionPages machine={machine} roleAgentId={value.agentId} sources={value.details.connectionPageSources} contextKey={key}>
          {card('connections') ? <Evidence card={card('connections')!} /> : <CardNote>{note}</CardNote>}
        </RemoteDispatcherConnectionPages>
        : card('connections') ? <Evidence card={card('connections')!} /> : <CardNote>{note}</CardNote>}
      {value && eligible && value.details.connectionPages !== 1 && <CardNote>This host shares the Dispatcher Connections summary only. Source pages need a host update.</CardNote>}
    </DetailsCard>
    <DetailsCard embedded id="other-machines" title="Other machines" summary={peers ? otherMachinesSummary(peers) : 'unavailable'} open onToggle={() => {}}>
      {peers ? <><OtherMachinesList compact remotes={peers} /><CardNote>From the selected host’s confirmed shared snapshot; role metadata is read separately.</CardNote></>
        : <CardNote>{!value && !snapshotOnly ? note : !sat?.snapshotReceipt ? 'Waiting for a confirmed host snapshot. Earlier private fields are withheld.' : omitted('dispatcherPresence') ? 'Other machines were omitted from this host snapshot.' : 'The selected host has not shared its Other machines list. An absent list is not an empty network.'}</CardNote>}
    </DetailsCard>
    <DetailsCard embedded id="actions" title="Actions" summary={card('actions')?.summary || 'unavailable'} open onToggle={() => {}}>
      {value && eligible && value.details.inventoryPages === 1 && value.details.inventorySources?.includes(REMOTE_ACTION_PAGE_SOURCE)
        ? <RemoteDispatcherActionsPages machine={machine} roleAgentId={value.agentId} dispatcherName={dispatcherName} contextKey={key}>
          {card('actions') ? <RemoteActionsEvidence card={card('actions')!} agentName={dispatcherName} /> : <CardNote>{note}</CardNote>}
        </RemoteDispatcherActionsPages>
        : card('actions') ? <RemoteActionsEvidence card={card('actions')!} agentName={dispatcherName} /> : <CardNote>{note}</CardNote>}
      {value && eligible && !(value.details.inventoryPages === 1 && value.details.inventorySources?.includes(REMOTE_ACTION_PAGE_SOURCE)) && <CardNote>This host shares the Dispatcher Actions summary only. Relationship pages need a host update.</CardNote>}
    </DetailsCard>
  </aside>;
}
