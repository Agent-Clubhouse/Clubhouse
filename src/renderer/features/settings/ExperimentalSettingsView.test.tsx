import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExperimentalSettingsView } from './ExperimentalSettingsView';

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
      expect(screen.getByText('Theme Gradients & Fonts')).toBeInTheDocument();
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

  it('does not list Clubhouse MCP as experimental (promoted)', async () => {
    render(<ExperimentalSettingsView />);
    await waitFor(() => {
      expect(screen.getByText('Theme Gradients & Fonts')).toBeInTheDocument();
    });
    expect(screen.queryByText('Clubhouse MCP')).not.toBeInTheDocument();
  });

  it('toggles a feature and saves', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ themeGradients: false });
    const { container } = render(<ExperimentalSettingsView />);

    await waitFor(() => {
      expect(screen.getByText('Theme Gradients & Fonts')).toBeInTheDocument();
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
