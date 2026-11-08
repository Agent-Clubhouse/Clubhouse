import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DisplaySettingsView } from './DisplaySettingsView';
import { useThemeStore } from '../../stores/themeStore';
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

const realSetThemeGradients = useThemeStore.getState().setThemeGradients;
const mockSetTheme = vi.fn();

function resetStores() {
  useThemeStore.setState({
    themeId: 'catppuccin-mocha' as any,
    availableThemeIds: ['catppuccin-mocha', 'catppuccin-latte'] as any,
    setTheme: mockSetTheme,
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

  it('offers Theme gradients & fonts, on unless saved off, and changes it through the store', () => {
    const setThemeGradients = vi.fn().mockResolvedValue(true);
    useThemeStore.setState({ experimentalGradients: true, setThemeGradients });
    render(<DisplaySettingsView />);
    const toggle = screen.getByRole('switch', { name: 'Theme gradients & fonts' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(setThemeGradients).toHaveBeenCalledWith(false);
  });

  it('reverts Theme gradients & fonts and says so when the save is refused, and a retry works', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined);
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValue({});
    vi.spyOn(window.clubhouse.app, 'saveExperimentalSettings').mockImplementation(save);
    useThemeStore.setState({ experimentalGradients: true, setThemeGradients: realSetThemeGradients });
    render(<DisplaySettingsView />);
    const toggle = screen.getByRole('switch', { name: 'Theme gradients & fonts' });

    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that setting, so it wasn't changed. Try again.");
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(save).toHaveBeenLastCalledWith({ themeGradients: false });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('has no Views section in the classic layout, since Home was removed', () => {
    render(<DisplaySettingsView />);
    expect(screen.queryByText('Views')).toBeNull();
    expect(screen.queryByText('Home')).toBeNull();
  });

  it('shows the idle window and sidebar order in the new layout', async () => {
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

    it.each([
      ['the new layout', true, 'false'],
      ['the classic layout', false, 'true'],
    ])('when the saved settings can\'t be read in %s, shows that layout with no restart and no error', async (_name, enabled, checked) => {
      useChromeFlagStore.setState({ enabled });
      getExperimentalSettings.mockRejectedValue(new Error('gone'));
      render(<DisplaySettingsView />);
      await act(async () => {});
      expect(getExperimentalSettings).toHaveBeenCalled();
      expect(screen.getByRole('switch', { name: 'Classic layout' }).getAttribute('aria-checked')).toBe(checked);
      expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    const SAVE_FAILED = "Couldn't save that setting, so it wasn't changed. Try again.";

    it.each([
      ['the save', () => saveExperimentalSettings.mockRejectedValueOnce(new Error('read-only'))],
      ['the read before it', () => getExperimentalSettings.mockRejectedValueOnce(new Error('gone'))],
    ])('when %s fails, goes back to the saved value and says so', async (_name, fail) => {
      const toggle = await renderIn(true, {});
      fail();
      await act(async () => { fireEvent.click(toggle); });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('alert').textContent).toBe(SAVE_FAILED);
      // Nothing changed, so there's nothing to restart for.
      expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    });

    it('a retry after a failed save works and clears the message', async () => {
      const toggle = await renderIn(true, { chat: true });
      saveExperimentalSettings.mockRejectedValueOnce(new Error('read-only'));
      await act(async () => { fireEvent.click(toggle); });
      expect(screen.getByRole('alert').textContent).toBe(SAVE_FAILED);

      await act(async () => { fireEvent.click(toggle); });
      expect(saveExperimentalSettings).toHaveBeenLastCalledWith({ chat: true, newChrome: false });
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    });

    it('holds the switch while a save is in flight', async () => {
      const toggle = await renderIn(true, {});
      let finishSave!: () => void;
      saveExperimentalSettings.mockReturnValueOnce(new Promise<void>((resolve) => { finishSave = resolve; }));
      await act(async () => { fireEvent.click(toggle); });
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(toggle);
      expect(saveExperimentalSettings).toHaveBeenCalledTimes(1);
      await act(async () => { finishSave(); });
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
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
