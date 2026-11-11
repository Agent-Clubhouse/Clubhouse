import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AnnexNetworkSettingsView } from './AnnexNetworkSettingsView';
import { useAnnexStore } from '../../stores/annexStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';

const saveSettings = vi.fn();
const regeneratePin = vi.fn();
const allowPairingAgain = vi.fn();
const purgeServerConfig = vi.fn();

const OFF = { enableServer: false, enableClient: false, deviceName: 'Studio Mac', alias: 'Studio', icon: 'computer', color: 'indigo', autoReconnect: true };
const ON = { ...OFF, enableServer: true, enableClient: true };
const STATUS = {
  advertising: true, port: 7432, pin: '123456', connectedCount: 1, fingerprint: 'aa', alias: 'Studio', icon: 'computer', color: 'indigo',
  pairingUrl: 'clubhousego://pair?v=1&host=192.168.1.9&port=7432', pairingHosts: ['192.168.1.9'], tlsCertificateFingerprint: Array(32).fill('AB').join(':'),
};

function setup(settings: object, extra: object = {}) {
  useAnnexStore.setState({
    settings, status: STATUS, devices: [], saveSettings, regeneratePin, allowPairingAgain, purgeServerConfig,
    loadSettings: vi.fn(), loadStatus: vi.fn(), loadDevices: vi.fn(), ...extra,
  } as never);
  useAnnexClientStore.setState({ loadSatellites: vi.fn(), scan: vi.fn(), discoveredServices: [], getDiscovered: vi.fn().mockResolvedValue([]), loadDiscovered: vi.fn() } as never);
}

describe('AnnexNetworkSettingsView (#3067)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is one page with a switch at the top, and only devices and reset while off', () => {
    setup(OFF);
    render(<AnnexNetworkSettingsView />);
    expect(screen.getByText('Annex Network')).toBeInTheDocument();
    expect(screen.getByText('Devices')).toBeInTheDocument();
    expect(screen.queryByText('Add a device')).not.toBeInTheDocument();
    expect(screen.queryByText('This computer')).not.toBeInTheDocument();
  });

  it('turns everything on together, joining new pairings to the network, and off together', async () => {
    setup(OFF);
    const { unmount } = render(<AnnexNetworkSettingsView />);
    fireEvent.click(screen.getByTestId('annex-network-toggle').querySelector('button')!);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ enableServer: true, enableClient: true, networkEnabled: true })));
    unmount();
    setup(ON);
    render(<AnnexNetworkSettingsView />);
    fireEvent.click(screen.getByTestId('annex-network-toggle').querySelector('button')!);
    await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ enableServer: false, enableClient: false })));
  });

  it('builds on the saved settings, so a click before they load keeps the names', async () => {
    window.clubhouse.annex.getSettings = vi.fn().mockResolvedValue({ ...OFF, deviceName: 'Saved Mac', alias: 'Saved' });
    setup({ ...OFF, deviceName: '', alias: '' });
    render(<AnnexNetworkSettingsView />);
    fireEvent.click(screen.getByTestId('annex-network-toggle').querySelector('button')!);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ deviceName: 'Saved Mac', alias: 'Saved', enableServer: true })));
  });

  it('shows as on, with its tools, while only one half runs (an older phone setup)', () => {
    setup({ ...OFF, enableServer: true });
    render(<AnnexNetworkSettingsView />);
    expect(screen.getByRole('switch', { name: 'Annex Network on this computer' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Add a device')).toBeInTheDocument();
    expect(screen.getByTestId('annex-pairing-code')).toBeInTheDocument();
  });

  it('opens Pair again by the device, and offers it only while this computer connects to others', () => {
    const needs = { fingerprint: 'm', alias: 'Laptop', icon: 'computer', color: 'indigo', role: 'member', kind: 'desktop', state: 'needs-pairing', pairedAt: '', lastSeen: '', problem: null };
    setup(ON, { devices: [needs] });
    const { unmount } = render(<AnnexNetworkSettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
    expect(screen.getByTestId('pairing-wizard')).toBeInTheDocument();
    unmount();
    setup(OFF, { devices: [needs] });
    render(<AnnexNetworkSettingsView />);
    expect(screen.queryByRole('button', { name: 'Pair again' })).not.toBeInTheDocument();
  });

  it('adds a device by code, link and QR, and pairs with another computer', () => {
    setup(ON);
    render(<AnnexNetworkSettingsView />);
    expect(screen.getByTestId('annex-pairing-code')).toHaveTextContent('123456');
    expect(screen.getByTestId('annex-pairing-link')).toHaveTextContent('clubhousego://pair');
    const fingerprint = screen.getByLabelText('Certificate fingerprint') as HTMLInputElement;
    expect(fingerprint).toHaveValue(STATUS.tlsCertificateFingerprint);
    fireEvent.focus(fingerprint);
    expect(fingerprint.selectionEnd! - fingerprint.selectionStart!).toBe(STATUS.tlsCertificateFingerprint.length);
    fireEvent.click(screen.getByRole('button', { name: 'New code' }));
    expect(regeneratePin).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pair with another computer' }));
    expect(screen.getByTestId('pairing-wizard')).toBeInTheDocument();
  });

  it('offers to allow pairing again only while it is paused', () => {
    setup(ON, { status: { ...STATUS, pairingPaused: true } });
    render(<AnnexNetworkSettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow pairing again' }));
    expect(allowPairingAgain).toHaveBeenCalled();
  });

  it('shows this computer: name, where it is reachable, the name it is also reachable at, and its certificate code', () => {
    setup(ON);
    render(<AnnexNetworkSettingsView />);
    expect(screen.getByTestId('annex-reachable-hosts')).toHaveTextContent('192.168.1.9');
    fireEvent.change(screen.getByLabelText('Also reachable at'), { target: { value: 'studio.tail1234.ts.net' } });
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ reachableAs: 'studio.tail1234.ts.net' }));
    expect(screen.getByTestId('annex-certificate-code')).toBeInTheDocument();
  });

  it('lists every device, whichever way it is paired', () => {
    setup(ON, { devices: [
      { fingerprint: 'm', alias: 'Laptop', icon: 'computer', color: 'indigo', role: 'member', kind: 'desktop', state: 'connected', pairedAt: '', lastSeen: '', problem: null },
      { fingerprint: 'p', alias: 'Phone', icon: 'iphone', color: 'indigo', role: 'controller', state: 'offline', pairedAt: '', lastSeen: '', problem: null },
    ] });
    render(<AnnexNetworkSettingsView />);
    expect(screen.getAllByTestId('annex-device-row')).toHaveLength(2);
  });

  it('resets after confirming', () => {
    setup(ON);
    render(<AnnexNetworkSettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    expect(purgeServerConfig).toHaveBeenCalled();
  });
});
