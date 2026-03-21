import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAnnexClientStore } from '../stores/annexClientStore';
import { SatelliteDisconnectedOverlay } from './SatelliteDisconnectedOverlay';

describe('SatelliteDisconnectedOverlay', () => {
  const mockRetry = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAnnexClientStore.setState({ retry: mockRetry } as any);
  });

  it('renders disconnected message with satellite alias', () => {
    render(
      <SatelliteDisconnectedOverlay
        satelliteId="sat-1"
        satelliteAlias="My Laptop"
        satelliteState="disconnected"
      />,
    );

    expect(screen.getByTestId('satellite-disconnected-overlay')).toBeInTheDocument();
    expect(screen.getByText('Connection to My Laptop is not live')).toBeInTheDocument();
    expect(screen.getByText('The remote machine may be offline or unreachable')).toBeInTheDocument();
  });

  it('shows retry button when disconnected', () => {
    render(
      <SatelliteDisconnectedOverlay
        satelliteId="sat-1"
        satelliteAlias="My Laptop"
        satelliteState="disconnected"
      />,
    );

    const retryButton = screen.getByTestId('satellite-retry-button');
    expect(retryButton).toBeInTheDocument();
    expect(retryButton).toHaveTextContent('Retry Connection');
  });

  it('calls retry with satellite ID when retry button is clicked', () => {
    render(
      <SatelliteDisconnectedOverlay
        satelliteId="sat-1"
        satelliteAlias="My Laptop"
        satelliteState="disconnected"
      />,
    );

    fireEvent.click(screen.getByTestId('satellite-retry-button'));
    expect(mockRetry).toHaveBeenCalledWith('sat-1');
  });

  it('shows reconnecting indicator when state is connecting', () => {
    render(
      <SatelliteDisconnectedOverlay
        satelliteId="sat-1"
        satelliteAlias="My Laptop"
        satelliteState="connecting"
      />,
    );

    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.getByText(/Attempting to reconnect/)).toBeInTheDocument();
    expect(screen.queryByTestId('satellite-retry-button')).not.toBeInTheDocument();
  });

  it('shows reconnecting indicator when state is discovering', () => {
    render(
      <SatelliteDisconnectedOverlay
        satelliteId="sat-1"
        satelliteAlias="My Laptop"
        satelliteState="discovering"
      />,
    );

    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.queryByTestId('satellite-retry-button')).not.toBeInTheDocument();
  });
});
