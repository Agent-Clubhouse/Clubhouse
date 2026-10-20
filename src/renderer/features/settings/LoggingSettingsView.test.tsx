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
    expect(screen.getByText(/Clubhouse never sends the log folder anywhere\./)).toBeInTheDocument();
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

  it('toggles local recording on/off via saveSettings', () => {
    render(<LoggingSettingsView />);
    fireEvent.click(screen.getByRole('switch', { name: 'Record locally' }));
    expect(mockSaveSettings).toHaveBeenCalledWith({ enabled: false });
  });

  it('switches local telemetry recording and its detail level (#2278)', () => {
    render(<LoggingSettingsView />);
    const toggle = screen.getByRole('switch', { name: 'Record telemetry signals' });
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
    expect(screen.getByRole('switch', { name: 'Record telemetry signals' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Detailed' })).toBeDisabled();
  });

  describe('labels and privacy copy (#2312)', () => {
    it('labels each toggle by what it records', () => {
      render(<LoggingSettingsView />);
      expect(screen.getByRole('switch', { name: 'Record locally' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Record telemetry signals' })).toBeInTheDocument();
      expect(screen.queryByText('Write logs')).not.toBeInTheDocument();
      expect(screen.queryByText('Record telemetry locally')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Diagnostic log' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Local telemetry' })).toBeInTheDocument();
    });

    it('says the diagnostic log is not anonymized and is never sent', () => {
      render(<LoggingSettingsView />);
      const privacy = screen.getByTestId('diagnostic-log-privacy');
      expect(privacy).toHaveTextContent('They are not anonymized.');
      expect(privacy).toHaveTextContent('Clubhouse never sends them.');
    });

    it('attaches no anonymized claim to the diagnostic log or local recording', () => {
      render(<LoggingSettingsView />);
      // Any "anonymized" outside the one disclaimer is a claim.
      const claimsAnonymized = (text: string | null) =>
        /anonymi[sz]ed/i.test((text ?? '').replace('They are not anonymized.', ''));
      const sectionText = (heading: string) => screen.getByRole('heading', { name: heading }).closest('section')!.textContent;
      expect(claimsAnonymized(sectionText('Diagnostic log'))).toBe(false);
      expect(claimsAnonymized(sectionText('Namespaces'))).toBe(false);
      expect(claimsAnonymized(screen.getByText(/never sends the log folder/).textContent)).toBe(false);
      expect(claimsAnonymized(screen.getByText(/Write the diagnostic log and local telemetry/).textContent)).toBe(false);
      expect(screen.getAllByText(/anonymized the same way as export/)).toHaveLength(1);
    });

    it('scopes the anonymized claim to the telemetry signals', () => {
      render(<LoggingSettingsView />);
      const telemetrySection = screen.getByRole('heading', { name: 'Local telemetry' }).closest('section')!;
      expect(telemetrySection).toHaveTextContent('Signals are anonymized the same way as export.');
    });

    it('describes retention from the shared tiers', () => {
      render(<LoggingSettingsView />);
      expect(screen.getByText('7 days, up to 200 MB')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Low' })).toHaveAttribute('title', '3 days, up to 50 MB');
      expect(screen.getByRole('radio', { name: 'Unlimited' })).toHaveAttribute('title', 'No limits on age or size');
    });
  });
});
