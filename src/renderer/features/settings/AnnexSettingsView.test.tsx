import { render, screen, fireEvent } from '@testing-library/react';
import { AnnexSettingsView } from './AnnexSettingsView';
import { useAnnexStore } from '../../stores/annexStore';

const mockSaveSettings = vi.fn();
const mockLoadSettings = vi.fn();
const mockRegeneratePin = vi.fn();

function resetStores() {
  useAnnexStore.setState({
    settings: { enabled: false, deviceName: 'My Mac' },
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
    expect(screen.getByText('Annex Server')).toBeInTheDocument();
  });

  it('calls loadSettings on mount', () => {
    render(<AnnexSettingsView />);
    expect(mockLoadSettings).toHaveBeenCalled();
  });

  it('shows enable toggle in disabled state', () => {
    render(<AnnexSettingsView />);
    expect(screen.getByText('Enable Annex server')).toBeInTheDocument();
  });

  it('hides server details when disabled', () => {
    render(<AnnexSettingsView />);
    expect(screen.queryByText('Pairing PIN')).not.toBeInTheDocument();
    expect(screen.queryByText('Connected devices')).not.toBeInTheDocument();
  });

  it('shows server details when enabled', () => {
    useAnnexStore.setState({
      settings: { enabled: true, deviceName: 'My Mac' },
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
      settings: { enabled: true, deviceName: '' },
      status: { advertising: true, port: 8080, pin: '', connectedCount: 1 },
    });

    render(<AnnexSettingsView />);
    expect(screen.getByText('1 device connected')).toBeInTheDocument();
  });

  it('shows "No devices connected" for 0 connections', () => {
    useAnnexStore.setState({
      settings: { enabled: true, deviceName: '' },
      status: { advertising: true, port: 8080, pin: '', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    expect(screen.getByText('No devices connected')).toBeInTheDocument();
  });

  it('shows placeholder PIN when none set', () => {
    useAnnexStore.setState({
      settings: { enabled: true, deviceName: '' },
      status: { advertising: false, port: 0, pin: '', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    expect(screen.getByText('------')).toBeInTheDocument();
  });

  it('calls regeneratePin when button clicked', () => {
    useAnnexStore.setState({
      settings: { enabled: true, deviceName: '' },
      status: { advertising: true, port: 8080, pin: '5678', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    fireEvent.click(screen.getByText('Regenerate'));
    expect(mockRegeneratePin).toHaveBeenCalled();
  });

  it('updates device name on input change', () => {
    useAnnexStore.setState({
      settings: { enabled: true, deviceName: 'Old Name' },
      status: { advertising: true, port: 8080, pin: '', connectedCount: 0 },
    });

    render(<AnnexSettingsView />);
    const input = screen.getByDisplayValue('Old Name');
    fireEvent.change(input, { target: { value: 'New Name' } });
    expect(mockSaveSettings).toHaveBeenCalledWith({ enabled: true, deviceName: 'New Name' });
  });
});
