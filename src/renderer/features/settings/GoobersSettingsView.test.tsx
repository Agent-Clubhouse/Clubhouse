import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GoobersSettingsView } from './GoobersSettingsView';
import { useGoobersSettingsStore } from '../../stores/goobersSettingsStore';

const mockLoadSettings = vi.fn();
const mockSaveSettings = vi.fn();

function resetStore(overrides: Partial<{
  instanceRoot: string;
  binaryPath: string;
  autoConnect: boolean;
  manageDaemon: boolean;
  loaded: boolean;
}> = {}) {
  useGoobersSettingsStore.setState({
    instanceRoot: '',
    binaryPath: 'goobers',
    autoConnect: true,
    manageDaemon: false,
    loaded: true,
    loadSettings: mockLoadSettings,
    saveSettings: mockSaveSettings,
    ...overrides,
  });
}

describe('GoobersSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    window.clubhouse.goobers.validateRoot = vi.fn(async () => ({ ok: false }));
    window.clubhouse.project.pickDirectory = vi.fn(async () => null);
  });

  it('renders heading and description', () => {
    render(<GoobersSettingsView />);
    expect(screen.getByText('Goobers')).toBeInTheDocument();
    expect(screen.getByText(/Point Clubhouse at a Goobers instance/)).toBeInTheDocument();
  });

  it('loads settings on mount', () => {
    render(<GoobersSettingsView />);
    expect(mockLoadSettings).toHaveBeenCalled();
  });

  it('picks a directory via Browse and saves it as instanceRoot', async () => {
    window.clubhouse.project.pickDirectory = vi.fn(async () => '/picked/instance');
    render(<GoobersSettingsView />);
    fireEvent.click(screen.getByTestId('goobers-browse-root'));
    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledWith({ instanceRoot: '/picked/instance' });
    });
  });

  it('does not save when Browse is cancelled', async () => {
    window.clubhouse.project.pickDirectory = vi.fn(async () => null);
    render(<GoobersSettingsView />);
    fireEvent.click(screen.getByTestId('goobers-browse-root'));
    await waitFor(() => {
      expect(window.clubhouse.project.pickDirectory).toHaveBeenCalled();
    });
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });

  it('saves instanceRoot on manual text edit', () => {
    render(<GoobersSettingsView />);
    fireEvent.change(screen.getByTestId('goobers-instance-root'), { target: { value: '/typed/path' } });
    expect(mockSaveSettings).toHaveBeenCalledWith({ instanceRoot: '/typed/path' });
  });

  it('shows a specific error for a root with no instance.yaml', async () => {
    window.clubhouse.goobers.validateRoot = vi.fn(async () => ({
      ok: false,
      error: { code: 'not-a-goobers-instance-root', message: 'not a Goobers instance root' },
    }));
    resetStore({ instanceRoot: '/bad/root' });
    render(<GoobersSettingsView />);
    await waitFor(() => {
      expect(screen.getByTestId('goobers-root-validation').textContent).toContain('not a Goobers instance root');
    });
  });

  it('reports the .instance-id for a valid root', async () => {
    window.clubhouse.goobers.validateRoot = vi.fn(async () => ({ ok: true, instanceId: 'abc123' }));
    resetStore({ instanceRoot: '/good/root' });
    render(<GoobersSettingsView />);
    await waitFor(() => {
      expect(screen.getByTestId('goobers-root-validation').textContent).toContain('abc123');
    });
  });

  it('shows no validation state when instanceRoot is empty', () => {
    render(<GoobersSettingsView />);
    expect(screen.queryByTestId('goobers-root-validation')).not.toBeInTheDocument();
  });

  it('saves binaryPath on change', () => {
    render(<GoobersSettingsView />);
    fireEvent.change(screen.getByTestId('goobers-binary-path'), { target: { value: '/usr/local/bin/goobers' } });
    expect(mockSaveSettings).toHaveBeenCalledWith({ binaryPath: '/usr/local/bin/goobers' });
  });

  it('toggles autoConnect immediately', () => {
    render(<GoobersSettingsView />);
    fireEvent.click(screen.getByTestId('goobers-auto-connect-toggle').querySelector('button')!);
    expect(mockSaveSettings).toHaveBeenCalledWith({ autoConnect: false });
  });

  it('shows hazards before enabling manageDaemon rather than saving immediately', () => {
    render(<GoobersSettingsView />);
    const toggle = screen.getByTestId('goobers-manage-daemon-toggle').querySelector('button')!;
    fireEvent.click(toggle);
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('goobers-daemon-hazards')).toBeInTheDocument();
    expect(screen.getByText(/login-shell environment/)).toBeInTheDocument();
    expect(screen.getByText(/30-40 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/outlives Clubhouse/)).toBeInTheDocument();
  });

  it('enables manageDaemon only after confirming the hazards', () => {
    render(<GoobersSettingsView />);
    const toggle = screen.getByTestId('goobers-manage-daemon-toggle').querySelector('button')!;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('goobers-daemon-hazards-confirm'));
    expect(mockSaveSettings).toHaveBeenCalledWith({ manageDaemon: true });
    expect(screen.queryByTestId('goobers-daemon-hazards')).not.toBeInTheDocument();
  });

  it('cancelling the hazard warning does not enable manageDaemon', () => {
    render(<GoobersSettingsView />);
    const toggle = screen.getByTestId('goobers-manage-daemon-toggle').querySelector('button')!;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('goobers-daemon-hazards-cancel'));
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('goobers-daemon-hazards')).not.toBeInTheDocument();
  });

  it('disabling manageDaemon does not show hazards', () => {
    resetStore({ manageDaemon: true });
    render(<GoobersSettingsView />);
    const toggle = screen.getByTestId('goobers-manage-daemon-toggle').querySelector('button')!;
    fireEvent.click(toggle);
    expect(mockSaveSettings).toHaveBeenCalledWith({ manageDaemon: false });
    expect(screen.queryByTestId('goobers-daemon-hazards')).not.toBeInTheDocument();
  });
});
