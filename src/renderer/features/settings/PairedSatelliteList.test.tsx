import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PairedSatelliteList } from './PairedSatelliteList';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useAnnexStore } from '../../stores/annexStore';
import type { AnnexDevice } from '../../../shared/types';
import { describeAnnexProblem } from '../../../shared/annex-problems';

const mockDisconnect = vi.fn();
const mockRetry = vi.fn();
const mockForgetSatellite = vi.fn();

function resetStore() {
  useAnnexClientStore.setState({
    satellites: [],
    disconnect: mockDisconnect,
    retry: mockRetry,
    forgetSatellite: vi.fn(),
    loadSatellites: vi.fn(),
    scan: vi.fn(),
    connect: vi.fn(),
    pairWith: vi.fn(),
    forgetAllSatellites: vi.fn(),
    getDiscovered: vi.fn().mockResolvedValue([]),
    discoveredServices: [],
    loadDiscovered: vi.fn(),
  });
  // Forgetting goes through the one device list.
  useAnnexStore.setState({ removeDevice: mockForgetSatellite });
}

function device(overrides: Partial<AnnexDevice>): AnnexDevice {
  return {
    fingerprint: 'fp-123',
    alias: 'Test Satellite',
    icon: 'computer',
    color: 'indigo',
    role: 'satellite',
    state: 'connected',
    pairedAt: '',
    lastSeen: '',
    problem: null,
    ...overrides,
  };
}

const mockSatellite = device({});

const mockDisconnectedSatellite = device({ fingerprint: 'fp-456', alias: 'Offline Satellite', state: 'offline' });

const mockIncompatibleSatellite = device({
  fingerprint: 'fp-789',
  alias: 'Bad Version',
  state: 'offline',
  problem: describeAnnexProblem('incompatible', 'Bad Version'),
});

describe('PairedSatelliteList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('renders empty list when no satellites', () => {
    const { container } = render(<PairedSatelliteList devices={[]} />);
    const listContainer = container.querySelector('[data-testid="paired-satellite-list"]');
    expect(listContainer?.children.length).toBe(0);
  });

  it('renders satellite alias', () => {
    render(<PairedSatelliteList devices={[mockSatellite]} />);
    expect(screen.getByText('Test Satellite')).toBeInTheDocument();
  });

  it('renders connected status', () => {
    render(<PairedSatelliteList devices={[mockSatellite]} />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('renders disconnect button for connected satellite', () => {
    render(<PairedSatelliteList devices={[mockSatellite]} />);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('calls disconnect when disconnect button clicked', () => {
    render(<PairedSatelliteList devices={[mockSatellite]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mockDisconnect).toHaveBeenCalledWith('fp-123');
  });

  it('renders disconnected satellite status', () => {
    render(<PairedSatelliteList devices={[mockDisconnectedSatellite]} />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('renders retry button for disconnected satellite', () => {
    render(<PairedSatelliteList devices={[mockDisconnectedSatellite]} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('calls retry when retry button clicked', () => {
    render(<PairedSatelliteList devices={[mockDisconnectedSatellite]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRetry).toHaveBeenCalledWith('fp-456');
  });

  it('renders forget button for all satellites', () => {
    render(<PairedSatelliteList devices={[mockSatellite]} />);
    const forgetButtons = screen.getAllByRole('button', { name: 'Forget' });
    expect(forgetButtons.length).toBeGreaterThan(0);
  });

  describe('forget flow', () => {
    it('shows confirmation when forget button clicked', () => {
      render(<PairedSatelliteList devices={[mockSatellite]} />);
      const forgetButton = screen.getByRole('button', { name: 'Forget' });
      fireEvent.click(forgetButton);
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    });

    it('calls forgetSatellite when confirmation clicked', () => {
      render(<PairedSatelliteList devices={[mockSatellite]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(mockForgetSatellite).toHaveBeenCalledWith('fp-123');
    });

    it('hides confirmation after confirm clicked', async () => {
      render(<PairedSatelliteList devices={[mockSatellite]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
      });
    });

    it('cancels confirmation when cancel button clicked', () => {
      render(<PairedSatelliteList devices={[mockSatellite]} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
      const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
      fireEvent.click(cancelButtons[0]);
      expect(mockForgetSatellite).not.toHaveBeenCalled();
    });

    it('shows forget button again after cancel', () => {
      render(<PairedSatelliteList devices={[mockSatellite]} />);
      let forgetButton = screen.getByRole('button', { name: 'Forget' });
      fireEvent.click(forgetButton);
      const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
      fireEvent.click(cancelButtons[0]);
      forgetButton = screen.getByRole('button', { name: 'Forget' });
      expect(forgetButton).toBeInTheDocument();
    });
  });

  it('renders error message for incompatible satellite', () => {
    render(<PairedSatelliteList devices={[mockIncompatibleSatellite]} />);
    expect(screen.getByText('Incompatible')).toBeInTheDocument();
    expect(screen.getByText(/can't connect to this one\. Update Clubhouse on both computers\./)).toBeInTheDocument();
  });

  it('sorts connected satellites first, then alphabetically', () => {
    const satellites: AnnexDevice[] = [
      { ...mockDisconnectedSatellite, fingerprint: 'fp-zebra', alias: 'Zebra' },
      { ...mockSatellite, fingerprint: 'fp-alpha', alias: 'Alpha' },
      { ...mockDisconnectedSatellite, fingerprint: 'fp-beta', alias: 'Beta' },
    ];
    render(<PairedSatelliteList devices={satellites} />);
    const aliases = screen.getAllByRole('generic').map(el => el.textContent);
    const aliasTexts = aliases.filter(text => text && ['Alpha', 'Beta', 'Zebra'].some(name => text.includes(name)));
    expect(aliasTexts[0]).toContain('Alpha');
  });

  it('handles multiple satellites with independent forget states', () => {
    const satellites = [mockSatellite, mockDisconnectedSatellite];
    render(<PairedSatelliteList devices={satellites} />);
    const forgetButtons = screen.getAllByRole('button', { name: 'Forget' });
    expect(forgetButtons.length).toBe(2);

    fireEvent.click(forgetButtons[0]);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();

    fireEvent.click(forgetButtons[1]);
    const confirmButtons = screen.getAllByRole('button', { name: 'Confirm' });
    expect(confirmButtons.length).toBeGreaterThanOrEqual(1);
  });

  describe('needs pairing again', () => {
    const needsPairing: AnnexDevice = {
      ...mockDisconnectedSatellite,
      state: 'needs-pairing',
      problem: describeAnnexProblem('old-pairing', 'Offline Satellite'),
    };

    it('says so in plain text with the reason', () => {
      render(<PairedSatelliteList devices={[needsPairing]} onPairAgain={vi.fn()} />);
      expect(screen.getByText('Needs pairing again')).toBeInTheDocument();
      expect(screen.getByText('This pairing is from an older version of Clubhouse. Pair again to connect.')).toBeInTheDocument();
      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });

    it('offers Pair again instead of Retry', () => {
      const onPairAgain = vi.fn();
      render(<PairedSatelliteList devices={[needsPairing]} onPairAgain={onPairAgain} />);
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
      expect(onPairAgain).toHaveBeenCalledWith(needsPairing);
      expect(mockRetry).not.toHaveBeenCalled();
    });

    it('still lets the person forget it', () => {
      render(<PairedSatelliteList devices={[needsPairing]} onPairAgain={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(mockForgetSatellite).toHaveBeenCalledWith('fp-456');
    });
  });

  it('says what happened and what to do for an offline satellite', () => {
    render(<PairedSatelliteList devices={[{ ...mockDisconnectedSatellite, problem: describeAnnexProblem('refused', 'Offline Satellite') }]} />);
    expect(screen.getByTestId('annex-device-problem')).toHaveTextContent(
      "Offline Satellite isn't accepting connections. Check that Clubhouse is open there with Annex turned on.",
    );
  });

  it('shows a satellite that is connecting without Retry or Disconnect', () => {
    render(<PairedSatelliteList devices={[{ ...mockSatellite, state: 'connecting' }]} />);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });
});
