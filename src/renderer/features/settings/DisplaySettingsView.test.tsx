import { render, screen, fireEvent } from '@testing-library/react';
import { DisplaySettingsView } from './DisplaySettingsView';
import { useThemeStore } from '../../stores/themeStore';
import { useUIStore } from '../../stores/uiStore';
import { useSessionSettingsStore } from '../../stores/sessionSettingsStore';

vi.mock('../../themes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../themes')>();
  return {
    ...orig,
    getTheme: (id: string) => ({
      name: id === 'catppuccin-mocha' ? 'Mocha' : 'Latte',
      colors: { base: '#1e1e2e', mantle: '#181825', surface0: '#313244', text: '#cdd6f4', accent: '#cba6f7' },
    }),
  };
});

const mockSetTheme = vi.fn();
const mockSetShowHome = vi.fn();
const mockSetPromptForName = vi.fn();
const mockLoadSessionSettings = vi.fn();

function resetStores() {
  useThemeStore.setState({
    themeId: 'catppuccin-mocha' as any,
    availableThemeIds: ['catppuccin-mocha', 'catppuccin-latte'] as any,
    setTheme: mockSetTheme,
  });
  useUIStore.setState({
    showHome: true,
    setShowHome: mockSetShowHome,
  });
  useSessionSettingsStore.setState({
    promptForName: false,
    setPromptForName: mockSetPromptForName,
    loadSettings: mockLoadSessionSettings,
  });
}

describe('DisplaySettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<DisplaySettingsView />);
    expect(screen.getByText('Display & UI')).toBeInTheDocument();
  });

  it('loads session settings on mount', () => {
    render(<DisplaySettingsView />);
    expect(mockLoadSessionSettings).toHaveBeenCalled();
  });

  it('renders theme options', () => {
    render(<DisplaySettingsView />);
    expect(screen.getByText('Mocha')).toBeInTheDocument();
    expect(screen.getByText('Latte')).toBeInTheDocument();
  });

  it('selects a theme when clicked', () => {
    render(<DisplaySettingsView />);
    fireEvent.click(screen.getByText('Latte'));
    expect(mockSetTheme).toHaveBeenCalledWith('catppuccin-latte');
  });

  it('renders Home view toggle', () => {
    render(<DisplaySettingsView />);
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('renders session name prompt toggle', () => {
    render(<DisplaySettingsView />);
    expect(screen.getByText('Prompt for Session Name on Quit')).toBeInTheDocument();
  });
});
