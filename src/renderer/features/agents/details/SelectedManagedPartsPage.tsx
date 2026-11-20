import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { isRemoteInventoryPage, REMOTE_INVENTORY_PAGE_SIZE, REMOTE_MANAGED_INVENTORY_SOURCES, type RemoteInventoryQuery, type RemoteInventorySource } from '../../../../shared/remote-inventory-page';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { remoteDetailsAddress } from './remote-details-address';
import { CardNote } from './DetailsCard';

type Result = ControllerReadResult<RemoteAgentDetails> | { status: 'loading' };
const label: Record<RemoteInventorySource, string> = { 'selected-managed-blocks': 'Configured blocks', 'selected-managed-skills': 'Configured skills', 'selected-managed-mcps': 'Configured MCPs' };
export function SelectedManagedPartsPage({ agent, details, status, freshnessKey, open, readable, onRefused }: {
  agent: Agent; details: RemoteAgentDetails | null; status: Result['status']; freshnessKey: string; open: boolean; readable: boolean;
  onRefused?(): void;
}) {
  const address = remoteDetailsAddress(agent.id);
  const satellite = useAnnexClientStore((s) => s.satellites.find((h) => h.id === address?.satelliteId));
  const connected = satellite?.state === 'connected', snapshot = satellite?.snapshot;
  const transport = useRef({ connected, generation: 0 });
  if (transport.current.connected !== connected) transport.current = { connected, generation: transport.current.generation + 1 };
  const identity = `${agent.id}:${agent.projectId}:${freshnessKey}:${details?.readAt ?? ''}:${transport.current.generation}`;
  const [navigation, setNavigation] = useState<{ identity: string; query: RemoteInventoryQuery; revision: number } | null>(null);
  const selected = navigation?.identity === identity ? navigation : null, query = selected?.query;
  const key = `${identity}:${query?.source ?? ''}:${query?.offset ?? 0}:${query?.selection ?? ''}:${selected?.revision ?? 0}`;
  const [read, setRead] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const refused = useRef(onRefused); refused.current = onRefused;
  const currentCard = details?.cards.find((c) => c.id === 'skills-mcp');
  const eligible = agent.kind === 'durable' && connected && !satellite?.snapshotUnavailable && readable && status === 'ok' && !!details
    && details.agentId === address?.agentId && details.inventoryPages === 1 && !details.inventoryPageOnly && !details.helperPageOnly && !details.connectionPageOnly
    && !!currentCard && currentCard.requested !== false && currentCard.state !== 'not-applicable';
  useEffect(() => {
    if (!open || !eligible || !query || !address || !details?.inventorySources?.includes(query.source)) return;
    let active = true;
    Promise.resolve().then(() => window.clubhouse.annexClient.agentDetails(address.satelliteId, address.agentId, query)).then(
      (result) => { if (active) { setRead({ key, snapshot, result }); if (result.status === 'forbidden') refused.current?.(); } },
      // telemetry-exempt: safe display state only, never raw host/catalog errors.
      () => { if (active) setRead({ key, snapshot, result: { status: 'error' } }); },
    );
    return () => { active = false; };
  }, [open, eligible, query, key, snapshot, address?.satelliteId, address?.agentId, details?.inventorySources]);
  const result: Result = !eligible ? { status: !connected ? 'offline' : status === 'ok' ? 'unavailable' : status } as Result
    : read?.key === key && read.snapshot === snapshot ? read.result : { status: 'loading' };
  const response = result.status === 'ok' && result.value.agentId === address?.agentId && result.value.inventoryPages === 1 && result.value.inventoryPageOnly === true && isRemoteInventoryPage(result.value.inventoryPage) ? result.value.inventoryPage : undefined;
  const page = query && response?.source === query.source && response.offset === (query.offset ?? 0)
    && (response.state !== 'recorded' || !query.selection || response.selection === query.selection) ? response : undefined;
  const select = (source: RemoteInventorySource, offset = 0, selection?: string) => setNavigation({ identity, query: { card: 'skills-mcp', source, offset, ...(selection && { selection }) }, revision: (selected?.revision ?? 0) + 1 });
  if (!eligible && !query) return details?.inventoryPages !== 1 ? <CardNote>Selected configured-part pages are not shared by this host. Existing summaries may be incomplete.</CardNote> : null;
  return <section aria-label="Selected configured parts">
    {eligible && <div className="flex flex-wrap gap-3 pl-[33px] pr-3.5 py-1 text-xs">{REMOTE_MANAGED_INVENTORY_SOURCES.filter((source) => details?.inventorySources?.includes(source)).map((source) => <button type="button" key={source} onClick={() => select(source)}>{label[source]}</button>)}</div>}
    {query && (page ? page.state === 'recorded' ? <>
      <CardNote>{label[page.source]}: {page.total === 0 ? 'No configured parts in this selected list.' : `${page.offset + 1}–${page.offset + page.rows.length} of ${page.total} selected configured parts.`}</CardNote>
      <ul className="pl-[33px] pr-3.5 text-xs" aria-label="Configured managed parts">{page.rows.map((part) => <li key={part.key} className="py-1">{part.state === 'missing' ? 'Selected part is missing or no longer matches this kind.' : <>{part.name} · {part.builtin ? 'Built-in' : 'Custom'} · revision {part.revision}</>}</li>)}</ul>
      {page.notes.map((note, index) => <CardNote key={index}>{note}</CardNote>)}
      <div className="flex gap-3 pl-[33px] text-xs"><button type="button" disabled={!page.offset} onClick={() => select(page.source)}>First part page</button><button type="button" disabled={!page.offset} onClick={() => select(page.source, page.offset - REMOTE_INVENTORY_PAGE_SIZE, page.selection)}>Previous parts</button><button type="button" disabled={page.next === null} onClick={() => page.next !== null && select(page.source, page.next, page.selection)}>Next parts</button></div>
    </> : <CardNote>{page.reason === 'changed' ? 'This selected inventory changed. Restart from its first page.' : page.reason === 'limit' ? 'The selected inventory exceeds the host metadata limit.' : page.reason === 'unsupported' ? 'This selected inventory is not supported for this agent.' : 'The selected committed library metadata is unavailable.'} No empty list is inferred.</CardNote>
      : <CardNote>{result.status === 'forbidden' ? 'The host does not allow this inventory read.' : result.status === 'offline' ? 'Host offline. Reconnect to read configured parts.' : result.status === 'unavailable' ? 'Selected configured-part pages are unavailable.' : result.status === 'loading' ? 'Loading selected configured parts…' : 'Couldn’t read this selected part page. Refresh to try again.'}</CardNote>)}
    {eligible && query && <button type="button" className="pl-[33px] py-1 text-xs" onClick={() => select(query.source)}>Restart part inventory</button>}
  </section>;
}
