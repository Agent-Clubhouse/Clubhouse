import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExperimentalSettingsView } from './ExperimentalSettingsView';
import { useHookServerSettingsStore } from '../../stores/hookServerSettingsStore';

const mockGetExperimentalSettings = vi.fn();
const mockSaveExperimentalSettings = vi.fn();
const mockRestart = vi.fn();
const mockSettingsGet = vi.fn();
const mockSettingsSave = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetExperimentalSettings.mockResolvedValue({});
  mockSaveExperimentalSettings.mockResolvedValue(undefined);
  mockRestart.mockResolvedValue(undefined);
  mockSettingsGet.mockResolvedValue({ enabled: true });
  mockSettingsSave.mockResolvedValue(undefined);

  // Reset the Zustand store to a fresh state — it's module-level and
  // persists across tests otherwise.
  useHookServerSettingsStore.setState({ enabled: true, loaded: false });

  (window as any).clubhouse = {
    ...(window as any).clubhouse,
    app: {
      ...(window as any).clubhouse?.app,
      getExperimentalSettings: mockGetExperimentalSettings,
      saveExperimentalSettings: mockSaveExperimentalSettings,
      restart: mockRestart,
    },
    settings: {
      ...(window as any).clubhouse?.settings,
      get: mockSettingsGet,
      save: mockSettingsSave,
    },
  };
});

describe('ExperimentalSettingsView', () => {
  it('renders the heading and disclaimer', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    expect(screen.getByText('Beta Features')).toBeInTheDocument();
    expect(screen.getByText(/unstable and may be buggy/)).toBeInTheDocument();
  });

  it('loads settings on mount', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(mockGetExperimentalSettings).toHaveBeenCalled();
    });
  });

  it('renders feature toggles', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });
    expect(screen.getByText('Agent Queue')).toBeInTheDocument();
    expect(screen.getByText('Structured Mode')).toBeInTheDocument();
    expect(screen.getByText('Theme Gradients & Fonts')).toBeInTheDocument();
  });

  it('does not list Clubhouse MCP as experimental (promoted)', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Structured Mode')).toBeInTheDocument();
    });
    expect(screen.queryByText('Clubhouse MCP')).not.toBeInTheDocument();
  });

  it('toggles a feature and saves', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ assistant: false });
    const { container } = render(<ExperimentalSettingsView />);

    await waitFor(() => {
      expect(screen.getByText('Assistant')).toBeInTheDocument();
    });

    // The Toggle component renders a button with a rounded-full class
    // First toggle is the Assistant feature
    const toggleBtn = container.querySelector('button.rounded-full') as HTMLElement;
    expect(toggleBtn).toBeInTheDocument();
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ assistant: true });
    });
  });

  it('renders the restart button', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Restart')).toBeInTheDocument();
    });
  });

  it('calls restart when button is clicked', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Restart')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Restart'));
    expect(mockRestart).toHaveBeenCalled();
  });

  it('shows restart description text', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/Restart Clubhouse to apply/)).toBeInTheDocument();
    });
  });

  describe('Diagnostics — hook server toggle', () => {
    it('renders the Diagnostics section with the Hook server toggle', async () => {
      render(<ExperimentalSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Diagnostics')).toBeInTheDocument();
      });
      expect(screen.getByText('Hook server')).toBeInTheDocument();
      expect(screen.getByText(/escape hatch/)).toBeInTheDocument();
    });

    it('loads hook server settings on mount', async () => {
      render(<ExperimentalSettingsView />);
      await waitFor(() => {
        expect(mockSettingsGet).toHaveBeenCalledWith('hook-server');
      });
    });

    it('saves the toggle change to the hook-server settings key', async () => {
      mockSettingsGet.mockResolvedValue({ enabled: true });
      render(<ExperimentalSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Hook server')).toBeInTheDocument();
      });

      // Click the toggle next to "Hook server".  All toggles render as
      // `button.rounded-full`; the Diagnostics one is the last (after the
      // experimental feature toggles).
      const toggles = document.querySelectorAll('button.rounded-full');
      const hookToggle = toggles[toggles.length - 1] as HTMLElement;
      fireEvent.click(hookToggle);

      await waitFor(() => {
        expect(mockSettingsSave).toHaveBeenCalledWith('hook-server', { enabled: false });
      });
    });
  });
});
