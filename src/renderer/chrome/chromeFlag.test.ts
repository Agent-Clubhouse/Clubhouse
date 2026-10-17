import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadChromeFlag, useChromeFlagStore, isNewChromeEnabled, NEW_CHROME_FLAG } from './chromeFlag';

describe('chromeFlag', () => {
  beforeEach(() => {
    useChromeFlagStore.setState({ enabled: false });
  });

  it('defaults to the legacy shell', () => {
    expect(isNewChromeEnabled()).toBe(false);
  });

  it('enables the new shell when the experimental flag is on', async () => {
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValueOnce({ [NEW_CHROME_FLAG]: true });
    await expect(loadChromeFlag()).resolves.toBe(true);
    expect(isNewChromeEnabled()).toBe(true);
  });

  it('stays on the legacy shell when the flag is absent', async () => {
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockResolvedValueOnce({ goobers: true });
    await expect(loadChromeFlag()).resolves.toBe(false);
  });

  it('stays on the legacy shell when reading settings fails', async () => {
    vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockRejectedValueOnce(new Error('ipc down'));
    await expect(loadChromeFlag()).resolves.toBe(false);
    expect(isNewChromeEnabled()).toBe(false);
  });
});
