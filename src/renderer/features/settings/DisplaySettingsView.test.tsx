import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DisplaySettingsView } from './DisplaySettingsView';
import { useThemeStore } from '../../stores/themeStore';
import { useUIStore } from '../../stores/uiStore';
import { useChromeFlagStore } from '../../chrome/chromeFlag';

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
    const { useChromeStore } = await import('../../chrome/chromeStore');
    useChromeFlagStore.setState({ enabled: true });
    try {
      render(<DisplaySettingsView />);
      expect(screen.queryByText('Home')).toBeNull();
      fireEvent.change(screen.getByTestId('idle-days'), { target: { value: '30' } });
      expect(useChromeStore.getState().idleDays).toBe(30);
      // Project and agent order (#2116).
      fireEvent.change(screen.getByTestId('project-sort'), { target: { value: 'recent' } });
      fireEvent.change(screen.getByTestId('agent-sort'), { target: { value: 'recent' } });
      expect(useChromeStore.getState()).toMatchObject({ projectSort: 'recent', agentSort: 'recent' });
      useChromeStore.setState({ projectSort: 'manual', agentSort: 'manual' });
    } finally {
      useChromeFlagStore.setState({ enabled: false });
    }
  });

  describe('Classic layout', () => {
    const getExperimentalSettings = vi.fn();
    const saveExperimentalSettings = vi.fn();
    const restart = vi.fn();

    beforeEach(() => {
      getExperimentalSettings.mockReset();
      saveExperimentalSettings.mockReset().mockResolvedValue(undefined);
      (window as any).clubhouse = {
        ...(window as any).clubhouse,
        app: { ...(window as any).clubhouse?.app, getExperimentalSettings, saveExperimentalSettings, restart },
      };
    });

    afterEach(() => {
      useChromeFlagStore.setState({ enabled: false });
    });

    async function renderIn(enabled: boolean, saved: Record<string, boolean>) {
      useChromeFlagStore.setState({ enabled });
      getExperimentalSettings.mockResolvedValue(saved);
      render(<DisplaySettingsView />);
      const toggle = screen.getByRole('switch', { name: 'Classic layout' });
      await waitFor(() => expect(getExperimentalSettings).toHaveBeenCalled());
      await act(async () => {});
      return toggle;
    }

    it.each([
      ['the new layout, nothing saved', true, {}, 'false'],
      ['the new layout, saved true', true, { newChrome: true }, 'false'],
      ['the classic layout, saved false', false, { newChrome: false }, 'true'],
    ])('shows in %s, with no restart to offer', async (_name, enabled, saved, checked) => {
      const toggle = await renderIn(enabled, saved);
      expect(toggle.getAttribute('aria-checked')).toBe(checked);
      expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    });

    it('says it applies after a restart and that the classic layout is going away', async () => {
      await renderIn(true, {});
      expect(screen.getByText(/Applies after a restart\. The classic layout will go away in a future update\./)).toBeInTheDocument();
    });

    it('turning it on saves false over the current flags, and offers the restart', async () => {
      const toggle = await renderIn(true, { themeGradients: true });
      // A flag saved since the page opened is kept: the write starts from a fresh read.
      getExperimentalSettings.mockResolvedValue({ themeGradients: true, chat: true });
      await act(async () => { fireEvent.click(toggle); });
      expect(saveExperimentalSettings).toHaveBeenCalledWith({ themeGradients: true, chat: true, newChrome: false });
      fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
      expect(restart).toHaveBeenCalled();
    });

    it('turning it off saves true, and offers the restart from the classic layout', async () => {
      const toggle = await renderIn(false, { newChrome: false });
      await act(async () => { fireEvent.click(toggle); });
      expect(saveExperimentalSettings).toHaveBeenCalledWith({ newChrome: true });
      expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    });

    it('takes the restart away when the choice goes back to this session', async () => {
      const toggle = await renderIn(true, {});
      await act(async () => { fireEvent.click(toggle); });
      expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(toggle); });
      expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    });
  });
});
