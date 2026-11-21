import { useEffect, useState } from 'react';
import type { ControllerReadResult } from '../../../shared/controller-chat';
import type { RemoteConnectionPageSource } from '../../../shared/remote-details-query';
import type { SelectedDispatcherConnectionsQuery, SelectedDispatcherDetails } from '../../../shared/selected-dispatcher-details';
import { CardNote } from '../agents/details/DetailsCard';
import { Evidence } from '../agents/details/RemoteDetailsEvidence';
import { connectionPageMessage, connectionSourceLabel } from '../agents/details/RemoteConnectionsCard';

type Result = ControllerReadResult<SelectedDispatcherDetails> | { status: 'loading' };
const DISPATCHER_SOURCES: RemoteConnectionPageSource[] = ['outgoing', 'incoming', 'directions', 'sources', 'dispatcher-auto'];

/** Connections source pages of the role the overview read returned. Every page names that role agent; any
 * role-context change (generation, receipt, pause, role event or refresh) starts over at the overview. */
export function RemoteDispatcherConnectionPages({ machine, roleAgentId, sources, contextKey, children }: {
  machine: string; roleAgentId: string; sources?: RemoteConnectionPageSource[]; contextKey: string; children: React.ReactNode;
}) {
  const identity = `${contextKey}:${roleAgentId}`;
  const [navigation, setNavigation] = useState<{ identity: string; query: SelectedDispatcherConnectionsQuery; previous: SelectedDispatcherConnectionsQuery[] } | null>(null);
  const selected = navigation?.identity === identity ? navigation : null, query = selected?.query;
  const key = `${identity}:${query?.source ?? ''}:${query?.projectOffset ?? 0}:${query?.offset ?? 0}`;
  const [read, setRead] = useState<{ key: string; result: Result } | null>(null);
  useEffect(() => {
    if (!query) return;
    let active = true;
    Promise.resolve().then(() => window.clubhouse.annexClient.dispatcherDetails(machine, query, roleAgentId)).then(
      (result) => { if (active) setRead({ key, result }); },
      // telemetry-exempt: display status only; no raw host errors or fallback read.
      () => { if (active) setRead({ key, result: { status: 'error' } }); },
    );
    return () => { active = false; };
  }, [machine, roleAgentId, query, key]);
  const result: Result = read?.key === key ? read.result : { status: 'loading' };
  const value = result.status === 'ok' && result.value.agentId === roleAgentId ? result.value : undefined;
  const card = value?.details.cards.find((c) => c.id === 'connections');
  const page = card?.connectionPage;
  const current = query && page?.source === query.source && page.offset === (query.offset ?? 0) && page.projectOffset === (query.projectOffset ?? 0) ? card : undefined;
  const select = (source: RemoteConnectionPageSource) => setNavigation({ identity, query: { card: 'connections', source, offset: 0, projectOffset: 0 }, previous: [] });
  return <>
    <div className="flex flex-wrap gap-3 pl-[33px] pr-3.5 pb-2 text-xs" aria-label="Dispatcher connection inventories">
      <button type="button" aria-pressed={!query} onClick={() => setNavigation(null)}>Overview</button>
      {(sources ?? DISPATCHER_SOURCES).map((source) => <button type="button" key={source} aria-pressed={query?.source === source} onClick={() => select(source)}>{connectionSourceLabel[source]}</button>)}
    </div>
    {!query ? children : current ? <Evidence card={current} /> : <CardNote>{result.status === 'ok' ? 'The host did not return the selected source page for this Dispatcher.' : connectionPageMessage(result.status)}</CardNote>}
    {query && current && page && <>
      <CardNote>{page.known} known {page.source === 'sources' ? 'retained source keys' : 'records'} in this inventory page{page.complete ? '' : ' · additional records may be unavailable'}. Pages are separate host observations of the same Dispatcher.</CardNote>
      <div className="flex gap-3 pl-[33px] text-xs">
        <button type="button" onClick={() => select(query.source)}>First page</button>
        <button type="button" disabled={!selected?.previous.length} onClick={() => selected && setNavigation({ identity, query: selected.previous[selected.previous.length - 1], previous: selected.previous.slice(0, -1) })}>Previous</button>
        <button type="button" disabled={!page.next} onClick={() => selected && page.next && setNavigation({ identity, query: { ...selected.query, ...page.next }, previous: [...selected.previous.slice(-31), selected.query] })}>Next</button>
      </div>
    </>}
  </>;
}
