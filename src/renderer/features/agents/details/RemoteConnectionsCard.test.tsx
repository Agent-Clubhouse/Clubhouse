import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails, RemoteDetailsCard } from '../../../../shared/remote-agent-details';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { RemoteConnectionsCard } from './RemoteConnectionsCard';
const agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Remote', kind: 'durable', status: 'running' } as Agent;
const card: RemoteDetailsCard = { id: 'connections', title: 'Connections', state: 'ok', summary: 'Overview records', rows: [{ label: 'Overview', value: 'Selected host records' }], notes: [], omitted: 0, observedAt: 1 };
const details = { agentId: 'a1', connectionPages: 1, readAt: 1, cards: [card] } as RemoteAgentDetails;
const request = vi.fn();
const show = (extra = {}) => render(<RemoteConnectionsCard agent={agent} details={details} status="ok" freshnessKey="run1" dispatcher={false} open onToggle={() => {}} {...extra} />);
beforeEach(() => {
  request.mockReset();
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: {} }] as never });
  Object.assign(window.clubhouse.annexClient, { agentDetails: request });
  request.mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: { ...details, cards: [{ ...card, summary: 'Selected source page', rows: [{ label: query.offset ? 'Final helper' : 'First helper', value: 'Scoped source' }], connectionPage: { source: query.source, offset: query.offset ?? 0, projectOffset: query.projectOffset ?? 0, known: 9, complete: false, next: query.offset ? null : { offset: 8, projectOffset: 0 } } }] } }));
});
it('shows the existing overview without probing, then reads and replaces bounded selected-source pages', async () => {
  show(); expect(screen.getByText('Selected host records')).toBeInTheDocument(); expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Helper relationships' })); await screen.findByText('First helper');
  expect(request).toHaveBeenCalledWith('sat', 'a1', { card: 'connections', source: 'helpers', offset: 0, projectOffset: 0 });
  fireEvent.click(screen.getByRole('button', { name: 'Next', exact: true })); await screen.findByText('Final helper');
  expect(screen.queryByText('First helper')).not.toBeInTheDocument(); expect(screen.getByText(/additional records may be unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Previous', exact: true })); await screen.findByText('First helper');
  fireEvent.click(screen.getByRole('button', { name: 'Saved switches' })); await waitFor(() => expect(request).toHaveBeenLastCalledWith('sat', 'a1', { card: 'connections', source: 'directions', offset: 0, projectOffset: 0 }));
});
it('withholds a delayed previous-source page and all prior evidence after denial, selection or offline transition', async () => {
  let finish!: (value: unknown) => void; request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = show(); fireEvent.click(screen.getByRole('button', { name: 'Helper relationships' })); await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Saved switches' })); await screen.findByText('First helper');
  await act(async () => finish({ status: 'ok', value: { ...details, cards: [{ ...card, rows: [{ label: 'PRIVATE_STALE_SOURCE', value: 'late' }], connectionPage: { source: 'helpers', offset: 0, projectOffset: 0, known: 1, complete: true, next: null } }] } }));
  expect(screen.queryByText('PRIVATE_STALE_SOURCE')).not.toBeInTheDocument();
  view.rerender(<RemoteConnectionsCard agent={agent} details={null} status="forbidden" freshnessKey="run1" dispatcher={false} open onToggle={() => {}} />);
  expect(screen.queryByText('First helper')).not.toBeInTheDocument(); expect(screen.getByTestId('details-card-connections')).toHaveTextContent('does not allow');
  act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'disconnected' }] as never })); expect(screen.getByTestId('details-card-connections')).toHaveTextContent('Host offline');
});
it('does not query old hosts or malformed remote identities, while preserving authorized old-host overview', async () => {
  const view = show({ details: { ...details, connectionPages: undefined } }); expect(screen.getByText('Selected host records')).toBeInTheDocument(); expect(screen.getByText(/needs a host update|needs a host|host update/)).toBeInTheDocument(); expect(request).not.toHaveBeenCalled();
  view.rerender(<RemoteConnectionsCard agent={{ ...agent, id: 'a1' }} details={details} status="ok" freshnessKey="run1" dispatcher={false} open onToggle={() => {}} />);
  expect(screen.queryByText('Selected host records')).not.toBeInTheDocument(); expect(request).not.toHaveBeenCalled();
});
it('offers the canonical Dispatcher inventory independently of normal durable manual/helper sources', () => {
  show({ dispatcher: true }); expect(screen.getByRole('button', { name: 'Automatic agent links' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Helper relationships' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Saved Dispatcher links' })).not.toBeInTheDocument();
});
it('rejects a successful response for a different page instead of rendering its records', async () => {
  request.mockResolvedValue({ status: 'ok', value: { ...details, cards: [{ ...card, rows: [{ label: 'PRIVATE_WRONG_PAGE', value: 'wrong' }], connectionPage: { source: 'incoming', offset: 0, projectOffset: 0, known: 1, complete: true, next: null } }] } });
  show(); fireEvent.click(screen.getByRole('button', { name: 'Helper relationships' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1)); await act(async () => { await Promise.resolve(); });
  expect.soft(screen.queryByText('PRIVATE_WRONG_PAGE')).not.toBeInTheDocument();
  expect.soft(screen.getByTestId('details-card-connections')).toHaveTextContent('did not return the selected source page');
});

it('offers new saved-source views only when the admitted host explicitly advertises them', async () => {
  const view = show(); expect(screen.queryByRole('button', { name: 'Saved tool links' })).not.toBeInTheDocument();
  view.rerender(<RemoteConnectionsCard agent={agent} details={{ ...details, connectionPageSources: ['tool-records'] }} status="ok" freshnessKey="run1" dispatcher={false} open onToggle={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Outgoing bindings' })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Saved tool links' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('sat', 'a1', { card: 'connections', source: 'tool-records', offset: 0, projectOffset: 0 }));
});
