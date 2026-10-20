import { render, screen, fireEvent } from '@testing-library/react';
import { LoggingSettingsView } from './LoggingSettingsView';
import { useLoggingStore } from '../../stores/loggingStore';

const mockLoadSettings = vi.fn();
const mockSaveSettings = vi.fn();

function resetStores(overrides: Partial<ReturnType<typeof useLoggingStore.getState>> = {}) {
  useLoggingStore.setState({
    settings: {
      enabled: true,
      namespaces: {},
      retention: 'medium' as any,
      minLogLevel: 'info' as any,
    },
    namespaces: ['main', 'renderer', 'plugin'],
    logPath: '/tmp/logs/clubhouse.log',
    loadSettings: mockLoadSettings,
    saveSettings: mockSaveSettings,
    loadNamespaces: vi.fn(),
    ...overrides,
  });
}

describe('LoggingSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<LoggingSettingsView />);
    expect(screen.getByText('Logging')).toBeInTheDocument();
  });

  it('shows loading state when settings are null', () => {
    resetStores({ settings: null });
    render(<LoggingSettingsView />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('calls loadSettings on mount', () => {
    render(<LoggingSettingsView />);
    expect(mockLoadSettings).toHaveBeenCalled();
  });

  it('shows log path and privacy banner', () => {
    render(<LoggingSettingsView />);
    expect(screen.getByText('Logs are stored on your local disk only and are never transmitted.')).toBeInTheDocument();
    expect(screen.getByText('/tmp/logs/clubhouse.log')).toBeInTheDocument();
  });

  it('shows retention tier options', () => {
    render(<LoggingSettingsView />);
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Unlimited')).toBeInTheDocument();
  });

  it('selects a retention tier on click', () => {
    render(<LoggingSettingsView />);
    fireEvent.click(screen.getByText('High'));
    expect(mockSaveSettings).toHaveBeenCalledWith({ retention: 'high' });
  });

  it('shows minimum log level buttons', () => {
    render(<LoggingSettingsView />);
    expect(screen.getByText('info')).toBeInTheDocument();
  });

  it('shows namespace toggles', () => {
    render(<LoggingSettingsView />);
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('renderer')).toBeInTheDocument();
    expect(screen.getByText('plugin')).toBeInTheDocument();
  });

  it('hides namespace section when no namespaces', () => {
    resetStores({ namespaces: [] });
    render(<LoggingSettingsView />);
    expect(screen.queryByText('Namespaces')).not.toBeInTheDocument();
  });

  it('toggles logging on/off via saveSettings', () => {
    render(<LoggingSettingsView />);
    expect(screen.getByText('Write logs')).toBeInTheDocument();
  });

  it('switches local telemetry recording and its detail level (#2278)', () => {
    render(<LoggingSettingsView />);
    const toggle = screen.getByRole('switch', { name: 'Record telemetry locally' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(mockSaveSettings).toHaveBeenCalledWith({ telemetryRecording: false });
    const detail = screen.getByRole('radiogroup', { name: 'Telemetry detail' });
    expect(screen.getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(mockSaveSettings).toHaveBeenCalledWith({ telemetryLevel: 'detailed' });
    expect(detail).toBeInTheDocument();
  });

  it('disables the telemetry controls while logging is off', () => {
    resetStores({ settings: { enabled: false, namespaces: {}, retention: 'medium', minLogLevel: 'info' } });
    render(<LoggingSettingsView />);
    expect(screen.getByRole('switch', { name: 'Record telemetry locally' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Detailed' })).toBeDisabled();
  });
});
