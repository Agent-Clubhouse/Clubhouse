import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { DispatcherPresenceSnapshot, RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
import { OtherMachinesList, presenceStateText } from './OtherMachinesList';
import { DispatcherSettingsView } from '../settings/DispatcherSettingsView';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const remote = (machineId: string, extra: Partial<RemoteDispatcherPresence> = {}): RemoteDispatcherPresence => ({
  machineId, machineName: machineId[0].toUpperCase() + machineId.slice(1), address: `controller@${machineId}`,
  dispatcherName: 'Studio', label: `Studio on ${machineId[0].toUpperCase() + machineId.slice(1)}`, state: 'online', link: { state: 'active' }, ...extra,
});

describe('Other machines (#3349)', () => {
  it('shows each remote Dispatcher on its machine with its state and link, never a bare id', () => {
    render(<OtherMachinesList now={NOW} remotes={[
      remote('desk', { state: 'working' }),
      remote('laptop', { state: 'offline', lastSeen: '2026-11-13T10:00:00.000Z', link: { state: 'paused', reason: 'The other computer is offline.' } }),
      remote('studio', { state: 'off', link: { state: 'unavailable', reason: 'The other Dispatcher is off.' } }),
      remote('attic', { state: 'unknown', address: null, dispatcherName: null, label: 'Dispatcher on Attic', link: { state: 'unavailable', reason: 'Not shared yet.' } }),
    ]} />);
    const list = screen.getByRole('list', { name: 'Dispatchers on other machines' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Studio on Desk. Working. Link active.',
      'Studio on Laptop. Offline, last seen 2h ago. Link paused: The other computer is offline.',
      'Studio on Studio. Turned off. Link unavailable: The other Dispatcher is off.',
      'Dispatcher on Attic. Not known yet. Link unavailable: Not shared yet.',
    ]);
    expect(screen.getByTestId('other-machine-laptop-state').textContent).toBe('Offline, last seen 2h ago. Link paused: The other computer is offline.');
    expect(screen.queryByText('controller@desk')).toBeNull();
  });

  it('shows a link a fixed limit tripped as tripped, with the limit, in full and compact lists', () => {
    const tripped = remote('desk', { link: { state: 'tripped', reason: 'The controller link rate limit was reached.' } });
    const { unmount } = render(<OtherMachinesList remotes={[tripped]} />);
    expect(screen.getByTestId('other-machine-desk-state').textContent).toBe('Online. Link tripped: The controller link rate limit was reached.');
    expect(screen.getByTestId('other-machine-desk').getAttribute('aria-label')).toBe('Studio on Desk. Online. Link tripped: The controller link rate limit was reached.');
    unmount();
    render(<OtherMachinesList compact remotes={[tripped]} />);
    expect(screen.getByTestId('other-machine-desk-state').textContent).toBe('Online. Link tripped');
  });

  it('keeps the compact list short: state, and the link only when it isn\'t active', () => {
    render(<OtherMachinesList compact remotes={[remote('desk'), remote('laptop', { state: 'offline', link: { state: 'paused', reason: 'x' } })]} />);
    expect(screen.getByTestId('other-machine-desk-state').textContent).toBe('Online');
    expect(screen.getByTestId('other-machine-laptop-state').textContent).toBe('Offline. Link paused');
  });

  it('reads an unparseable last-seen as plain offline', () => {
    expect(presenceStateText(remote('desk', { state: 'offline', lastSeen: 'not a date' }), NOW)).toBe('Offline');
  });

  it('adds the section to Settings › Dispatcher only with other computers, and follows pushes', async () => {
    let push: ((s: DispatcherPresenceSnapshot) => void) | null = null;
    const getPresence = vi.fn(async () => ({ remotes: [] }));
    window.clubhouse.dispatcher.getPresence = getPresence;
    window.clubhouse.dispatcher.onPresenceChanged = vi.fn((cb) => { push = cb; return () => { push = null; }; });
    render(<DispatcherSettingsView />);
    await screen.findByTestId('dispatcher-settings');
    // Barriers: the section has subscribed and its first read has landed, so the push below can't be lost or overwritten.
    await waitFor(() => { expect(push).not.toBeNull(); expect(getPresence).toHaveBeenCalled(); });
    await act(async () => { await getPresence.mock.results[0].value; });
    expect(screen.queryByText('Other machines')).toBeNull();
    act(() => push!({ remotes: [remote('desk', { state: 'asleep' })] }));
    expect(await screen.findByText('Other machines')).toBeTruthy();
    expect((await screen.findByTestId('other-machine-desk-state')).textContent).toBe('Asleep. Link active');
  });
});
