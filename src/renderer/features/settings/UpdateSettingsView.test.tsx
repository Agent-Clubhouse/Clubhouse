import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UpdateSettingsView } from './UpdateSettingsView';
import { useUpdateStore } from '../../stores/updateStore';

const mockSaveSettings = vi.fn();
const mockCheckForUpdates = vi.fn();
const mockOpenUpdateDownload = vi.fn();

function resetStores(overrides: Record<string, any> = {}) {
  useUpdateStore.setState({
    settings: { autoUpdate: true, previewChannel: false, lastCheck: null, lastCheckError: null },
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
    // Both the status label and the button say "Checking…"
    expect(screen.getAllByText('Checking…').length).toBeGreaterThanOrEqual(1);
  });

  it('shows downloading status with progress', () => {
    resetStores({
      status: { state: 'downloading', availableVersion: null, downloadProgress: 42, error: null, artifactUrl: null },
    });
    render(<UpdateSettingsView />);
    expect(screen.getByText('Downloading… (42%)')).toBeInTheDocument();
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
    // The button text changes to "Checking…" when state is checking
    const btn = screen.getAllByText('Checking…').find((el) => el.tagName === 'BUTTON');
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

  it('shows why the last check failed', () => {
    resetStores({
      settings: { autoUpdate: true, previewChannel: false, lastCheck: '2026-01-15T10:00:00Z', lastCheckError: 'HTTP 503' },
    });
    render(<UpdateSettingsView />);
    expect(screen.getByText(/Couldn't check: HTTP 503/)).toBeInTheDocument();
  });

  it('shows no failure line when the last check succeeded', () => {
    resetStores({ settings: { autoUpdate: true, previewChannel: false, lastCheck: '2026-01-15T10:00:00Z', lastCheckError: null } });
    render(<UpdateSettingsView />);
    expect(screen.queryByText(/Couldn't check/)).not.toBeInTheDocument();
  });

  it('hides last checked when null', () => {
    render(<UpdateSettingsView />);
    expect(screen.queryByText('Last checked')).not.toBeInTheDocument();
  });
});

describe('UpdateSettingsView manual check (#3231)', () => {
  const checkForUpdates = vi.fn();
  const getUpdateSettings = vi.fn();
  const idle = { state: 'idle', availableVersion: null, downloadProgress: 0, error: null, artifactUrl: null };

  // Taken at collection time, before the tests above swap in mock actions.
  const real = useUpdateStore.getState();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).clubhouse = { app: { checkForUpdates, getUpdateSettings } };
    useUpdateStore.setState({
      settings: { autoUpdate: true, previewChannel: false, lastCheck: '2026-01-01T00:00:00Z', lastCheckError: null } as any,
      status: idle as any,
      checkForUpdates: real.checkForUpdates,
      refreshCheckSettings: real.refreshCheckSettings,
    });
  });

  it('shows Checking, then the new Last checked time', async () => {
    let resolveCheck: (s: unknown) => void = () => {};
    checkForUpdates.mockReturnValue(new Promise((r) => { resolveCheck = r; }));
    getUpdateSettings.mockResolvedValue({ lastCheck: '2026-11-09T12:00:00Z', lastCheckError: null });
    render(<UpdateSettingsView />);
    const oldTime = new Date('2026-01-01T00:00:00Z').toLocaleString();
    expect(screen.getByText(oldTime)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Check now'));
    expect(screen.getAllByText('Checking…').length).toBeGreaterThanOrEqual(1);

    resolveCheck(idle);
    await waitFor(() => expect(screen.getByText(new Date('2026-11-09T12:00:00Z').toLocaleString())).toBeInTheDocument());
    expect(screen.queryByText(oldTime)).not.toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  it('shows the reason when the check fails', async () => {
    checkForUpdates.mockResolvedValue({ ...idle, state: 'error', error: 'HTTP 503' });
    getUpdateSettings.mockResolvedValue({ lastCheck: '2026-11-09T12:00:00Z', lastCheckError: 'HTTP 503' });
    render(<UpdateSettingsView />);

    fireEvent.click(screen.getByText('Check now'));
    await waitFor(() => expect(screen.getByText(/Couldn't check: HTTP 503/)).toBeInTheDocument());
    expect(screen.getByText(new Date('2026-11-09T12:00:00Z').toLocaleString())).toBeInTheDocument();
  });
});
