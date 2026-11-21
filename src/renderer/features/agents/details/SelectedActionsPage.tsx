/** Pure selected-page presentation. The common inventory container owns transport and epochs. */
import { isRemoteActionRelationshipPage, type RemoteActionRelationshipPage } from '../../../../shared/remote-action-page';
import { ActionGroupFrame, ActionLineContent } from '../../actions/ActionListPresentation';
import { CardNote } from './DetailsCard';
export type SelectedActionPageStatus = 'ok' | 'loading' | 'offline' | 'forbidden' | 'unavailable' | 'error' | 'rate_limited';
export interface SelectedActionsPageProps {
  selectionKey: string;
  offset: number;
  result: { selectionKey: string; value: RemoteActionRelationshipPage } | null;
  status: SelectedActionPageStatus;
  agentName: string;
  /** Common container must keep the page's ordered relationship selection token. */
  onPage(offset: number, selection?: string): void;
}
const message = (status: SelectedActionPageStatus) => status === 'offline' ? 'Host offline. Reconnect to read Actions.' : status === 'forbidden' ? 'The host does not allow this Actions read.' : status === 'unavailable' ? 'This host does not share selected Actions pages.' : status === 'rate_limited' ? 'The host is busy. Try again shortly.' : status === 'error' ? 'Couldn’t read this Actions page. Refresh to try again.' : 'Loading selected Actions…';
export function SelectedActionsPage({ selectionKey, offset, result, status, agentName, onPage }: SelectedActionsPageProps) {
  const page = status === 'ok' && result?.selectionKey === selectionKey && result.value.offset === offset && isRemoteActionRelationshipPage(result.value) ? result.value : null;
  if (!page) return <CardNote>{message(status === 'ok' ? 'loading' : status)}</CardNote>;
  if (page.state === 'unavailable') return <><CardNote>{page.reason === 'changed' ? 'The selected Actions changed. Return to the first page to refresh the relationships.' : 'Selected Actions are unavailable; an empty list is not inferred.'}</CardNote>{page.reason === 'changed' && <button type="button" className="pl-[33px] text-xs" onClick={() => onPage(0)}>First Actions page</button>}</>;
  const groups = [{ id: 'owned', title: `Owned by ${agentName}`, note: `Their usage counts toward ${agentName}.` }, { id: 'targeting', title: `Targets ${agentName}` }, { id: 'triggered-by', title: `Set off by ${agentName}` }, { id: 'dispatcher', title: 'Made by the Dispatcher' }] as const;
  return <>
    <CardNote>{page.uniqueActions} related Actions · {page.totalRelationships} relationship rows. The same Action can appear in more than one group.</CardNote>
    <div className="px-3 pb-1">{groups.map((group) => {
      const rows = page.rows.filter((row) => row.group === group.id);
      if (!rows.length) return null;
      return <ActionGroupFrame key={group.id} title={group.title} empty="" hasItems note={'note' in group ? group.note : undefined}>
        {rows.map((row) => <li key={row.key} className="py-2 border-t border-surface-0" data-testid="selected-action-row"><ActionLineContent name={row.name} enabled={row.enabled} description={row.description} lastRun={row.lastRun} /></li>)}
      </ActionGroupFrame>;
    })}</div>
    {!page.totalRelationships && <CardNote>No Actions relate to this selected agent in the recorded inventory.</CardNote>}
    {page.notes.map((note, index) => <CardNote key={index}>{note}</CardNote>)}
    <div className="flex gap-3 pl-[33px] text-xs" aria-label="Actions pages">
      <button type="button" disabled={!page.offset} onClick={() => onPage(0)}>First Actions page</button>
      <button type="button" disabled={!page.offset} onClick={() => onPage(Math.max(0, page.offset - 25), page.selection)}>Previous Actions</button>
      <button type="button" disabled={page.next === null} onClick={() => page.next !== null && onPage(page.next, page.selection)}>Next Actions</button>
    </div>
  </>;
}
