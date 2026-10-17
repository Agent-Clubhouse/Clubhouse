import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { HostSwitcher } from './HostSwitcher';
import type { SatelliteConnection } from '../../stores/annexClientStore';

const sat = (id: string, alias: string, state: SatelliteConnection['state']): SatelliteConnection =>
  ({ id, alias, state, fingerprint: `fp-${id}`, icon: '', color: 'blue', host: 'h', mainPort: 1, pairingPort: 2, snapshot: null, lastError: null });

function setup(over: Partial<React.ComponentProps<typeof HostSwitcher>> = {}) {
  const props = {
    satellites: [sat('s2', 'Studio', 'connected'), sat('s1', 'Attic', 'disconnected')],
    activeHostId: null,
    needsByHost: {},
    onSwitch: vi.fn(),
    onRetry: vi.fn(),
    onPair: vi.fn(),
    onAnnexSettings: vi.fn(),
    ...over,
  };
  render(<HostSwitcher {...props} />);
  return props;
}

describe('HostSwitcher', () => {
  it('is hidden until a satellite is paired', () => {
    setup({ satellites: [] });
    expect(screen.queryByTestId('host-switcher')).toBeNull();
  });

  it('names the active host and lists every host with its state', () => {
    setup({ activeHostId: 's2' });
    expect(screen.getByTestId('host-switcher').textContent).toContain('Studio');
    fireEvent.click(screen.getByTestId('host-switcher'));
    const menu = screen.getByTestId('host-menu');
    expect(menu.textContent).toContain('Local');
    expect(screen.getByTestId('host-menu-s2').textContent).toContain('Connected');
    expect(screen.getByTestId('host-menu-s1').textContent).toContain('Offline');
    expect(screen.getByTestId('host-menu-s2').getAttribute('aria-checked')).toBe('true');
    // Connected first.
    const order = [...menu.querySelectorAll('[role="menuitemradio"]')].map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['host-menu-local', 'host-menu-s2', 'host-menu-s1']);
  });

  it('switches host, retries an offline one, and opens Annex settings', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('host-switcher'));
    expect(screen.queryByTestId('host-retry-s2')).toBeNull();
    fireEvent.click(screen.getByTestId('host-retry-s1'));
    expect(props.onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    fireEvent.click(screen.getByTestId('host-menu-s2'));
    expect(props.onSwitch).toHaveBeenCalledWith('s2');
    expect(screen.queryByTestId('host-menu')).toBeNull();

    fireEvent.click(screen.getByTestId('host-switcher'));
    fireEvent.click(screen.getByText('Pair a satellite…'));
    expect(props.onPair).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('host-switcher'));
    fireEvent.click(screen.getByText('Annex settings'));
    expect(props.onAnnexSettings).toHaveBeenCalled();
  });

  it('counts agents waiting on other hosts', () => {
    setup({ needsByHost: { local: 1, s2: 2 } });
    expect(screen.getByTestId('host-switcher').textContent).toContain('2 elsewhere');
    fireEvent.click(screen.getByTestId('host-switcher'));
    expect(screen.getByTestId('host-menu-s2').textContent).toContain('2 waiting');
    expect(screen.getByTestId('host-menu-local').textContent).toContain('1 waiting');
  });
});
