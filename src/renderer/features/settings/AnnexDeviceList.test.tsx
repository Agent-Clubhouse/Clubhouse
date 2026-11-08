import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AnnexDeviceList } from './AnnexDeviceList';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useAnnexStore } from '../../stores/annexStore';
import type { AnnexDevice } from '../../../shared/types';
import { describeAnnexProblem } from '../../../shared/annex-problems';

const NOW = new Date('2026-11-08T12:00:00Z').getTime();
const disconnect = vi.fn();
const retry = vi.fn();
const removeDevice = vi.fn();
const renameDevice = vi.fn().mockResolvedValue(true);

function device(overrides: Partial<AnnexDevice>): AnnexDevice {
  return {
    fingerprint: 'fp-1', alias: 'Studio', icon: 'computer', color: 'indigo', role: 'member', kind: 'desktop',
    state: 'connected', pairedAt: '2026-11-01T00:00:00Z', lastSeen: '', problem: null, ...overrides,
  };
}

describe('AnnexDeviceList (#3067)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renameDevice.mockResolvedValue(true);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    useAnnexClientStore.setState({ disconnect, retry } as never);
    useAnnexStore.setState({ removeDevice, renameDevice } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists every device whichever way it is paired, connected first, saying how each relates to this computer', () => {
    render(<AnnexDeviceList devices={[
      device({ fingerprint: 'a', alias: 'Zed', state: 'offline', lastSeen: new Date(NOW - 5 * 60_000).toISOString() }),
      device({ fingerprint: 'b', alias: 'Phone', kind: 'phone' }),
      device({ fingerprint: 'c', alias: 'Old Mac', role: 'satellite', state: 'offline' }),
      device({ fingerprint: 'd', alias: 'Pad', role: 'controller', state: 'offline' }),
    ]} />);
    const rows = screen.getAllByTestId('annex-device-row');
    expect(rows[0]).toHaveTextContent('Phone');
    expect(rows[0]).toHaveTextContent('Phone in this network');
    expect(screen.getByText('Offline, last seen 5m ago')).toBeInTheDocument();
    expect(screen.getByText('Paired one-to-one, and this computer controls it')).toBeInTheDocument();
    expect(screen.getByText('Paired one-to-one, and it controls this computer')).toBeInTheDocument();
  });

  it('offers Disconnect for a connected satellite, Reconnect for an offline computer, and no Disconnect for a member', () => {
    render(<AnnexDeviceList devices={[
      device({ fingerprint: 'sat', alias: 'Mini', role: 'satellite' }),
      device({ fingerprint: 'member', alias: 'Studio' }),
      device({ fingerprint: 'off', alias: 'Laptop', state: 'offline' }),
    ]} />);
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(disconnect).toHaveBeenCalledWith('sat');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(retry).toHaveBeenCalledWith('off');
  });

  it('offers no Reconnect while this computer is not connecting to others', () => {
    render(<AnnexDeviceList canConnect={false} devices={[device({ state: 'offline' })]} />);
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('never offers connection controls, an address or Pair again for a device that connects to this computer', () => {
    const onPairAgain = vi.fn();
    render(<AnnexDeviceList onPairAgain={onPairAgain} devices={[
      device({ fingerprint: 'p1', kind: 'phone', state: 'offline' }),
      device({ fingerprint: 'p2', kind: 'phone' }),
      device({ fingerprint: 'c1', role: 'controller', state: 'offline' }),
      device({ fingerprint: 'c2', role: 'controller' }),
      device({ fingerprint: 'c3', role: 'controller', state: 'needs-pairing' }),
    ]} />);
    for (const name of ['Reconnect', 'Disconnect', 'Address', 'Pair again']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('offers Pair again for an older entry with no role', () => {
    const onPairAgain = vi.fn();
    render(<AnnexDeviceList onPairAgain={onPairAgain} devices={[device({ role: undefined, kind: undefined, state: 'needs-pairing' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
    expect(onPairAgain).toHaveBeenCalled();
  });

  it('shows a typed address before the device has been reached', () => {
    render(<AnnexDeviceList devices={[device({ state: 'offline', typedHost: 'studio.tail1234.ts.net' })]} />);
    expect(screen.getByTestId('annex-device-address')).toHaveTextContent('at studio.tail1234.ts.net');
  });

  it('renames a member everywhere', async () => {
    render(<AnnexDeviceList devices={[device({})]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name for Studio' }), { target: { value: 'Studio Pro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(renameDevice).toHaveBeenCalledWith('fp-1', 'Studio Pro'));
    await waitFor(() => expect(screen.queryByTestId('annex-rename-editor')).not.toBeInTheDocument());
  });

  it('keeps the editor open with a reason when a rename is refused', async () => {
    renameDevice.mockResolvedValueOnce(false);
    render(<AnnexDeviceList devices={[device({})]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name for Studio' }), { target: { value: 'Studio Pro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Couldn.t rename it/)).toBeInTheDocument();
    expect(screen.getByTestId('annex-rename-editor')).toBeInTheDocument();
  });

  it('offers no rename for a one-to-one pairing', () => {
    render(<AnnexDeviceList devices={[device({ role: 'satellite' })]} />);
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });

  it('removes after confirming, saying a member goes from every device', () => {
    render(<AnnexDeviceList devices={[device({})]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/removed from every device in this network/)).toBeInTheDocument();
    expect(removeDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(removeDevice).toHaveBeenCalledWith('fp-1');
  });

  it('offers Pair again for a computer that needs it, and says why it isn\'t connected', () => {
    const onPairAgain = vi.fn();
    const needs = device({ state: 'needs-pairing', problem: describeAnnexProblem('removed-there', 'Studio') });
    render(<AnnexDeviceList devices={[needs]} onPairAgain={onPairAgain} />);
    expect(screen.getByTestId('annex-device-problem')).toHaveTextContent('This computer is no longer paired on Studio. Pair again to connect.');
    fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
    expect(onPairAgain).toHaveBeenCalledWith(needs);
  });

  it('shows where a join is confirmed, and a removal in progress with no actions', () => {
    render(<AnnexDeviceList devices={[
      device({ confirmation: { kind: 'join', confirmedBy: ['Laptop'], waitingOn: ['Mini'] } }),
      device({ fingerprint: 'gone', alias: 'Old', state: 'removing', confirmation: { kind: 'removal', confirmedBy: [], waitingOn: ['Laptop'] } }),
    ]} />);
    const [joined, removing] = screen.getAllByTestId('annex-device-confirmation');
    expect(joined).toHaveTextContent('Confirmed on Laptop. Waiting for Mini, which hears when next connected.');
    expect(removing).toHaveTextContent('Not confirmed on any other device yet.');
    const removingRow = screen.getAllByTestId('annex-device-row').find((r) => r.getAttribute('data-state') === 'removing')!;
    expect(removingRow.querySelectorAll('button')).toHaveLength(0);
  });

  it('sets a typed address, keeping the editor open with the reason when it is refused', async () => {
    const setSatelliteHost = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Type a name or address.' }).mockResolvedValueOnce({ ok: true });
    Object.assign(window.clubhouse.annexClient, { setSatelliteHost });
    render(<AnnexDeviceList devices={[device({ state: 'offline' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
    const input = screen.getByRole('textbox', { name: 'Address for Studio' });
    fireEvent.change(input, { target: { value: 'https://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Type a name or address.')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'studio.tail1234.ts.net' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('annex-address-editor')).not.toBeInTheDocument());
    expect(setSatelliteHost).toHaveBeenLastCalledWith('fp-1', 'studio.tail1234.ts.net');
  });
});
