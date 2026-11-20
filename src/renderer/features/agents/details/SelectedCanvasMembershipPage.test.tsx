import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteCanvasMembershipPage } from '../../../../shared/remote-canvas-membership-page';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { useUIStore } from '../../../stores/uiStore';
import { SelectedCanvasMembershipPage } from './SelectedCanvasMembershipPage';
const agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', kind: 'durable', name: 'Remote', status: 'running' } as Agent;
const read = vi.fn(), refused = vi.fn();
const token = 'a'.repeat(64);
const fixture = (offset = 0): RemoteCanvasMembershipPage => ({ version: 1, source: 'selected-canvas-memberships', agentId: 'a1', projectId: 'p1', offset, observedAt: 1, notes: [], state: 'recorded', selection: token, total: 105, next: offset + 25 < 105 ? offset + 25 : null,
  rows: Array.from({ length: Math.min(25, 105 - offset) }, (_, i) => ({ key: (offset + i).toString(16).padStart(64, '0'), scope: 'project', canvasId: `board-${offset + i}`, viewId: `view-${offset + i}`, name: `Saved board ${offset + i}` })) });
const props = () => ({ agent, supported: true, readable: true, open: true, freshnessKey: 'current', readPage: read, onRefused: refused });
beforeEach(() => {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: { snapshotTruncated: { omitted: ['canvasState', 'appCanvasState'] } } }] as never });
  useUIStore.setState({ activeHostId: 'before' });
  read.mockImplementation(async (_host, _agent, query) => ({ status: 'ok', value: fixture(query.offset ?? 0) }));
  window.clubhouse.canvas.getAgentCanvases = vi.fn();
});
it('pages beyond100 only on request and never promotes an omitted board to navigation', async () => {
  render(<SelectedCanvasMembershipPage {...props()} />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' }));
  await screen.findByText('Saved board 0');
  expect(read).toHaveBeenCalledExactlyOnceWith('sat', 'a1', { card: 'canvases', source: 'selected-canvas-memberships', offset: 0 });
  const button = screen.getAllByTestId('details-canvas-row')[0];
  expect(button).toBeDisabled(); fireEvent.click(button);
  expect(useUIStore.getState().activeHostId).toBe('before');
  for (let offset = 25; offset <= 100; offset += 25) {
    fireEvent.click(screen.getByRole('button', { name: 'Next memberships' }));
    await screen.findByText(`Saved board ${offset}`);
    expect(read).toHaveBeenLastCalledWith('sat', 'a1', { card: 'canvases', source: 'selected-canvas-memberships', offset, selection: token });
  }
  expect(screen.getByText('Saved board 104')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next memberships' })).toBeDisabled();
  expect(window.clubhouse.canvas.getAgentCanvases).not.toHaveBeenCalled();
});
it.each(['project', 'agent', 'offset', 'selection'] as const)('withholds a response with the wrong %s echo', async (field) => {
  const value = fixture();
  if (field === 'project') value.projectId = 'p2';
  if (field === 'agent') value.agentId = 'a2';
  if (field === 'offset') value.offset = 25;
  read.mockResolvedValue({ status: 'ok', value });
  render(<SelectedCanvasMembershipPage {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' }));
  if (field === 'selection') {
    await screen.findByText('Saved board 0');
    read.mockResolvedValue({ status: 'ok', value: { ...fixture(25), selection: 'b'.repeat(64) } });
    fireEvent.click(screen.getByRole('button', { name: 'Next memberships' }));
  }
  await screen.findByText(/Earlier page rows are withheld/);
  expect(screen.queryByTestId('details-canvas-row')).not.toBeInTheDocument();
});
it('leaves unrelated known summary evidence separate while a denied page clears its own private rows', async () => {
  render(<><p>Existing known membership summary</p><SelectedCanvasMembershipPage {...props()} /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' }));
  await screen.findByText('Saved board 0');
  read.mockResolvedValueOnce({ status: 'forbidden' });
  fireEvent.click(screen.getByRole('button', { name: 'Next memberships' }));
  await screen.findByText(/Earlier page rows are withheld/);
  expect(refused).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Existing known membership summary')).toBeInTheDocument();
  expect(screen.queryByText('Saved board 0')).not.toBeInTheDocument();
});
it.each(['host', 'project', 'snapshot', 'offline', 'read denied', 'closed'] as const)('discards late membership rows after %s changes', async (change) => {
  let finish!: (value: unknown) => void;
  read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<SelectedCanvasMembershipPage {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const next = props();
  if (change === 'host') next.agent = { ...agent, id: 'remote||other||a1', projectId: 'remote||other||p1' };
  if (change === 'project') next.agent = { ...agent, projectId: 'remote||sat||p2' };
  if (change === 'snapshot' || change === 'offline') act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: change === 'offline' ? 'disconnected' : 'connected', snapshot: {} }] as never }));
  if (change === 'read denied') next.readable = false;
  if (change === 'closed') next.open = false;
  view.rerender(<SelectedCanvasMembershipPage {...next} />);
  await act(async () => finish({ status: 'ok', value: fixture() }));
  expect(screen.queryByText('Saved board 0')).not.toBeInTheDocument();
});
it('keeps an unavailable source distinct from a verified empty page and does not read unsupported hosts', async () => {
  const view = render(<SelectedCanvasMembershipPage {...props()} supported={false} />);
  expect(read).not.toHaveBeenCalled(); expect(screen.getByText(/does not share saved membership pages/)).toBeInTheDocument();
  read.mockResolvedValue({ status: 'ok', value: { version: 1, source: 'selected-canvas-memberships', agentId: 'a1', projectId: 'p1', offset: 0, observedAt: 1, notes: [], state: 'unavailable', reason: 'unreadable' } });
  view.rerender(<SelectedCanvasMembershipPage {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved Canvas memberships' }));
  await screen.findByText(/Saved membership counts are unknown/);
  expect(screen.queryByText(/No membership is recorded/)).not.toBeInTheDocument();
  read.mockResolvedValue({ status: 'ok', value: { ...fixture(), total: 0, rows: [], next: null } });
  fireEvent.click(screen.getByRole('button', { name: 'Restart saved membership pages' }));
  await screen.findByText(/No membership is recorded/);
});
