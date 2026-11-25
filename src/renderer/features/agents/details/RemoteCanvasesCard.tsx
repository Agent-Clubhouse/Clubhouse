import type { Agent } from '../../../../shared/types';
import { isRemoteAgentDetails, type RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { isRemoteCanvasMembershipPage, REMOTE_CANVAS_MEMBERSHIP_SOURCE } from '../../../../shared/remote-canvas-membership-page';
import { isRemoteCanvasBoardPage } from '../../../../shared/remote-canvas-board-page';
import type { ReadCanvasBoardPage } from './RemoteCanvasBoardPreview';
import { CardNote, DetailsCard } from './DetailsCard';
import { CanvasMembershipList } from './CanvasMembershipList';
import { jumpToCanvas, remoteCanvasJumpUnavailable } from './agent-canvases';
import { Evidence } from './RemoteDetailsEvidence';
import { SelectedCanvasMembershipPage, type ReadCanvasMembershipPage } from './SelectedCanvasMembershipPage';
import { useSelectedInventoryPage } from './useSelectedInventoryPage';

/** Existing selected Details GET only. Membership identities are not content grants. */
export const readCanvasMembershipPage: ReadCanvasMembershipPage = async (satelliteId, agentId, query) => {
  const result = await window.clubhouse.annexClient.agentDetails(satelliteId, agentId, query);
  if (result.status !== 'ok') return result;
  const value = result.value, page = value.inventoryPage;
  if (!isRemoteAgentDetails(value, agentId) || value.inventoryPages !== 1 || value.inventoryPageOnly !== true
    || !value.inventorySources?.includes(REMOTE_CANVAS_MEMBERSHIP_SOURCE) || !isRemoteCanvasMembershipPage(page)
    || page.agentId !== agentId || page.offset !== (query.offset ?? 0)
    || page.state === 'recorded' && query.selection !== undefined && page.selection !== query.selection) return { status: 'error' };
  return { status: 'ok', value: page };
};
/** Board adapter: binds the page to the context the caller captured from its membership row, never to the response. */
export const readCanvasBoardPage: ReadCanvasBoardPage = async (satelliteId, agentId, query, context) => {
  const result = await window.clubhouse.annexClient.agentDetails(satelliteId, agentId, query);
  if (result.status !== 'ok') return result;
  const value = result.value, page = value.inventoryPage;
  if (!isRemoteAgentDetails(value, agentId) || value.agentId !== context.agentId || value.inventoryPages !== 1 || value.inventoryPageOnly !== true
    || !value.inventorySources?.includes(REMOTE_CANVAS_MEMBERSHIP_SOURCE) || !isRemoteCanvasBoardPage(page, context)) return { status: 'error' };
  return { status: 'ok', value: page };
};
export function RemoteCanvasesCard({ agent, details, status, freshnessKey, open, readable, message, onToggle, onRefused }: {
  agent: Agent; details: RemoteAgentDetails | null; status: ControllerReadResult<RemoteAgentDetails>['status'] | 'loading'; freshnessKey: string; open: boolean; readable: boolean; message: string; onToggle(): void; onRefused?(): void;
}) {
  const { eligible, contextReadable, key } = useSelectedInventoryPage({ agent, details, status, freshnessKey, open, readable, card: 'canvases' });
  const observed = details?.cards.find((card) => card.id === 'canvases'), card = contextReadable ? observed : undefined;
  if (observed?.state === 'not-applicable') return null;
  return <DetailsCard id="canvases" title={card?.title ?? 'Canvases'} summary={card?.summary || message} open={open} onToggle={onToggle}>
    {card ? <>
      <CanvasMembershipList hits={card.rows.filter((r) => r.canvas).map((r) => ({ ...r.canvas!, name: r.label }))} onJump={(hit) => jumpToCanvas(agent, hit)} unavailable={(hit) => remoteCanvasJumpUnavailable(agent, hit)} />
      <Evidence card={{ ...card, rows: card.rows.filter((r) => !r.canvas) }} />
      {card.rows.some((r) => !r.canvas) && <CardNote>This host shared membership names without navigation identities.</CardNote>}
    </> : <CardNote>{message || 'Canvas membership evidence is unavailable for this host selection.'}</CardNote>}
    <SelectedCanvasMembershipPage agent={agent} supported={eligible} readable={contextReadable} freshnessKey={key} open={open} readPage={readCanvasMembershipPage} readBoard={readCanvasBoardPage} onRefused={onRefused} />
  </DetailsCard>;
}
