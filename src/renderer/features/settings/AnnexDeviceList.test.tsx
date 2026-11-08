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
const renameDevice = vi.fn();

function device(overrides: Partial<AnnexDevice>): AnnexDevice {
  return {
    fingerprint: 'fp-1', alias: 'Studio', icon: 'computer', color: 'indigo', role: 'member', kind: 'desktop',
    state: 'connected', pairedAt: '2026-11-01T00:00:00Z', lastSeen: '', problem: null, ...overrides,
  };
}

describe('AnnexDeviceList (#3067)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(screen.getByText('Paired one-to-one: this computer controls it')).toBeInTheDocument();
    expect(screen.getByText('Paired one-to-one: it controls this computer')).toBeInTheDocument();
  });

  it('offers Disconnect for a connected computer, Reconnect for an offline one, and neither for a phone or a controller', () => {
    render(<AnnexDeviceList devices={[device({ fingerprint: 'on' }), device({ fingerprint: 'off', alias: 'Laptop', state: 'offline' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(disconnect).toHaveBeenCalledWith('on');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(retry).toHaveBeenCalledWith('off');
  });

  it('never offers connection controls or an address for a device that connects to this computer', () => {
    render(<AnnexDeviceList devices={[device({ kind: 'phone', state: 'offline' }), device({ fingerprint: 'c', role: 'controller', state: 'offline' })]} />);
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Address' })).not.toBeInTheDocument();
  });

  it('renames a member everywhere', async () => {
    render(<AnnexDeviceList devices={[device({})]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name for Studio' }), { target: { value: 'Studio Pro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(renameDevice).toHaveBeenCalledWith('fp-1', 'Studio Pro'));
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
