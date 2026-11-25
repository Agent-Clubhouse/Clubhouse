import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteCanvasMembershipPage } from '../../../../shared/remote-canvas-membership-page';
import type { RemoteCanvasBoardPage } from '../../../../shared/remote-canvas-board-page';
import { REMOTE_DETAILS_CARD_IDS } from '../../../../shared/remote-agent-details';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { SelectedCanvasMembershipPage } from './SelectedCanvasMembershipPage';
import { readCanvasBoardPage } from './RemoteCanvasesCard';

const agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', kind: 'durable', name: 'Remote', status: 'running' } as Agent;
const selection = 'b'.repeat(64), rowKey = (i: number) => i.toString(16).padStart(64, '0');
const membership = (): RemoteCanvasMembershipPage => ({ version: 1, source: 'selected-canvas-memberships', agentId: 'a1', projectId: 'p1', offset: 0, observedAt: 1, notes: [], state: 'recorded', selection, total: 2, next: null,
  rows: [0, 1].map((i) => ({ key: rowKey(i), scope: 'project' as const, canvasId: `board-${i}`, viewId: `view-${i}`, name: `Saved board ${i}` })) });
const board = (i: number, patch: Partial<RemoteCanvasBoardPage> = {}): RemoteCanvasBoardPage => ({ version: 1, source: 'selected-canvas-board', agentId: 'a1', projectId: 'p1', member: rowKey(i), selection, observedAt: 1, notes: [],
  state: 'recorded', scope: 'project', canvasId: `board-${i}`, viewId: `view-${i}`, name: `Board ${i}`,
  views: [{ key: 'c'.repeat(64), type: 'agent', label: 'Agent', member: false, x: 0, y: 0, w: 50, h: 50, z: 0 }, { key: rowKey(i), type: 'agent', label: 'Remote', member: true, x: 60, y: 0, w: 50, h: 50, z: 1 }],
  total: 2, ...patch } as RemoteCanvasBoardPage);
const omitted = () => ({ snapshotTruncated: { omitted: ['canvasState', 'appCanvasState'] } });
const navigable = (i: number) => ({ canvasState: { p1: { canvases: [{ id: `board-${i}`, views: [{ id: `view-${i}`, type: 'agent', agentId: 'a1' }] }] } } });
const setHost = (snapshot: object) => useAnnexClientStore.setState({ satellites: [{ id: 'sat', alias: 'Host', state: 'connected', snapshot }] as never });
const readPage = vi.fn(), readBoard = vi.fn(), refused = vi.fn();
const props = () => ({ agent, supported: true, readable: true, open: true, freshnessKey: 'current', readPage, readBoard, onRefused: refused });
async function rows() {
  render(<SelectedCanvasMembershipPage {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' }));
  await screen.findByText('Saved board 0');
}
beforeEach(() => {
  setHost(omitted());
  readPage.mockResolvedValue({ status: 'ok', value: membership() });
  readBoard.mockReset(); readBoard.mockImplementation(async (_s, _a, query) => ({ status: 'ok', value: board(query.member === rowKey(1) ? 1 : 0) }));
});

it('previews an omitted board read-only with the captured row context, generic other agents and member focus, writing nothing', async () => {
  const remoteSet = vi.spyOn(useRemoteProjectStore, 'setState');
  await rows();
  const buttons = screen.getAllByRole('button', { name: 'Preview board (read-only)' });
  expect(buttons).toHaveLength(2); expect(readBoard).not.toHaveBeenCalled();
  fireEvent.click(buttons[1]);
  await screen.findByTestId('remote-canvas-board-preview');
  expect(readBoard).toHaveBeenCalledExactlyOnceWith('sat', 'a1', { card: 'canvases', source: 'selected-canvas-board', member: rowKey(1), selection },
    { agentId: 'a1', projectId: 'p1', member: rowKey(1), selection, scope: 'project', canvasId: 'board-1', viewId: 'view-1' });
  expect(screen.getByText('Board 1')).toBeInTheDocument(); expect(screen.getByText(/Read from Host at .*Not editable here\./)).toBeInTheDocument();
  expect(screen.getByTestId('board-member-view')).toHaveTextContent('Remote · Agent · this agent');
  expect(screen.getByTestId('board-view')).toHaveTextContent('Agent · Agent');
  expect(document.activeElement).toBe(screen.getByTestId('board-member-view'));
  expect(remoteSet).not.toHaveBeenCalled();
});

it('offers no preview for a navigable row and closes an open preview when its row becomes navigable', async () => {
  await rows();
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview board (read-only)' })[0]);
  await screen.findByTestId('remote-canvas-board-preview');
  const state = useAnnexClientStore.getState().satellites[0] as unknown as { snapshot: Record<string, unknown> };
  // Same snapshot object, changed in place: the fence is unchanged, only navigability flips.
  act(() => { delete state.snapshot.snapshotTruncated; Object.assign(state.snapshot, navigable(0)); useAnnexClientStore.setState({ satellites: [...useAnnexClientStore.getState().satellites] }); });
  expect(screen.queryByTestId('remote-canvas-board-preview')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Preview board (read-only)' })).toHaveLength(1);
});

it('retires a pending read permanently across omitted -> navigable -> omitted with the same fence (ABA), then reads again only on request', async () => {
  let finish!: (value: unknown) => void;
  readBoard.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await rows();
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview board (read-only)' })[0]);
  await screen.findByText('Reading this saved board from the host…');
  const sat = useAnnexClientStore.getState().satellites[0] as unknown as { snapshot: Record<string, unknown> };
  const flip = (toNavigable: boolean) => act(() => {
    if (toNavigable) { delete sat.snapshot.snapshotTruncated; Object.assign(sat.snapshot, navigable(0)); } else { delete sat.snapshot.canvasState; Object.assign(sat.snapshot, omitted()); }
    useAnnexClientStore.setState({ satellites: [...useAnnexClientStore.getState().satellites] });
  });
  flip(true); flip(false);
  await act(async () => { finish({ status: 'ok', value: board(0) }); });
  // The stale read never resurrects; nothing reopens on its own. A fresh read needs an explicit request.
  expect(screen.queryByTestId('remote-canvas-board-preview')).not.toBeInTheDocument();
  expect(screen.queryByText('Reading this saved board from the host…')).not.toBeInTheDocument();
  expect(readBoard).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview board (read-only)' })[0]);
  await screen.findByTestId('remote-canvas-board-preview');
  expect(readBoard).toHaveBeenCalledTimes(2);
});

it('discards a read that settles after its row became navigable', async () => {
  let finish!: (value: unknown) => void;
  readBoard.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await rows();
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview board (read-only)' })[0]);
  const sat = useAnnexClientStore.getState().satellites[0] as unknown as { snapshot: Record<string, unknown> };
  act(() => { delete sat.snapshot.snapshotTruncated; Object.assign(sat.snapshot, navigable(0)); useAnnexClientStore.setState({ satellites: [...useAnnexClientStore.getState().satellites] }); });
  await act(async () => { finish({ status: 'ok', value: board(0) }); });
  expect(screen.queryByTestId('remote-canvas-board-preview')).not.toBeInTheDocument();
});

it('shows status, not a retained preview, for an older host, refusal or limit, and reports refusal', async () => {
  await rows();
  readBoard.mockResolvedValueOnce({ status: 'unavailable' });
  fireEvent.click(screen.getAllByRole('button', { name: 'Preview board (read-only)' })[0]);
  await screen.findByText('This host does not share board previews.');
  readBoard.mockResolvedValueOnce({ status: 'forbidden' });
  fireEvent.click(screen.getByRole('button', { name: 'Read the board again' }));
  await screen.findByText('The host does not allow this board preview.'); expect(refused).toHaveBeenCalledTimes(1);
  readBoard.mockResolvedValueOnce({ status: 'ok', value: { ...board(0), state: 'unavailable', reason: 'limit', views: undefined, total: undefined, scope: undefined, canvasId: undefined, viewId: undefined, name: undefined } });
  fireEvent.click(screen.getByRole('button', { name: 'Read the board again' }));
  await screen.findByText('This board is too large to preview here.');
  expect(screen.queryByTestId('remote-canvas-board-preview')).not.toBeInTheDocument();
});

it('renderer adapter binds the captured row context: a page main would accept for another board, row or project is refused', async () => {
  const context = { agentId: 'a1', projectId: 'p1', member: rowKey(0), selection, scope: 'project' as const, canvasId: 'board-0', viewId: 'view-0' };
  const details = (page: unknown) => ({ status: 'ok', value: { version: 1, inventoryPages: 1, inventorySources: ['selected-canvas-memberships'], inventoryPageOnly: true, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'unknown',
    running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null, inventoryPage: page,
    cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1, ...(id !== 'canvases' && { requested: false }) })) } });
  const query = { card: 'canvases' as const, source: 'selected-canvas-board' as const, member: rowKey(0), selection };
  window.clubhouse.annexClient.agentDetails = vi.fn().mockResolvedValue(details(board(0)));
  expect(await readCanvasBoardPage('sat', 'a1', query, context)).toEqual({ status: 'ok', value: board(0) });
  for (const wrong of [board(0, { canvasId: 'board-9' }), board(0, { viewId: 'view-9' }), board(0, { scope: 'app' }), board(0, { projectId: 'p9' })]) {
    window.clubhouse.annexClient.agentDetails = vi.fn().mockResolvedValue(details(wrong));
    expect(await readCanvasBoardPage('sat', 'a1', query, context)).toEqual({ status: 'error' });
  }
});
