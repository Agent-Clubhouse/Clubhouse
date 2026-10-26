import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AnnexSettingsView } from './AnnexSettingsView';
import { useAnnexStore } from '../../stores/annexStore';

const mockSaveSettings = vi.fn();
const mockLoadSettings = vi.fn();
const mockRegeneratePin = vi.fn();

function resetStores() {
  useAnnexStore.setState({
    settings: { enableServer: false, enableClient: false, deviceName: 'My Mac' },
    status: { advertising: false, port: 0, pin: '', connectedCount: 0 },
    saveSettings: mockSaveSettings,
    loadSettings: mockLoadSettings,
    regeneratePin: mockRegeneratePin,
    loadStatus: vi.fn(),
  });
}

describe('AnnexSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<AnnexSettingsView />);
    expect(screen.getByText('Annex')).toBeInTheDocument();
  });

  it('calls loadSettings on mount', () => {
    render(<AnnexSettingsView />);
    expect(mockLoadSettings).toHaveBeenCalled();
  });

  it('shows server toggle', () => {
    render(<AnnexSettingsView />);
    expect(screen.getByText('Allow remote control')).toBeInTheDocument();
  });

  it('hides server details when enableServer is false', () => {
    render(<AnnexSettingsView />);
    expect(screen.queryByText('Pairing PIN')).not.toBeInTheDocument();
    expect(screen.queryByText('Connected devices')).not.toBeInTheDocument();
  });

  it('shows server details when enabled', () => {
    useAnnexStore.setState({
      settings: { enableServer: true, enableClient: false, deviceName: 'My Mac' },
      status: { advertising: true, port: 8080, pin: '1234', connectedCount: 2 },
    });

    render(<AnnexSettingsView />);
    expect(screen.getByText('Pairing PIN')).toBeInTheDocument();
    expect(screen.getByText('1234')).toBeInTheDocument();
    expect(screen.getByText('2 devices connected')).toBeInTheDocument();
    expect(screen.getByText(/Advertising on port 8080/)).toBeInTheDocument();
  });

  it('shows singular device text for 1 connection', () => {
    useAnnexStore.setState({
      settings: { enableServer: true, enableClient: false, deviceName: '' },
      status: { advertising: true, port: 8080, pin: '', connectedCount: 1 },
    });

    render(<AnnexSettingsView />);
    expect(screen.getByText('1 device connected')).toBeInTheDocument();
  });

  it('shows "No devices connected" for 0 connections', () => {
    useAnnexStore.setState({
      settings: { enableServer: true, enableClient: false, deviceName: '' },
      status: { advertising: true, port: 8080, pin: '', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    expect(screen.getByText('No devices connected')).toBeInTheDocument();
  });

  it('shows placeholder PIN when none set', () => {
    useAnnexStore.setState({
      settings: { enableServer: true, enableClient: false, deviceName: '' },
      status: { advertising: false, port: 0, pin: '', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    expect(screen.getByText('------')).toBeInTheDocument();
  });

  it('calls regeneratePin when button clicked', () => {
    useAnnexStore.setState({
      settings: { enableServer: true, enableClient: false, deviceName: '' },
      status: { advertising: true, port: 8080, pin: '5678', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    fireEvent.click(screen.getByText('Regenerate'));
    expect(mockRegeneratePin).toHaveBeenCalled();
  });

  it('updates device name on input change', () => {
    useAnnexStore.setState({
      settings: { enableServer: true, enableClient: false, deviceName: 'Old Name' },
      status: { advertising: true, port: 8080, pin: '', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    const input = screen.getByDisplayValue('Old Name');
    fireEvent.change(input, { target: { value: 'New Name' } });
    expect(mockSaveSettings).toHaveBeenCalledWith({ enableServer: true, enableClient: false, deviceName: 'New Name' });
  });
  describe('Pair a phone', () => {
    const pairingUrl = 'clubhousego://pair?v=1&host=192.168.1.20&port=53123&id=AA&cert=' + 'ab'.repeat(32) + '&pin=042917&name=Mac';

    it('stays hidden until the status carries a pairing link', () => {
      useAnnexStore.setState({
        settings: { enableServer: true, enableClient: false, deviceName: '' },
        status: { advertising: true, port: 53123, pin: '042917', connectedCount: 0 },
      });
      render(<AnnexSettingsView />);
      expect(screen.queryByText('Pair a phone')).not.toBeInTheDocument();
    });

    it('shows the QR code, its copy and the primary address', async () => {
      useAnnexStore.setState({
        settings: { enableServer: true, enableClient: false, deviceName: '' },
        status: { advertising: true, port: 53123, pin: '042917', connectedCount: 0, pairingUrl, pairingHosts: ['192.168.1.20', '100.64.0.2'] },
      });
      render(<AnnexSettingsView />);
      expect(screen.getByText('Pair a phone')).toBeInTheDocument();
      expect(screen.getByText(/Scan with Clubhouse Go, or with the iPhone Camera/)).toBeInTheDocument();
      expect(screen.getByText('192.168.1.20 · port 53123')).toBeInTheDocument();
      const img = await screen.findByAltText('QR code for pairing Clubhouse Go with this machine');
      expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    });

    it('redraws the code when the link changes (a new PIN)', async () => {
      useAnnexStore.setState({
        settings: { enableServer: true, enableClient: false, deviceName: '' },
        status: { advertising: true, port: 53123, pin: '042917', connectedCount: 0, pairingUrl, pairingHosts: ['192.168.1.20'] },
      });
      render(<AnnexSettingsView />);
      const alt = 'QR code for pairing Clubhouse Go with this machine';
      const first = (await screen.findByAltText(alt)).getAttribute('src');
      useAnnexStore.setState({
        status: { advertising: true, port: 53123, pin: '771204', connectedCount: 0, pairingUrl: pairingUrl.replace('042917', '771204'), pairingHosts: ['192.168.1.20'] },
      });
      await waitFor(() => expect(screen.getByAltText(alt).getAttribute('src')).not.toBe(first));
    });
  });
});
