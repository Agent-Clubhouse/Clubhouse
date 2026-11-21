import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { isRemoteManagedInventoryPage, REMOTE_INVENTORY_PAGE_SIZE, REMOTE_MANAGED_INVENTORY_SOURCES, type RemoteManagedInventorySource as RemoteInventorySource } from '../../../../shared/remote-inventory-page';
import { CardNote } from './DetailsCard';
import { useSelectedInventoryPage } from './useSelectedInventoryPage';

type Result = ControllerReadResult<RemoteAgentDetails> | { status: 'loading' };
const label: Record<RemoteInventorySource, string> = { 'selected-managed-blocks': 'Configured blocks', 'selected-managed-skills': 'Configured skills', 'selected-managed-mcps': 'Configured MCPs' };
export function SelectedManagedPartsPage({ agent, details, status, freshnessKey, open, readable, onRefused }: {
  agent: Agent; details: RemoteAgentDetails | null; status: Result['status']; freshnessKey: string; open: boolean; readable: boolean;
  onRefused?(): void;
}) {
  const { eligible, query, result, page: candidate, select } = useSelectedInventoryPage({ agent, details, status, freshnessKey, open, readable, card: 'skills-mcp', onRefused });
  const page = isRemoteManagedInventoryPage(candidate) ? candidate : undefined;
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
