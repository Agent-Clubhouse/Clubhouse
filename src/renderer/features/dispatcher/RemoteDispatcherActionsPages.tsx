import { useEffect, useState } from 'react';
import type { ControllerReadResult } from '../../../shared/controller-chat';
import { REMOTE_ACTION_PAGE_SOURCE, type RemoteActionRelationshipPage } from '../../../shared/remote-action-page';
import { isSelectedDispatcherActionsPage, type SelectedDispatcherActionsQuery, type SelectedDispatcherDetails } from '../../../shared/selected-dispatcher-details';
import { SelectedActionsPage, type SelectedActionPageStatus } from '../agents/details/SelectedActionsPage';

type Result = ControllerReadResult<SelectedDispatcherDetails> | { status: 'loading' };

/** Actions relationship pages of the role the overview read returned. Every page names that role agent; any
 * role-context change (generation, receipt, pause, role event or refresh) starts over at the overview. */
export function RemoteDispatcherActionsPages({ machine, roleAgentId, dispatcherName, contextKey, children }: {
  machine: string; roleAgentId: string; dispatcherName: string; contextKey: string; children: React.ReactNode;
}) {
  const identity = `${contextKey}:${roleAgentId}`;
  const [navigation, setNavigation] = useState<{ identity: string; query: SelectedDispatcherActionsQuery } | null>(null);
  const query = navigation?.identity === identity ? navigation.query : undefined;
  const key = `${identity}:${query?.offset ?? 0}:${query?.selection ?? ''}`;
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
  // A page naming another role agent, or not answering this query, is never shown.
  const page: RemoteActionRelationshipPage | undefined = query && result.status === 'ok' && result.value.agentId === roleAgentId && isSelectedDispatcherActionsPage(result.value, query)
    && result.value.details.inventoryPage?.source === REMOTE_ACTION_PAGE_SOURCE ? result.value.details.inventoryPage : undefined;
  const status: SelectedActionPageStatus = result.status === 'ok' && !page ? 'error' : result.status;
  const select = (offset = 0, selection?: string) => setNavigation({ identity, query: { card: 'actions', source: REMOTE_ACTION_PAGE_SOURCE, offset, ...(selection && { selection }) } });
  return <>
    <div className="flex flex-wrap gap-3 pl-[33px] pr-3.5 pb-2 text-xs" aria-label="Dispatcher Actions inventory">
      <button type="button" aria-pressed={!query} onClick={() => setNavigation(null)}>Overview</button>
      <button type="button" aria-pressed={!!query} onClick={() => select()}>Browse recorded Actions</button>
    </div>
    {!query ? children : <SelectedActionsPage selectionKey={key} offset={query.offset ?? 0} result={page ? { selectionKey: key, value: page } : null}
      status={status} agentName={dispatcherName} onPage={select} />}
  </>;
}
