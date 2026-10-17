import { render, screen, fireEvent } from '@testing-library/react';
import { DisplaySettingsView } from './DisplaySettingsView';
import { useThemeStore } from '../../stores/themeStore';
import { useUIStore } from '../../stores/uiStore';

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

  it('shows the idle window instead of Home in the new layout', async () => {
    const { useChromeFlagStore } = await import('../../chrome/chromeFlag');
    const { useChromeStore } = await import('../../chrome/chromeStore');
    useChromeFlagStore.setState({ enabled: true });
    try {
      render(<DisplaySettingsView />);
      expect(screen.queryByText('Home')).toBeNull();
      fireEvent.change(screen.getByTestId('idle-days'), { target: { value: '30' } });
      expect(useChromeStore.getState().idleDays).toBe(30);
    } finally {
      useChromeFlagStore.setState({ enabled: false });
    }
  });
});
