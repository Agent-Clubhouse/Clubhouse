import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AnnexPairedDevices } from './AnnexPairedDevices';
import { useAnnexStore } from '../../stores/annexStore';
import type { AnnexPeerListing } from '../../../shared/types';

const NOW = new Date('2026-11-07T12:00:00Z').getTime();

function peer(overrides: Partial<AnnexPeerListing>): AnnexPeerListing {
  return {
    fingerprint: 'fp-phone',
    publicKey: 'pk',
    alias: 'Test iPhone',
    icon: 'phone',
    color: 'indigo',
    pairedAt: '2026-11-01T09:00:00Z',
    lastSeen: new Date(NOW - 5 * 60_000).toISOString(),
    role: 'controller',
    needsPairing: false,
    ...overrides,
  };
}

describe('AnnexPairedDevices', () => {
  const listPeers = vi.fn();
  const removePeer = vi.fn();
  let peersChanged: ((peers: AnnexPeerListing[]) => void) | null = null;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    peersChanged = null;
    listPeers.mockResolvedValue([]);
    removePeer.mockResolvedValue(true);
    Object.assign(window.clubhouse.annex, {
      listPeers,
      removePeer,
      onPeersChanged: (cb: (peers: AnnexPeerListing[]) => void) => { peersChanged = cb; return unsubscribe; },
    });
    useAnnexStore.setState({ peers: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads peers and lists phones and controlling computers only', async () => {
    listPeers.mockResolvedValueOnce([
      peer({}),
      peer({ fingerprint: 'fp-old', alias: 'Old Laptop', role: undefined }),
      peer({ fingerprint: 'fp-sat', alias: 'Satellite Mac', role: 'satellite' }),
    ]);
    render(<AnnexPairedDevices />);
    expect(await screen.findByText('Test iPhone')).toBeInTheDocument();
    expect(screen.getByText('Old Laptop')).toBeInTheDocument();
    expect(screen.queryByText('Satellite Mac')).not.toBeInTheDocument();
  });

  it('shows when each device was paired and last seen', async () => {
    listPeers.mockResolvedValueOnce([peer({})]);
    render(<AnnexPairedDevices />);
    const pairedDate = new Date('2026-11-01T09:00:00Z').toLocaleDateString();
    expect(await screen.findByText(`Paired ${pairedDate} · Last seen 5m ago`)).toBeInTheDocument();
  });

  it('marks a device that needs pairing again in plain text', async () => {
    listPeers.mockResolvedValueOnce([peer({ needsPairing: true })]);
    render(<AnnexPairedDevices />);
    expect(await screen.findByText('Needs pairing again')).toBeInTheDocument();
  });

  it('shows one quiet line when nothing is paired', async () => {
    render(<AnnexPairedDevices />);
    await waitFor(() => expect(listPeers).toHaveBeenCalled());
    expect(screen.getByText('No devices paired yet.')).toBeInTheDocument();
  });

  it('renders nothing when empty and asked to stay hidden', async () => {
    const { container } = render(<AnnexPairedDevices showWhenEmpty={false} />);
    await waitFor(() => expect(listPeers).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps fresh from onPeersChanged and unsubscribes on unmount', async () => {
    const { unmount } = render(<AnnexPairedDevices />);
    await waitFor(() => expect(peersChanged).not.toBeNull());
    act(() => peersChanged!([peer({ alias: 'New Phone' })]));
    expect(screen.getByText('New Phone')).toBeInTheDocument();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('removes a device after confirming', async () => {
    listPeers.mockResolvedValueOnce([peer({})]);
    render(<AnnexPairedDevices />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(removePeer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(removePeer).toHaveBeenCalledWith('fp-phone');
    await waitFor(() => expect(screen.queryByText('Test iPhone')).not.toBeInTheDocument());
  });

  it('keeps the device when the removal is cancelled', async () => {
    listPeers.mockResolvedValueOnce([peer({})]);
    render(<AnnexPairedDevices />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removePeer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });
});
