import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettings = vi.fn();
const savedSettingsUnreadable = vi.fn();
vi.mock('./services/experimental-settings', () => ({
  getSettings: () => getSettings(),
  savedSettingsUnreadable: () => savedSettingsUnreadable(),
}));

import { newChromeEnabled, resetNewChromeCacheForTests, titleBarOptions, usesTitleBarOverlay } from './window-chrome';

const colors = { mantle: '#111', text: '#eee' };

beforeEach(() => {
  resetNewChromeCacheForTests();
  getSettings.mockReset();
  savedSettingsUnreadable.mockReset();
  savedSettingsUnreadable.mockReturnValue(false);
});

describe('window chrome', () => {
  it('keeps the traffic lights on macOS in both layouts', () => {
    expect(titleBarOptions('darwin', false, colors)).toEqual({ titleBarStyle: 'hiddenInset' });
    expect(titleBarOptions('darwin', true, colors)).toEqual({ titleBarStyle: 'hiddenInset' });
  });

  it('uses the overlay on Windows in both layouts', () => {
    const overlay = { titleBarStyle: 'hidden', titleBarOverlay: { color: '#111', symbolColor: '#eee', height: 38 } };
    expect(titleBarOptions('win32', false, colors)).toEqual(overlay);
    expect(titleBarOptions('win32', true, colors)).toEqual(overlay);
  });

  it('uses the overlay on Linux only in the new layout', () => {
    expect(titleBarOptions('linux', false, colors)).toEqual({ titleBarStyle: 'hiddenInset' });
    expect(titleBarOptions('linux', true, colors)).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: 38 } });
    expect(usesTitleBarOverlay('linux', false)).toBe(false);
    expect(usesTitleBarOverlay('linux', true)).toBe(true);
  });

  it('reads the flag once per session', () => {
    getSettings.mockReturnValue({ newChrome: true });
    expect(newChromeEnabled()).toBe(true);
    getSettings.mockReturnValue({ newChrome: false });
    expect(newChromeEnabled()).toBe(true);
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', {}, true],
    ['true', { newChrome: true }, true],
    ['false', { newChrome: false }, false],
  ])('with the flag %s, picks the layout', (_name, saved, expected) => {
    getSettings.mockReturnValue(saved);
    expect(newChromeEnabled()).toBe(expected);
  });

  it('falls back to the legacy layout when settings throw', () => {
    getSettings.mockImplementation(() => { throw new Error('corrupt'); });
    expect(newChromeEnabled()).toBe(false);
  });

  it('falls back to the legacy layout when the file is unreadable, though the store reads as empty', () => {
    getSettings.mockReturnValue({});
    savedSettingsUnreadable.mockReturnValue(true);
    expect(newChromeEnabled()).toBe(false);
  });
});
