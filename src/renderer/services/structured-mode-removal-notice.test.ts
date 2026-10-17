import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useToastStore } from '../stores/toastStore';
import { STRUCTURED_MODE_REMOVED_NOTICE_KEY } from '../../shared/types';
import {
  showStructuredModeRemovedNotice,
  STRUCTURED_MODE_REMOVED_MESSAGE,
} from './structured-mode-removal-notice';

describe('showStructuredModeRemovedNotice', () => {
  const mockGetExperimentalSettings = vi.fn();
  const mockSaveExperimentalSettings = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    mockSaveExperimentalSettings.mockResolvedValue(undefined);
    window.clubhouse.app.getExperimentalSettings = mockGetExperimentalSettings;
    window.clubhouse.app.saveExperimentalSettings = mockSaveExperimentalSettings;
  });

  it('shows an info toast and clears the marker when the notice key is set', async () => {
    mockGetExperimentalSettings.mockResolvedValue({
      [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true,
      themeGradients: true,
    });

    await showStructuredModeRemovedNotice();

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ message: STRUCTURED_MODE_REMOVED_MESSAGE, type: 'info' });
    // Other flags are preserved; only the marker is dropped.
    expect(mockSaveExperimentalSettings).toHaveBeenCalledTimes(1);
    expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ themeGradients: true });
  });

  it('does nothing when the notice key is absent', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ themeGradients: true });

    await showStructuredModeRemovedNotice();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(mockSaveExperimentalSettings).not.toHaveBeenCalled();
  });

  it('does nothing when the notice key is false', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: false });

    await showStructuredModeRemovedNotice();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(mockSaveExperimentalSettings).not.toHaveBeenCalled();
  });

  it('shows the notice only once across launches (marker cleared after first show)', async () => {
    let stored: Record<string, boolean> = { [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true };
    mockGetExperimentalSettings.mockImplementation(async () => stored);
    mockSaveExperimentalSettings.mockImplementation(async (next: Record<string, boolean>) => { stored = next; });

    await showStructuredModeRemovedNotice();
    useToastStore.setState({ toasts: [] });
    await showStructuredModeRemovedNotice();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(mockSaveExperimentalSettings).toHaveBeenCalledTimes(1);
    expect(stored).toEqual({});
  });

  it('propagates a settings read failure without showing a toast', async () => {
    mockGetExperimentalSettings.mockRejectedValue(new Error('IPC down'));

    await expect(showStructuredModeRemovedNotice()).rejects.toThrow('IPC down');
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(mockSaveExperimentalSettings).not.toHaveBeenCalled();
  });
});
