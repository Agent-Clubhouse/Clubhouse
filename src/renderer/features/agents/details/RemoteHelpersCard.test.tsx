import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import type { RemoteHelperPage } from '../../../../shared/remote-helper-page';
import { RemoteHelpersCard } from './RemoteHelpersCard';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
vi.mock('./remote-helper-navigation', () => ({ remoteHelperOpenUnavailable: () => 'Current helper identity not available for navigation.', openRemoteHelper: vi.fn() }));
const request = vi.fn();
const agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p1', name: 'Parent', kind: 'durable', status: 'running' } as Agent;
const page = (offset = 0): RemoteHelperPage => ({ version: 1, source: 'selected-direct-helpers', state: 'ok', offset, next: offset ? null : 8, total: 9, liveCount: 8, disposedCount: 1, pendingCount: null, pending: [], notes: ['Pending starts unavailable.'], rows: [{ key: 'helper-' + offset, name: offset ? 'Last helper' : 'First helper', projectName: 'Host project display', status: offset ? 'disposed' : 'needs-you', statusSource: offset ? 'saved' : 'current-run', branch: 'feature', failure: null, disposedAt: offset ? '2026-11-20T00:00:00Z' : null, work: offset ? { state: 'unavailable', reason: 'not-applicable' } : { state: 'recorded', text: '2 uncommitted' } }] });
const details = { agentId: 'a1', readAt: 1, helperPages: 1, helperPage: page(), cards: [{ id: 'orchestrate', title: 'Orchestration', summary: 'on', state: 'ok', rows: [], notes: [], omitted: 0 }] } as unknown as RemoteAgentDetails;
const show = (props = {}) => render(<RemoteHelpersCard agent={agent} details={details} status="ok" freshnessKey="run1" open onToggle={() => {}} {...props} />);
beforeEach(() => {
  (window as unknown as { clubhouse: unknown }).clubhouse = { annexClient: { agentDetails: request } };
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: { projects: [], agents: {} } }] as never });
  request.mockImplementation(async (_sat, _id, query) => ({ status: 'ok', value: { ...details, helperPageOnly: true, helperPage: page(query.offset) } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('renders separate state/work/project/disposed counts and replaces bounded selected pages without writes', async () => {
  show(); expect(screen.getByText('First helper')).toBeInTheDocument(); expect(screen.getByText('Needs you')).toBeInTheDocument(); expect(screen.getByText('Host project display')).toBeInTheDocument(); expect(screen.getByText(/Pending count unavailable/)).toBeInTheDocument(); expect(request).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Open', exact: true })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Next helpers' })); await waitFor(() => expect(request).toHaveBeenCalledWith('sat', 'a1', { card: 'orchestrate', source: 'helpers', offset: 8 }));
  await screen.findByRole('button', { name: 'Disposed (1)' }); fireEvent.click(screen.getByRole('button', { name: 'Disposed (1)' })); expect(await screen.findByText('Last helper')).toBeInTheDocument(); expect(screen.queryByText('First helper')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Next helpers' })).toBeDisabled();
});
it('withholds mismatched helper offset and private old content after denied or offline reads', async () => {
  request.mockResolvedValue({ status: 'ok', value: { ...details, helperPageOnly: true, helperPage: { ...page(), rows: [{ ...page().rows[0], name: 'PRIVATE_WRONG_PAGE' }] } } });
  const view = show(); fireEvent.click(screen.getByRole('button', { name: 'Next helpers' })); await waitFor(() => expect(request).toHaveBeenCalledTimes(1)); expect(screen.queryByText('PRIVATE_WRONG_PAGE')).not.toBeInTheDocument(); expect(screen.queryByText('First helper')).not.toBeInTheDocument();
  request.mockResolvedValue({ status: 'forbidden' }); fireEvent.click(screen.getByRole('button', { name: 'Refresh helpers' })); await screen.findByText('The host does not allow this helper read.');
  view.rerender(<RemoteHelpersCard agent={agent} details={details} status="forbidden" freshnessKey="run1" open onToggle={() => {}} />); expect(screen.queryByText('Host project display')).not.toBeInTheDocument();
});
it('ignores delayed page results after selected parent replacement', async () => {
  let finish!: (value: unknown) => void; request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = show(); fireEvent.click(screen.getByRole('button', { name: 'Next helpers' })); await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  view.rerender(<RemoteHelpersCard agent={{ ...agent, id: 'remote||sat||other' }} details={null} status="loading" freshnessKey="run2" open onToggle={() => {}} />);
  await act(async () => { finish({ status: 'ok', value: { ...details, helperPageOnly: true, helperPage: page(8) } }); }); expect(screen.queryByText('Last helper')).not.toBeInTheDocument();
});
it('preserves an older host legacy summary without probing helper pages', () => {
  show({ details: { ...details, helperPages: undefined, helperPage: undefined, cards: [{ ...details.cards[0], rows: [{ label: 'Legacy helper', value: 'Recorded older helper summary' }] }] } });
  expect(screen.getByText('Recorded older helper summary')).toBeInTheDocument(); expect(screen.getByText(/Structured helper rows and work pages need a host update/)).toBeInTheDocument(); expect(request).not.toHaveBeenCalled();
});
