import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EXPERIMENTAL_FEATURES, ExperimentalSettingsView } from './ExperimentalSettingsView';
import { PREVIEW_ONLY_EXPERIMENTAL_FLAGS } from '../../../shared/types';
import { SETTING_NOT_SAVED_TEXT } from './SettingsLayout';

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
    const offered = EXPERIMENTAL_FEATURES.map((f) => f.id);
    expect([...offered].sort()).toEqual(PREVIEW_ONLY_EXPERIMENTAL_FLAGS.filter((id) => id !== 'copilotSdk').sort());
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
      expect(screen.getByText('Goobers')).toBeInTheDocument();
    });
    // Graduated features moved to their own settings pages
    expect(screen.queryByText('Theme gradients & fonts')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Rich chat content')).not.toBeInTheDocument();
    expect(screen.queryByText('Clubhouse-managed agents')).not.toBeInTheDocument();
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

  it('no longer offers legacy Copilot ACP: the driver was removed (#2868)', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ copilotLegacyAcp: true });
    render(<ExperimentalSettingsView />);
    await screen.findByRole('switch', { name: 'Goobers' });
    expect(screen.queryByRole('switch', { name: /Copilot ACP/ })).toBeNull();
    expect(screen.queryByText(/legacy Copilot ACP/i)).toBeNull();
  });

  it('does not list Telemetry export, and saving another flag keeps its saved value for a downgrade', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ telemetry: true });
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Goobers')).toBeInTheDocument();
    });
    expect(screen.queryByText('Telemetry export')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Goobers' }));
    await waitFor(() => {
      expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ telemetry: true, goobers: true });
    });
  });

  it('shows a failed save and puts the switch back', async () => {
    mockGetExperimentalSettings.mockResolvedValue({});
    mockSaveExperimentalSettings.mockRejectedValueOnce(new Error('refused'));
    render(<ExperimentalSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Goobers' });
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent(SETTING_NOT_SAVED_TEXT);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('a failed save rolls back, blocks duplicate changes, then retries without changing other flags', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ goobers: false, telemetry: true });
    let reject!: (reason: Error) => void;
    mockSaveExperimentalSettings.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<ExperimentalSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Goobers' });
    fireEvent.click(toggle);
    await waitFor(() => expect(mockSaveExperimentalSettings).toHaveBeenCalledTimes(1));
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(mockSaveExperimentalSettings).toHaveBeenCalledTimes(1);
    reject(new Error('synthetic refusal'));
    expect(await screen.findByRole('alert')).toHaveTextContent(SETTING_NOT_SAVED_TEXT);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(mockRestart).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(mockSaveExperimentalSettings).toHaveBeenLastCalledWith({ goobers: true, telemetry: true });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not list Clubhouse MCP as experimental (promoted)', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Goobers')).toBeInTheDocument();
    });
    expect(screen.queryByText('Clubhouse MCP')).not.toBeInTheDocument();
  });

  it('toggles a feature and saves', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ goobers: false });
    const { container } = render(<ExperimentalSettingsView />);

    await waitFor(() => {
      expect(screen.getByText('Goobers')).toBeInTheDocument();
    });

    // The Toggle component renders a button with a rounded-full class
    // First toggle is the Goobers feature
    const toggleBtn = container.querySelector('button.rounded-full') as HTMLElement;
    expect(toggleBtn).toBeInTheDocument();
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ goobers: true });
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
