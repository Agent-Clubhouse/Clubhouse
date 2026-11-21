/** Disjoint selected metadata view. Central Details integration supplies the guarded port. */
import { useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { isRemoteCanvasMembershipPage, REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE, REMOTE_CANVAS_MEMBERSHIP_SOURCE, type RemoteCanvasMembershipPage, type RemoteCanvasMembershipQuery } from '../../../../shared/remote-canvas-membership-page';
import { DISPATCHER_PROJECT_ID } from '../../../../shared/dispatcher-types';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { parseNamespacedId } from '../../../stores/remoteProjectStore';
import { remoteDetailsAddress } from './remote-details-address';
import { CanvasMembershipList } from './CanvasMembershipList';
import { jumpToCanvas, remoteCanvasJumpUnavailable } from './agent-canvases';
import { CardNote } from './DetailsCard';

/** Adapter must preserve the enclosing Details agent identity and status before
 * extracting this page. It calls the existing authorized Details GET, never Open. */
export type ReadCanvasMembershipPage = (satelliteId: string, agentId: string, query: RemoteCanvasMembershipQuery) => Promise<ControllerReadResult<RemoteCanvasMembershipPage>>;
export function SelectedCanvasMembershipPage({ agent, supported, readable, freshnessKey, open, readPage, onRefused }: {
  agent: Agent; supported: boolean; readable: boolean; freshnessKey: string; open: boolean; readPage: ReadCanvasMembershipPage; onRefused?(): void;
}) {
  const address = remoteDetailsAddress(agent.id), project = parseNamespacedId(agent.projectId);
  const host = useAnnexClientStore((s) => s.satellites.find((sat) => sat.id === address?.satelliteId));
  const connected = host?.state === 'connected';
  const transport = useRef({ connected, generation: 0 });
  if (transport.current.connected !== connected) transport.current = { connected, generation: transport.current.generation + 1 };
  const eligible = supported && readable && open && agent.kind === 'durable' && !!address && project?.satelliteId === address.satelliteId
    && project.agentId !== DISPATCHER_PROJECT_ID && connected && !host?.snapshotUnavailable;
  const key = `${agent.id}:${agent.projectId}:${freshnessKey}:${eligible}:${transport.current.generation}`;
  const fence = useRef({ key, snapshot: host?.snapshot });
  if (fence.current.key !== key || fence.current.snapshot !== host?.snapshot) fence.current = { key, snapshot: host?.snapshot };
  const selected = fence.current;
  const pending = useRef<typeof selected | null>(null);
  const [read, setRead] = useState<{ selected: typeof selected; status: 'loading' | 'error' | 'ok'; page?: RemoteCanvasMembershipPage } | null>(null);
  const current = eligible && read?.selected === selected ? read : null;
  const page = current?.page;
  const load = async (offset = 0, selection?: string) => {
    if (!eligible || !address || !project || pending.current === selected) return;
    pending.current = selected;
    setRead({ selected, status: 'loading' });
    const stillSelected = () => fence.current === selected && useAnnexClientStore.getState().satellites.some((sat) => sat.id === address.satelliteId && sat.state === 'connected' && !sat.snapshotUnavailable && sat.snapshot === selected.snapshot);
    try {
      const result = await readPage(address.satelliteId, address.agentId, { card: 'canvases', source: REMOTE_CANVAS_MEMBERSHIP_SOURCE, offset, ...(selection && { selection }) });
      if (!stillSelected()) return;
      if (result.status === 'forbidden') onRefused?.();
      const value = result.status === 'ok' ? result.value : null;
      const valid = isRemoteCanvasMembershipPage(value) && value.agentId === address.agentId && value.projectId === project.agentId && value.offset === offset
        && (value.state !== 'recorded' || !selection || selection === value.selection);
      setRead(valid ? { selected, status: 'ok', page: value } : { selected, status: 'error' });
    } catch { // telemetry-exempt: safe page status only; no host/private source errors enter the view
      if (stillSelected()) setRead({ selected, status: 'error' });
    } finally { if (pending.current === selected) pending.current = null; }
  };
  return <section aria-label="Saved Canvas membership pages" data-testid="selected-canvas-membership-page">
    <CardNote>Saved membership pages are separate from the existing membership summary. They do not include board contents or permit opening an omitted board.</CardNote>
    {!eligible ? <CardNote>{!supported ? 'This host does not share saved membership pages. Existing summary rows remain separate.' : 'Saved membership pages are unavailable for this selection or connection.'}</CardNote> : <>
      {!current && <button type="button" className="pl-[33px] text-xs" onClick={() => void load()}>Read saved Canvas memberships</button>}
      {current?.status === 'loading' && <CardNote>Reading one saved membership page…</CardNote>}
      {current?.status === 'error' && <CardNote>The membership read was denied, changed or unavailable. Earlier page rows are withheld.</CardNote>}
      {page?.state === 'unavailable' && <CardNote>Saved membership counts are unknown ({page.reason}). Existing summary evidence is separate; no empty inventory is inferred.</CardNote>}
      {page?.state === 'recorded' && <>
        <CardNote>{page.total} saved membership rows · {page.offset + (page.rows.length ? 1 : 0)}–{page.offset + page.rows.length} shown.</CardNote>
        <CanvasMembershipList hits={page.rows.map(({ scope, canvasId, viewId, name }) => ({ scope, canvasId, viewId, name }))} onJump={(hit) => jumpToCanvas(agent, hit)} unavailable={(hit) => remoteCanvasJumpUnavailable(agent, hit)} />
        {!page.total && <CardNote>No membership is recorded in these saved Home and selected-project inventories. This does not inspect live unsaved membership.</CardNote>}
        {(page.offset > 0 || page.next !== null) && <div className="pl-[33px] flex gap-3 text-xs"><button type="button" disabled={!page.offset} onClick={() => void load(Math.max(0, page.offset - REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE), page.selection)}>Previous memberships</button><button type="button" disabled={page.next === null} onClick={() => void load(page.next!, page.selection)}>Next memberships</button></div>}
      </>}
      {page?.notes.map((note, index) => <CardNote key={index}>{note}</CardNote>)}
      {current && current.status !== 'loading' && <button type="button" className="pl-[33px] text-xs" onClick={() => void load()}>Restart saved membership pages</button>}
    </>}
  </section>;
}
