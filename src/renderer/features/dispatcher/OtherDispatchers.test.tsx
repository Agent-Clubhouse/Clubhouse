import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DispatcherFederationPeer } from '../../../shared/dispatcher-federation';
import { OtherDispatchers } from './OtherDispatchers';

const NOW = Date.parse('2026-11-12T08:00:00Z');
const peer = (overrides: Partial<DispatcherFederationPeer> = {}): DispatcherFederationPeer => ({
  machineId: 'private-machine-id', address: 'hidden-controller@private-machine-id',
  machineName: 'Laptop', name: 'Dispatch', presence: 'online', link: 'active', ...overrides,
});

describe('other machines Dispatcher presence', () => {
  it.each(['online', 'working', 'asleep', 'offline', 'unavailable'] as const)('shows %s with a machine label, never a controller id', (presence) => {
    render(<OtherDispatchers peers={[peer({ presence })]} now={NOW} />);
    expect(screen.getByRole('region', { name: 'Other machines' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: new RegExp(`Dispatch on Laptop: ${presence}`, 'i') })).toBeInTheDocument();
    expect(screen.getByText('Dispatch on Laptop')).toBeInTheDocument();
    expect(screen.queryByText(/hidden-controller|private-machine-id/)).not.toBeInTheDocument();
  });

  it('retains offline last-seen information and the reason a link tripped', () => {
    render(<OtherDispatchers peers={[
      peer({ presence: 'offline', link: 'paused', lastSeen: new Date(NOW - 300_000).toISOString() }),
      peer({ machineId: 'studio', machineName: 'Studio', link: 'tripped', reason: 'causal_depth' }),
    ]} now={NOW} />);
    expect(screen.getByText('Offline, last seen 5m ago')).toBeInTheDocument();
    expect(screen.getByText('Link tripped. The cross-machine request depth limit was reached.')).toBeInTheDocument();
  });

  it('says unavailable when a remote Dispatcher is off rather than offering a wake or mutable switch', async () => {
    render(<OtherDispatchers peers={[peer({ presence: 'unavailable', link: 'unavailable', reason: 'dispatcher_off' })]} compact />);
    expect(screen.getByText('Link unavailable. The Dispatcher on that machine is turned off.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it('does not throw or invent a last-seen time for an invalid historical timestamp', () => {
    render(<OtherDispatchers peers={[peer({ presence: 'offline', link: 'paused', lastSeen: 'unknown' })]} now={NOW} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.queryByText(/last seen/)).not.toBeInTheDocument();
  });

  it('explains an empty membership without introducing any setup or manual-link control', () => {
    render(<OtherDispatchers peers={[]} />);
    expect(screen.getByText('No other computers in this Annex Network.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
