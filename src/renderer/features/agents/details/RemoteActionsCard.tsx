import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { REMOTE_ACTION_PAGE_SOURCE } from '../../../../shared/remote-action-page';
import { CardNote, DetailsCard } from './DetailsCard';
import { RemoteActionsEvidence } from './RemoteActionsEvidence';
import { SelectedActionsPage } from './SelectedActionsPage';
import { useSelectedInventoryPage } from './useSelectedInventoryPage';
export function RemoteActionsCard({ agent, details, status, freshnessKey, open, readable, message, onToggle, onRefused }: {
  agent: Agent; details: RemoteAgentDetails | null; status: ControllerReadResult<RemoteAgentDetails>['status'] | 'loading'; freshnessKey: string; open: boolean; readable: boolean; message: string; onToggle(): void; onRefused?(): void;
}) {
  const { eligible, contextReadable, query, key, page, result, select } = useSelectedInventoryPage({ agent, details, status, freshnessKey, open, readable, card: 'actions', onRefused });
  const observed = details?.cards.find((card) => card.id === 'actions'), c = contextReadable ? observed : undefined;
  if (observed?.state === 'not-applicable') return null;
  const actionPage = page?.source === REMOTE_ACTION_PAGE_SOURCE ? page : undefined;
  const explanation = message || (result.status === 'offline' ? 'Host offline. Reconnect to read Actions.' : result.status === 'forbidden' ? 'The host does not allow this Actions read.' : result.status === 'loading' ? 'Loading Actions from the host…' : 'Actions are unavailable in this host selection.');
  return <DetailsCard id="actions" title={c?.title ?? 'Actions'} summary={c?.summary || explanation} open={open} onToggle={onToggle}>
    {eligible && <button type="button" className="pl-[33px] py-1 text-xs" onClick={() => select(REMOTE_ACTION_PAGE_SOURCE)}>Browse recorded Actions</button>}
    {query ? <>
      {actionPage && <CardNote>This selected page was read from the host at {new Date(actionPage.observedAt).toLocaleTimeString()}.</CardNote>}
      <SelectedActionsPage selectionKey={key} offset={query.offset ?? 0} result={actionPage ? { selectionKey: key, value: actionPage } : null}
        status={result.status} agentName={agent.name} onPage={(offset, selection) => select(REMOTE_ACTION_PAGE_SOURCE, offset, selection)} />
    </> : c ? <RemoteActionsEvidence card={c} agentName={agent.name} /> : <CardNote>{explanation}</CardNote>}
    {!eligible && details?.inventoryPages !== 1 && <CardNote>This host shares the Actions summary only. Selected relationship pages need a host update.</CardNote>}
    {eligible && query && <button type="button" className="pl-[33px] py-1 text-xs" onClick={() => select(REMOTE_ACTION_PAGE_SOURCE)}>Restart Actions inventory</button>}
  </DetailsCard>;
}
