import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useToastStore } from '../stores/toastStore';
import { COPILOT_ACP_REMOVED_NOTICE_KEY } from '../../shared/types';
import { COPILOT_ACP_REMOVED_MESSAGE, showCopilotAcpRemovedNotice } from './copilot-acp-removal-notice';

describe('showCopilotAcpRemovedNotice', () => {
  const mockGetExperimentalSettings = vi.fn();
  const mockSaveExperimentalSettings = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    mockSaveExperimentalSettings.mockResolvedValue(undefined);
    window.clubhouse.app.getExperimentalSettings = mockGetExperimentalSettings;
    window.clubhouse.app.saveExperimentalSettings = mockSaveExperimentalSettings;
  });

  it('shows an info toast and clears only its marker', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ [COPILOT_ACP_REMOVED_NOTICE_KEY]: true, goobers: true });

    await showCopilotAcpRemovedNotice();

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ message: COPILOT_ACP_REMOVED_MESSAGE, type: 'info' });
    expect(mockSaveExperimentalSettings).toHaveBeenCalledWith({ goobers: true });
  });

  it('does nothing without the marker', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ goobers: true, [COPILOT_ACP_REMOVED_NOTICE_KEY]: false });

    await showCopilotAcpRemovedNotice();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(mockSaveExperimentalSettings).not.toHaveBeenCalled();
  });

  it('shows once across launches', async () => {
    let stored: Record<string, boolean> = { [COPILOT_ACP_REMOVED_NOTICE_KEY]: true };
    mockGetExperimentalSettings.mockImplementation(async () => stored);
    mockSaveExperimentalSettings.mockImplementation(async (next: Record<string, boolean>) => { stored = next; });

    await showCopilotAcpRemovedNotice();
    useToastStore.setState({ toasts: [] });
    await showCopilotAcpRemovedNotice();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(stored).toEqual({});
  });
});
