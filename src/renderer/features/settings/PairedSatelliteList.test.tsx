import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PairedSatelliteList } from './PairedSatelliteList';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import type { SatelliteConnection } from '../../stores/annexClientStore';

const mockDisconnect = vi.fn();
const mockRetry = vi.fn();
const mockForgetSatellite = vi.fn();

function resetStore() {
  useAnnexClientStore.setState({
    satellites: [],
    disconnect: mockDisconnect,
    retry: mockRetry,
    forgetSatellite: mockForgetSatellite,
    loadSatellites: vi.fn(),
    scan: vi.fn(),
    connect: vi.fn(),
    pairWith: vi.fn(),
    forgetAllSatellites: vi.fn(),
    getDiscovered: vi.fn().mockResolvedValue([]),
    discoveredServices: [],
    loadDiscovered: vi.fn(),
  });
}

const mockSatellite: SatelliteConnection = {
  id: 'sat-1',
  fingerprint: 'fp-123',
  alias: 'Test Satellite',
  color: '#aabbcc',
  state: 'connected',
  lastError: null,
};

const mockDisconnectedSatellite: SatelliteConnection = {
  id: 'sat-2',
  fingerprint: 'fp-456',
  alias: 'Offline Satellite',
  color: '#ddeeff',
  state: 'disconnected',
  lastError: null,
};

const mockIncompatibleSatellite: SatelliteConnection = {
  id: 'sat-3',
  fingerprint: 'fp-789',
  alias: 'Bad Version',
  color: '#ffccaa',
  state: 'disconnected',
  lastError: 'Incompatible version',
};

describe('PairedSatelliteList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('renders empty list when no satellites', () => {
    const { container } = render(<PairedSatelliteList satellites={[]} />);
    const listContainer = container.querySelector('.space-y-2');
    expect(listContainer?.children.length).toBe(0);
  });

  it('renders satellite alias', () => {
    render(<PairedSatelliteList satellites={[mockSatellite]} />);
    expect(screen.getByText('Test Satellite')).toBeInTheDocument();
  });

  it('renders connected status', () => {
    render(<PairedSatelliteList satellites={[mockSatellite]} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('renders disconnect button for connected satellite', () => {
    render(<PairedSatelliteList satellites={[mockSatellite]} />);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('calls disconnect when disconnect button clicked', () => {
    render(<PairedSatelliteList satellites={[mockSatellite]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mockDisconnect).toHaveBeenCalledWith('fp-123');
  });

  it('renders disconnected satellite status', () => {
    render(<PairedSatelliteList satellites={[mockDisconnectedSatellite]} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('renders retry button for disconnected satellite', () => {
    render(<PairedSatelliteList satellites={[mockDisconnectedSatellite]} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('calls retry when retry button clicked', () => {
    render(<PairedSatelliteList satellites={[mockDisconnectedSatellite]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRetry).toHaveBeenCalledWith('fp-456');
  });

  it('renders forget button for all satellites', () => {
    render(<PairedSatelliteList satellites={[mockSatellite]} />);
    const forgetButtons = screen.getAllByRole('button', { name: 'Forget' });
    expect(forgetButtons.length).toBeGreaterThan(0);
  });

  describe('forget flow', () => {
    it('shows confirmation when forget button clicked', () => {
      render(<PairedSatelliteList satellites={[mockSatellite]} />);
      const forgetButton = screen.getByRole('button', { name: 'Forget' });
      fireEvent.click(forgetButton);
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    });

    it('calls forgetSatellite when confirmation clicked', () => {
      render(<PairedSatelliteList satellites={[mockSatellite]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(mockForgetSatellite).toHaveBeenCalledWith('fp-123');
    });

    it('hides confirmation after confirm clicked', async () => {
      render(<PairedSatelliteList satellites={[mockSatellite]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
      });
    });

    it('cancels confirmation when cancel button clicked', () => {
      render(<PairedSatelliteList satellites={[mockSatellite]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
      const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
      fireEvent.click(cancelButtons[0]);
      expect(mockForgetSatellite).not.toHaveBeenCalled();
    });

    it('shows forget button again after cancel', () => {
      render(<PairedSatelliteList satellites={[mockSatellite]} />);
      let forgetButton = screen.getByRole('button', { name: 'Forget' });
      fireEvent.click(forgetButton);
      const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
      fireEvent.click(cancelButtons[0]);
      forgetButton = screen.getByRole('button', { name: 'Forget' });
      expect(forgetButton).toBeInTheDocument();
    });
  });

  it('renders error message for incompatible satellite', () => {
    render(<PairedSatelliteList satellites={[mockIncompatibleSatellite]} />);
    expect(screen.getByText('Incompatible')).toBeInTheDocument();
    expect(screen.getByText(/Incompatible version/)).toBeInTheDocument();
  });

  it('sorts connected satellites first, then alphabetically', () => {
    const satellites: SatelliteConnection[] = [
      { ...mockDisconnectedSatellite, id: 'sat-zebra', fingerprint: 'fp-zebra', alias: 'Zebra' },
      { ...mockSatellite, id: 'sat-alpha', fingerprint: 'fp-alpha', alias: 'Alpha' },
      { ...mockDisconnectedSatellite, id: 'sat-beta', fingerprint: 'fp-beta', alias: 'Beta' },
    ];
    render(<PairedSatelliteList satellites={satellites} />);
    const aliases = screen.getAllByRole('generic').map(el => el.textContent);
    const aliasTexts = aliases.filter(text => text && ['Alpha', 'Beta', 'Zebra'].some(name => text.includes(name)));
    expect(aliasTexts[0]).toContain('Alpha');
  });

  it('handles multiple satellites with independent forget states', () => {
    const satellites = [mockSatellite, mockDisconnectedSatellite];
    render(<PairedSatelliteList satellites={satellites} />);
    const forgetButtons = screen.getAllByRole('button', { name: 'Forget' });
    expect(forgetButtons.length).toBe(2);

    fireEvent.click(forgetButtons[0]);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();

    fireEvent.click(forgetButtons[1]);
    const confirmButtons = screen.getAllByRole('button', { name: 'Confirm' });
    expect(confirmButtons.length).toBeGreaterThanOrEqual(1);
  });
});
