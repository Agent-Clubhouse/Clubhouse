import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_DETAILS_CARD_IDS, type RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { isRemoteInventoryPage } from '../../../../shared/remote-inventory-page';
import type { Agent } from '../../../../shared/types';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { SelectedManagedPartsPage } from './SelectedManagedPartsPage';
const agent: Agent = { id: 'remote||sat||a1', projectId: 'remote||sat||p', name: 'Selected', kind: 'durable', status: 'sleeping', color: '' };
const selection = 'a'.repeat(64), read = vi.fn();
const details = (): RemoteAgentDetails => ({ version: 1, inventoryPages: 1, inventorySources: ['selected-managed-skills'], readOnly: true, agentId: 'a1', readAt: 1, providerId: 'unknown', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null,
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1 })) });
function response(offset = 0): RemoteAgentDetails {
  const value = details(); value.inventoryPageOnly = true;
  value.cards = value.cards.map((c) => ({ ...c, ...(c.id !== 'skills-mcp' && { requested: false as const }) }));
  value.inventoryPage = { version: 1, source: 'selected-managed-skills', state: 'recorded', offset, selection, total: 126, next: offset + 25 < 126 ? offset + 25 : null, observedAt: 1, notes: ['Selected configured metadata only.'],
    rows: Array.from({ length: Math.min(25, 126 - offset) }, (_, i) => ({ key: (offset + i).toString(16).padStart(64, '0'), kind: 'skill', state: 'recorded', name: `Part ${offset + i}`, revision: 1, builtin: false })) };
  return value;
}
beforeEach(() => {
  useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'connected', snapshot: {} }] as never });
  read.mockReset().mockImplementation(async (_host, _id, query) => ({ status: 'ok', value: response(query.offset ?? 0) }));
  window.clubhouse.annexClient.agentDetails = read;
  window.clubhouse.managed.getSetup = vi.fn(); window.clubhouse.agent.getDurableConfig = vi.fn();
});
it('requests only after selection, reaches row126 and binds every continuation to the selected source identity', async () => {
  const props = { agent, details: details(), status: 'ok' as const, freshnessKey: 'same', readable: true };
  const view = render(<SelectedManagedPartsPage {...props} open={false} />);
  expect(read).not.toHaveBeenCalled(); view.rerender(<SelectedManagedPartsPage {...props} open />); expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Configured skills' }));
  await screen.findByText('Part 0 · Custom · revision 1');
  for (let offset = 25; offset <= 125; offset += 25) {
    fireEvent.click(screen.getByRole('button', { name: 'Next parts' })); await screen.findByText(`Part ${offset} · Custom · revision 1`);
    expect(read).toHaveBeenLastCalledWith('sat', 'a1', { card: 'skills-mcp', source: 'selected-managed-skills', offset, selection });
  }
  expect(screen.getByRole('button', { name: 'Next parts' })).toBeDisabled(); expect(isRemoteInventoryPage(response(125).inventoryPage)).toBe(true);
  expect(screen.getByText(/126–126 of 126/)).toBeInTheDocument(); expect(window.clubhouse.managed.getSetup).not.toHaveBeenCalled(); expect(window.clubhouse.agent.getDurableConfig).not.toHaveBeenCalled();
});
it.each(['forbidden', 'offline', 'source-replaced'] as const)('withholds prior/late selected records after %s', async (mode) => {
  const props = { agent, details: details(), status: 'ok' as const, freshnessKey: 'same', readable: true, open: true };
  const onRefused = vi.fn(), view = render(<SelectedManagedPartsPage {...props} onRefused={onRefused} />);
  fireEvent.click(screen.getByRole('button', { name: 'Configured skills' })); await screen.findByText('Part 0 · Custom · revision 1');
  let finish!: (value: unknown) => void; read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Next parts' })); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  if (mode === 'offline') act(() => useAnnexClientStore.setState({ satellites: [{ id: 'sat', state: 'disconnected' }] as never }));
  if (mode === 'source-replaced') view.rerender(<SelectedManagedPartsPage {...props} freshnessKey="replacement" onRefused={onRefused} />);
  await act(async () => { finish(mode === 'forbidden' ? { status: 'forbidden' } : { status: 'ok', value: response(25) }); });
  expect(screen.queryByText(/Part (0|25) ·/)).not.toBeInTheDocument(); if (mode === 'forbidden') expect(onRefused).toHaveBeenCalledTimes(1);
});
it('keeps old-host absence and changed inventory explicit without inventing an empty list', async () => {
  const old = details(); delete old.inventoryPages; delete old.inventorySources;
  const props = { agent, details: old, status: 'ok' as const, freshnessKey: 'same', readable: true, open: true };
  const view = render(<SelectedManagedPartsPage {...props} />); expect(screen.getByText(/not shared by this host/)).toBeInTheDocument(); expect(read).not.toHaveBeenCalled();
  read.mockResolvedValue({ status: 'ok', value: { ...response(), inventoryPage: { version: 1, source: 'selected-managed-skills', state: 'unavailable', reason: 'changed', offset: 0, notes: [], observedAt: 1 } } });
  view.rerender(<SelectedManagedPartsPage {...props} details={details()} />); fireEvent.click(screen.getByRole('button', { name: 'Configured skills' }));
  await screen.findByText(/This selected inventory changed/); expect(screen.queryByRole('list')).not.toBeInTheDocument(); expect(screen.getByText(/No empty list is inferred/)).toBeInTheDocument();
});
