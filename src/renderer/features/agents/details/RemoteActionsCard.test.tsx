import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Agent } from '../../../../shared/types';
import { REMOTE_DETAILS_CARD_IDS, type RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { RemoteActionsCard } from './RemoteActionsCard';
const agent: Agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p', kind: 'durable', name: 'Selected', status: 'sleeping', color: '' };
const read = vi.fn(), selection = 'a'.repeat(64);
const details = (): RemoteAgentDetails => ({ version: 1, inventoryPages: 1, inventorySources: ['selected-action-relationships'], agentId: 'a1', readOnly: true, readAt: 1, providerId: 'unknown', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null,
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: id === 'actions' ? [{ label: 'Legacy summary name', value: 'On · safe summary' }] : [], notes: [], omitted: 0, observedAt: 1 })) });
function page(offset = 0): RemoteAgentDetails {
  return { ...details(), inventoryPageOnly: true, cards: details().cards.map((c) => ({ ...c, rows: [], ...(c.id !== 'actions' && { requested: false as const }) })), inventoryPage: {
    version: 1, source: 'selected-action-relationships', state: 'recorded', offset, selection, totalRelationships: 126, uniqueActions: 42, next: offset + 25 < 126 ? offset + 25 : null, observedAt: 1, notes: ['Recorded relationships, not execution or authority.'],
    rows: Array.from({ length: Math.min(25, 126 - offset) }, (_, i) => ({ key: (offset + i).toString(16).padStart(64, '0'), name: `Action ${(offset + i) % 42}`, group: offset + i < 42 ? 'owned' : offset + i < 84 ? 'targeting' : 'triggered-by', enabled: false, description: 'When Selected sleeps → Message Selected' })),
  } };
}
beforeEach(() => {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: {} }] as never });
  read.mockReset().mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: page(query.offset ?? 0) })); window.clubhouse.annexClient.agentDetails = read;
  for (const method of ['list', 'history', 'runNow', 'setEnabled', 'update', 'delete'] as const) Object.assign(window.clubhouse.actions, { [method]: vi.fn() });
});
it('reaches the final relationship group with the shared selection token and no local management APIs', async () => {
  const props = { agent, details: details(), status: 'ok' as const, freshnessKey: 'same', readable: true, message: '', onToggle: vi.fn() };
  const view = render(<RemoteActionsCard {...props} open={false} />); expect(read).not.toHaveBeenCalled();
  view.rerender(<RemoteActionsCard {...props} open />); fireEvent.click(screen.getByRole('button', { name: 'Browse recorded Actions' }));
  await screen.findByText('Action 0'); expect(screen.getByRole('region', { name: 'Owned by Selected' })).toBeInTheDocument();
  for (let offset = 25; offset <= 125; offset += 25) {
    fireEvent.click(screen.getByRole('button', { name: 'Next Actions' }));
    await waitFor(() => expect(screen.getAllByTestId('selected-action-row')).toHaveLength(Math.min(25, 126 - offset)));
    expect(read).toHaveBeenLastCalledWith('sat', 'a1', { card: 'actions', source: 'selected-action-relationships', offset, selection });
  }
  expect(screen.getByRole('region', { name: 'Set off by Selected' })).toHaveTextContent('Action 41'); expect(screen.getByRole('button', { name: 'Next Actions' })).toBeDisabled();
  for (const row of screen.getAllByTestId('selected-action-row')) { expect(within(row).queryByRole('button')).not.toBeInTheDocument(); fireEvent.click(row); }
  for (const method of ['list', 'history', 'runNow', 'setEnabled', 'update', 'delete'] as const) expect(window.clubhouse.actions[method]).not.toHaveBeenCalled();
});
it.each(['offline', 'refused', 'new-frame'] as const)('withholds late/private page records after %s', async (mode) => {
  const props = { agent, details: details(), status: 'ok' as const, freshnessKey: 'same', readable: true, open: true, message: '', onToggle: vi.fn() };
  const onRefused = vi.fn(), view = render(<RemoteActionsCard {...props} onRefused={onRefused} />);
  fireEvent.click(screen.getByRole('button', { name: 'Browse recorded Actions' })); await screen.findByText('Action 0');
  let finish!: (value: unknown) => void; read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Next Actions' })); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  if (mode === 'offline') act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'disconnected' }] as never }));
  if (mode === 'new-frame') view.rerender(<RemoteActionsCard {...props} freshnessKey="new" onRefused={onRefused} />);
  await act(async () => { finish(mode === 'refused' ? { status: 'forbidden' } : { status: 'ok', value: page(25) }); });
  expect(screen.queryByTestId('selected-action-row')).not.toBeInTheDocument(); if (mode === 'refused') expect(onRefused).toHaveBeenCalledTimes(1);
  if (mode === 'offline') expect(screen.queryByText('Legacy summary name')).not.toBeInTheDocument();
});
it('preserves old-host summaries and does not invent source continuation', () => {
  const old = details(); delete old.inventoryPages; delete old.inventorySources;
  render(<RemoteActionsCard agent={agent} details={old} status="ok" freshnessKey="old" readable open message="" onToggle={vi.fn()} />);
  expect(screen.getByText('Legacy summary name')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Browse recorded Actions' })).not.toBeInTheDocument();
  expect(screen.getByText(/summary only/)).toBeInTheDocument(); expect(read).not.toHaveBeenCalled();
});
