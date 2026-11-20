import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { REMOTE_DETAILS_CARD_IDS, type RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useUIStore } from '../../../stores/uiStore';
import { RemoteCanvasesCard } from './RemoteCanvasesCard';
const agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', kind: 'durable', name: 'Selected', status: 'sleeping' } as Agent;
const read = vi.fn(), selection = 'a'.repeat(64);
const details = (): RemoteAgentDetails => ({ version: 1, inventoryPages: 1, inventorySources: ['selected-canvas-memberships'], agentId: 'a1', readOnly: true, readAt: 1, providerId: 'unknown', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null,
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: id === 'canvases' ? [{ label: 'Legacy board summary', value: 'Saved membership' }] : [], notes: [], omitted: 0, observedAt: 1 })) });
function page(offset = 0): RemoteAgentDetails {
  return { ...details(), inventoryPageOnly: true, cards: details().cards.map((c) => ({ ...c, rows: [], ...(c.id !== 'canvases' && { requested: false as const }) })), inventoryPage: {
    version: 1, source: 'selected-canvas-memberships', agentId: 'a1', projectId: 'p1', state: 'recorded', offset, selection, total: 106, next: offset + 25 < 106 ? offset + 25 : null, observedAt: 1, notes: ['Saved metadata only, not board contents.'],
    rows: Array.from({ length: Math.min(25, 106 - offset) }, (_, i) => ({ key: (offset + i).toString(16).padStart(64, '0'), name: `Saved board ${offset + i}`, scope: 'project', canvasId: `board-${offset + i}`, viewId: `view-${offset + i}` })),
  } };
}
const props = () => ({ agent, details: details(), status: 'ok' as const, freshnessKey: 'current', readable: true, open: true, message: '', onToggle: vi.fn(), onRefused: vi.fn() });
beforeEach(() => {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: { snapshotTruncated: { omitted: ['canvasState', 'appCanvasState'] } } }] as never });
  useUIStore.setState({ activeHostId: 'before' });
  read.mockReset().mockImplementation(async (_host, _agent, query) => ({ status: 'ok', value: page(query.offset ?? 0) })); window.clubhouse.annexClient.agentDetails = read;
  window.clubhouse.canvas.getAgentCanvases = vi.fn();
});
it('wires selected Details to all saved membership pages while omitted boards remain disabled', async () => {
  const p = props(), view = render(<RemoteCanvasesCard {...p} open={false} />); expect(read).not.toHaveBeenCalled();
  view.rerender(<RemoteCanvasesCard {...p} />); expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' })); await screen.findByText('Saved board 0');
  for (let offset = 25; offset <= 100; offset += 25) {
    fireEvent.click(screen.getByRole('button', { name: 'Next memberships' })); await screen.findByText(`Saved board ${offset}`);
    expect(read).toHaveBeenLastCalledWith('sat', 'a1', { card: 'canvases', source: 'selected-canvas-memberships', offset, selection });
  }
  expect(screen.getByText('Saved board 105')).toBeInTheDocument();
  for (const row of screen.getAllByTestId('details-canvas-row')) { expect(row).toBeDisabled(); fireEvent.click(row); }
  expect(useUIStore.getState().activeHostId).toBe('before'); expect(window.clubhouse.canvas.getAgentCanvases).not.toHaveBeenCalled();
});
it.each(['agent', 'project', 'mixed', 'default', 'card', 'source'] as const)('rejects a page with mismatched %s enclosing evidence', async (field) => {
  const value = page();
  if (field === 'agent') value.agentId = 'other';
  if (field === 'project' && value.inventoryPage?.source === 'selected-canvas-memberships') value.inventoryPage.projectId = 'other';
  if (field === 'mixed') value.helperPageOnly = true;
  if (field === 'default') delete value.inventoryPageOnly;
  if (field === 'card') value.cards = value.cards.map((c) => ({ ...c, requested: c.id === 'actions' ? undefined : false }));
  if (field === 'source') value.inventorySources = ['selected-action-relationships'];
  read.mockResolvedValue({ status: 'ok', value }); render(<RemoteCanvasesCard {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' })); await screen.findByText(/Earlier page rows are withheld/);
  expect(screen.queryByTestId('details-canvas-row')).not.toBeInTheDocument();
});
it.each(['offline', 'denied', 'frame', 'project', 'snapshot'] as const)('withholds late selected rows after %s', async (change) => {
  const p = props(), view = render(<RemoteCanvasesCard {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' })); await screen.findByText('Saved board 0');
  let finish!: (value: unknown) => void; read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Next memberships' })); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  if (change === 'offline') act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'disconnected' }] as never }));
  if (change === 'frame') view.rerender(<RemoteCanvasesCard {...p} details={{ ...p.details, readAt: 2 }} />);
  if (change === 'project') view.rerender(<RemoteCanvasesCard {...p} agent={{ ...agent, projectId: 'remote||sat||other' }} />);
  if (change === 'snapshot') act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: {} }] as never }));
  await act(async () => { finish(change === 'denied' ? { status: 'forbidden' } : { status: 'ok', value: page(25) }); });
  expect(screen.queryByTestId('details-canvas-row')).not.toBeInTheDocument();
  if (change === 'denied') expect(p.onRefused).toHaveBeenCalledTimes(1);
});
it('preserves old-host summary without inventing a selected source', () => {
  const p = props(); delete p.details.inventoryPages; delete p.details.inventorySources;
  render(<RemoteCanvasesCard {...p} />); expect(screen.getByText('Legacy board summary')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Read saved Canvas memberships' })).not.toBeInTheDocument(); expect(read).not.toHaveBeenCalled();
});
