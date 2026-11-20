import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import type { RemoteDetailsQuery, RemoteConnectionPageSource } from '../../../../shared/remote-details-query';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { remoteDetailsAddress } from './remote-details-address';
import { DetailsCard, CardNote } from './DetailsCard';
import { Evidence } from './RemoteDetailsEvidence';

type Result = ControllerReadResult<RemoteAgentDetails> | { status: 'loading' };
const label: Record<RemoteConnectionPageSource, string> = { outgoing: 'Outgoing bindings', incoming: 'Incoming bindings', directions: 'Saved switches', sources: 'Retained sources', 'manual-dispatcher': 'Saved Dispatcher links', helpers: 'Helper relationships', 'dispatcher-auto': 'Automatic agent links', 'tool-records': 'Saved tool links', 'canvas-records': 'Saved Canvas wires', 'zone-records': 'Saved zone wires', 'helper-parent': 'Saved parent link', 'group-records': 'Saved group membership' };
const message = (status: Result['status']) => status === 'offline' ? 'Host offline. Reconnect to read connection pages.'
  : status === 'forbidden' ? 'The host does not allow this Details read.' : status === 'unavailable' ? 'This host does not share this connection page. It may need an update.'
    : status === 'error' ? 'Couldn’t read this connection page from the host. Refresh to try again.' : status === 'rate_limited' ? 'The host is busy. Try again shortly.' : 'Loading connections from the host…';

export function RemoteConnectionsCard({ agent, details, status, freshnessKey, dispatcher, open, onToggle }: {
  agent: Agent; details: RemoteAgentDetails | null; status: Result['status']; freshnessKey: string; dispatcher: boolean; open: boolean; onToggle(): void;
}) {
  const address = remoteDetailsAddress(agent.id), satelliteId = address?.satelliteId, agentId = address?.agentId;
  const satellite = useAnnexClientStore((s) => s.satellites.find((h) => h.id === satelliteId));
  const connected = satellite?.state === 'connected', snapshot = satellite?.snapshot;
  const transport = useRef({ connected, generation: 0 });
  if (transport.current.connected !== connected) transport.current = { connected, generation: transport.current.generation + 1 };
  const identity = `${agent.id}:${freshnessKey}:${details?.readAt ?? ''}:${transport.current.generation}`;
  const [navigation, setNavigation] = useState<{ identity: string; query: RemoteDetailsQuery; previous: RemoteDetailsQuery[] } | null>(null);
  const selected = navigation?.identity === identity ? navigation : null, query = selected?.query;
  const [retry, setRetry] = useState(0);
  const key = `${identity}:${query?.source ?? ''}:${query?.projectOffset ?? 0}:${query?.offset ?? 0}:${retry}`;
  const [read, setRead] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const eligible = connected && status === 'ok' && !!details && details.agentId === agentId;
  useEffect(() => {
    if (!open || !eligible || !query || !satelliteId || !agentId || details?.connectionPages !== 1) return;
    let active = true;
    Promise.resolve().then(() => window.clubhouse.annexClient.agentDetails(satelliteId, agentId, query)).then(
      (result) => { if (active) setRead({ key, snapshot, result }); },
      // telemetry-exempt: display status only; no raw host errors/local fallback.
      () => { if (active) setRead({ key, snapshot, result: { status: 'error' } }); },
    );
    return () => { active = false; };
  }, [open, eligible, query, satelliteId, agentId, details?.connectionPages, key, snapshot]);
  const result: Result = !address ? { status: 'unavailable' } : !connected ? { status: 'offline' } : !eligible ? { status: status === 'ok' ? 'loading' : status } as Result
    : read?.key === key && read.snapshot === snapshot ? read.result : { status: 'loading' };
  const candidate = result.status === 'ok' && result.value.agentId === agentId ? result.value.cards.find((c) => c.id === 'connections') : undefined;
  const page = candidate?.connectionPage;
  const current = query && page?.source === query.source && page.offset === (query.offset ?? 0) && page.projectOffset === (query.projectOffset ?? 0) ? candidate : undefined;
  const overview = eligible ? details?.cards.find((c) => c.id === 'connections') : undefined;
  const card = query ? current : overview;
  const candidates: RemoteConnectionPageSource[] = ['outgoing', 'incoming', 'directions', 'sources', ...(dispatcher ? ['dispatcher-auto' as const] : agent.kind === 'durable' ? [...(!agent.parentAgentId ? ['manual-dispatcher' as const] : []), 'helpers' as const] : [])];
  const sources = details?.connectionPageSources ?? candidates;
  const select = (source: RemoteConnectionPageSource) => setNavigation({ identity, query: { card: 'connections', source, offset: 0, projectOffset: 0 }, previous: [] });
  const overviewStatus = !address ? 'unavailable' : !connected ? 'offline' : status;
  const overviewMessage = overviewStatus === 'unavailable' ? 'This host does not share these details, or this agent is no longer available. The host may need an update.' : message(overviewStatus);
  return <DetailsCard id="connections" title="Connections" summary={card?.summary || (query ? message(result.status) : overviewMessage)} open={open} onToggle={onToggle}>
    {eligible && details?.connectionPages === 1 && <div className="flex flex-wrap gap-3 pl-[33px] pr-3.5 pb-2 text-xs" aria-label="Connection inventories">
      <button type="button" aria-pressed={!query} onClick={() => setNavigation(null)}>Overview</button>
      {sources.map((source) => <button type="button" key={source} aria-pressed={query?.source === source} onClick={() => select(source)}>{label[source]}</button>)}
    </div>}
    {card ? <Evidence card={card} /> : <CardNote>{query && result.status === 'ok' ? 'The host did not return the selected source page.' : query ? message(result.status) : overviewMessage}</CardNote>}
    {eligible && details?.connectionPages !== 1 && <CardNote>This host shares the summary only. Selected source continuation needs a host update.</CardNote>}
    {query && current && page && <>
      <CardNote>{page.known} known records in this inventory page{page.complete ? '' : ' · additional records may be unavailable'}. Pages are separate host observations.</CardNote>
      <div className="flex gap-3 pl-[33px] text-xs">
        <button type="button" onClick={() => select(query.source)}>First page</button>
        <button type="button" disabled={!selected?.previous.length} onClick={() => selected && setNavigation({ identity, query: selected.previous[selected.previous.length - 1], previous: selected.previous.slice(0, -1) })}>Previous</button>
        <button type="button" disabled={!page.next} onClick={() => selected && page.next && setNavigation({ identity, query: { ...selected.query, ...page.next }, previous: [...selected.previous.slice(-31), selected.query] })}>Next</button>
      </div>
    </>}
    {query && <button type="button" className="pl-[33px] text-xs" onClick={() => setRetry((n) => n + 1)}>Refresh connection page</button>}
  </DetailsCard>;
}
