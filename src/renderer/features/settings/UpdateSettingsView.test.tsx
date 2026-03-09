import { render, screen, fireEvent } from '@testing-library/react';
import { UpdateSettingsView } from './UpdateSettingsView';
import { useUpdateStore } from '../../stores/updateStore';

const mockSaveSettings = vi.fn();
const mockCheckForUpdates = vi.fn();
const mockOpenUpdateDownload = vi.fn();

function resetStores(overrides: Record<string, any> = {}) {
  useUpdateStore.setState({
    settings: { autoUpdate: true, previewChannel: false, lastCheck: null },
    status: { state: 'idle', availableVersion: null, downloadProgress: 0, error: null, artifactUrl: null },
    saveSettings: mockSaveSettings,
    checkForUpdates: mockCheckForUpdates,
    openUpdateDownload: mockOpenUpdateDownload,
    ...overrides,
  });
}

describe('UpdateSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<UpdateSettingsView />);
    expect(screen.getByText('Updates')).toBeInTheDocument();
  });

  it('shows auto-update and preview toggles', () => {
    render(<UpdateSettingsView />);
    expect(screen.getByText('Automatic updates')).toBeInTheDocument();
    expect(screen.getByText('Preview versions')).toBeInTheDocument();
  });

  it('shows idle status', () => {
    render(<UpdateSettingsView />);
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  it('shows checking status', () => {
    resetStores({
      status: { state: 'checking', availableVersion: null, downloadProgress: 0, error: null, artifactUrl: null },
    });
    render(<UpdateSettingsView />);
    // Both the status label and the button say "Checking..."
    expect(screen.getAllByText('Checking...').length).toBeGreaterThanOrEqual(1);
  });

  it('shows downloading status with progress', () => {
    resetStores({
      status: { state: 'downloading', availableVersion: null, downloadProgress: 42, error: null, artifactUrl: null },
    });
    render(<UpdateSettingsView />);
    expect(screen.getByText('Downloading... (42%)')).toBeInTheDocument();
  });

  it('shows ready status with version', () => {
    resetStores({
      status: { state: 'ready', availableVersion: '1.2.3', downloadProgress: 100, error: null, artifactUrl: 'https://example.com' },
    });
    render(<UpdateSettingsView />);
    expect(screen.getByText(/Update ready/)).toBeInTheDocument();
    expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
  });

  it('shows error status with message', () => {
    resetStores({
      status: { state: 'error', availableVersion: null, downloadProgress: 0, error: 'Network error', artifactUrl: 'https://example.com' },
    });
    render(<UpdateSettingsView />);
    expect(screen.getByText(/Network error/)).toBeInTheDocument();
  });

  it('calls checkForUpdates on button click', () => {
    render(<UpdateSettingsView />);
    fireEvent.click(screen.getByText('Check now'));
    expect(mockCheckForUpdates).toHaveBeenCalled();
  });

  it('disables check button while checking', () => {
    resetStores({
      status: { state: 'checking', availableVersion: null, downloadProgress: 0, error: null, artifactUrl: null },
    });
    render(<UpdateSettingsView />);
    // The button text changes to "Checking..." when state is checking
    const btn = screen.getAllByText('Checking...').find((el) => el.tagName === 'BUTTON');
    expect(btn).toBeDisabled();
  });

  it('shows manual download button when artifact URL available and ready', () => {
    resetStores({
      status: { state: 'ready', availableVersion: '1.2.3', downloadProgress: 100, error: null, artifactUrl: 'https://example.com' },
    });
    render(<UpdateSettingsView />);
    const downloadBtn = screen.getByText('Download manually');
    fireEvent.click(downloadBtn);
    expect(mockOpenUpdateDownload).toHaveBeenCalled();
  });

  it('shows last checked timestamp', () => {
    const timestamp = new Date('2026-01-15T10:00:00Z').getTime();
    resetStores({ settings: { autoUpdate: true, previewChannel: false, lastCheck: timestamp } });
    render(<UpdateSettingsView />);
    expect(screen.getByText('Last checked')).toBeInTheDocument();
  });

  it('hides last checked when null', () => {
    render(<UpdateSettingsView />);
    expect(screen.queryByText('Last checked')).not.toBeInTheDocument();
  });
});
