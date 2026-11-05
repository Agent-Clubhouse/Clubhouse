import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EXPERIMENTAL_FEATURES, ExperimentalSettingsView } from './ExperimentalSettingsView';
import { PREVIEW_ONLY_EXPERIMENTAL_FLAGS } from '../../../shared/types';

const mockGetExperimentalSettings = vi.fn();
const mockSaveExperimentalSettings = vi.fn();
const mockRestart = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetExperimentalSettings.mockResolvedValue({});
  mockSaveExperimentalSettings.mockResolvedValue(undefined);
  mockRestart.mockResolvedValue(undefined);

  (window as any).clubhouse = {
    ...(window as any).clubhouse,
    app: {
      ...(window as any).clubhouse?.app,
      getExperimentalSettings: mockGetExperimentalSettings,
      saveExperimentalSettings: mockSaveExperimentalSettings,
      restart: mockRestart,
    },
  };
});

describe('ExperimentalSettingsView', () => {
  it('lists only preview-only flags, so a new one has to join the gate or say why not', () => {
    const offered = EXPERIMENTAL_FEATURES.map((f) => f.id).filter((id) => id !== 'themeGradients');
    expect([...offered].sort()).toEqual([...PREVIEW_ONLY_EXPERIMENTAL_FLAGS].sort());
  });

  it('renders the heading and disclaimer', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    expect(screen.getByText(/may change or go away in future releases/)).toBeInTheDocument();
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
      expect(screen.getByText('Theme gradients & fonts')).toBeInTheDocument();
    });
    // Removed features no longer have toggles
    expect(screen.queryByText('Structured Mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent Queue')).not.toBeInTheDocument();
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
  });

  it('renders the Goobers feature toggle', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Goobers')).toBeInTheDocument();
    });
  });

  it('no longer offers a Dispatcher flag: it has its own page', async () => {
    render(<ExperimentalSettingsView />);
    await screen.findByText('Goobers');
    expect(screen.queryByRole('switch', { name: 'Dispatcher' })).toBeNull();
  });

  it('offers the Copilot SDK driver flag, off by default, and says when it needs Chat', async () => {
    mockGetExperimentalSettings.mockResolvedValue({});
    const { unmount } = render(<ExperimentalSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Copilot SDK driver' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Needs Chat, which is off\./)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ copilotSdk: true }));
    unmount();

    mockGetExperimentalSettings.mockResolvedValue({ chat: true });
    render(<ExperimentalSettingsView />);
    await screen.findByRole('switch', { name: 'Copilot SDK driver' });
    expect(screen.queryByText(/Needs Chat, which is off\./)).not.toBeInTheDocument();
  });

  it('renders the Chat feature toggle and saves it under the chat id', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ goobers: true });
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Chat')).toBeInTheDocument();
    });
    expect(screen.getByText(/native chat view\. The CLI view stays available for every provider\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Chat' }));

    await waitFor(() => {
      expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ goobers: true, chat: true });
    });
  });

  it('does not list Telemetry export, and saving another flag keeps its saved value for a downgrade', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ telemetry: true });
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Theme gradients & fonts')).toBeInTheDocument();
    });
    expect(screen.queryByText('Telemetry export')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Theme gradients & fonts' }));
    await waitFor(() => {
      expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ telemetry: true, themeGradients: true });
    });
  });

  it('shows a failed save and puts the switch back', async () => {
    mockGetExperimentalSettings.mockResolvedValue({});
    mockSaveExperimentalSettings.mockRejectedValueOnce(new Error('refused'));
    render(<ExperimentalSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Theme gradients & fonts' });
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t save that setting');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('does not list Clubhouse MCP as experimental (promoted)', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Theme gradients & fonts')).toBeInTheDocument();
    });
    expect(screen.queryByText('Clubhouse MCP')).not.toBeInTheDocument();
  });

  it('toggles a feature and saves', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ themeGradients: false });
    const { container } = render(<ExperimentalSettingsView />);

    await waitFor(() => {
      expect(screen.getByText('Theme gradients & fonts')).toBeInTheDocument();
    });

    // The Toggle component renders a button with a rounded-full class
    // First toggle is the Theme Gradients & Fonts feature
    const toggleBtn = container.querySelector('button.rounded-full') as HTMLElement;
    expect(toggleBtn).toBeInTheDocument();
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ themeGradients: true });
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

  it('no longer renders the global Diagnostics hook server escape hatch', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Experimental')).toBeInTheDocument();
    });
    expect(screen.queryByText('Diagnostics')).not.toBeInTheDocument();
    expect(screen.queryByText('Hook server')).not.toBeInTheDocument();
  });
});
