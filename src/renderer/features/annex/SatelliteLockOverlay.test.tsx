import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SatelliteLockOverlay } from './SatelliteLockOverlay';

const baseLockState = {
  locked: true,
  paused: true,
  controllerAlias: 'curious-tapir',
  controllerIcon: '🦛',
  controllerColor: 'indigo',
  controllerFingerprint: 'abc123',
};

const noop = () => {};

describe('SatelliteLockOverlay – pause floatie positioning', () => {
  it('renders at default top (48px) when no bannerOffset is provided', () => {
    render(
      <SatelliteLockOverlay
        lockState={baseLockState}
        onDisconnect={noop}
        onPause={noop}
        onDisableAndDisconnect={noop}
      />,
    );

    const floatie = screen.getByTestId('satellite-pause-floatie');
    expect(floatie.style.top).toBe('48px');
  });

  it('renders at default top (48px) when bannerOffset is 0', () => {
    render(
      <SatelliteLockOverlay
        lockState={baseLockState}
        onDisconnect={noop}
        onPause={noop}
        onDisableAndDisconnect={noop}
        bannerOffset={0}
      />,
    );

    const floatie = screen.getByTestId('satellite-pause-floatie');
    expect(floatie.style.top).toBe('48px');
  });

  it('shifts down by bannerOffset when banners are visible', () => {
    render(
      <SatelliteLockOverlay
        lockState={baseLockState}
        onDisconnect={noop}
        onPause={noop}
        onDisableAndDisconnect={noop}
        bannerOffset={72}
      />,
    );

    const floatie = screen.getByTestId('satellite-pause-floatie');
    expect(floatie.style.top).toBe('120px'); // 48 + 72
  });

  it('has a CSS transition on top for smooth animation', () => {
    render(
      <SatelliteLockOverlay
        lockState={baseLockState}
        onDisconnect={noop}
        onPause={noop}
        onDisableAndDisconnect={noop}
      />,
    );

    const floatie = screen.getByTestId('satellite-pause-floatie');
    expect(floatie.className).toContain('transition-[top]');
  });

  it('does not render the floatie when not paused', () => {
    render(
      <SatelliteLockOverlay
        lockState={{ ...baseLockState, paused: false }}
        onDisconnect={noop}
        onPause={noop}
        onDisableAndDisconnect={noop}
      />,
    );

    expect(screen.queryByTestId('satellite-pause-floatie')).toBeNull();
  });

  it('does not render anything when not locked', () => {
    const { container } = render(
      <SatelliteLockOverlay
        lockState={{ ...baseLockState, locked: false }}
        onDisconnect={noop}
        onPause={noop}
        onDisableAndDisconnect={noop}
      />,
    );

    expect(container.innerHTML).toBe('');
  });
});
