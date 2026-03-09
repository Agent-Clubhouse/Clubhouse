import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useClipboardSettingsStore } from './clipboardSettingsStore';

// Mock the generic settings bridge (used by the updated store)
const mockSettingsGet = vi.fn(async () => ({ clipboardCompat: false }));
const mockSettingsSave = vi.fn(async () => {});
// Keep legacy mocks for backward compatibility checks
const mockGetClipboardSettings = vi.fn(async () => ({ clipboardCompat: false }));
const mockSaveClipboardSettings = vi.fn(async () => {});

let mockPlatform = 'darwin';

Object.defineProperty(window, 'clubhouse', {
  configurable: true,
  get: () => ({
    platform: mockPlatform,
    settings: {
      get: mockSettingsGet,
      save: mockSettingsSave,
    },
    app: {
      getClipboardSettings: mockGetClipboardSettings,
      saveClipboardSettings: mockSaveClipboardSettings,
    },
    pty: { write: vi.fn(), resize: vi.fn(), getBuffer: vi.fn(async () => ''), onData: () => vi.fn(), onExit: () => vi.fn() },
  }),
});

describe('clipboardSettingsStore', () => {
  beforeEach(() => {
    mockPlatform = 'darwin';
    mockSettingsGet.mockReset().mockResolvedValue({ clipboardCompat: false });
    mockSettingsSave.mockReset().mockResolvedValue(undefined);
    mockGetClipboardSettings.mockReset().mockResolvedValue({ clipboardCompat: false });
    mockSaveClipboardSettings.mockReset();
    // Reset store state
    useClipboardSettingsStore.setState({ clipboardCompat: false, loaded: false });
  });

  it('defaults clipboardCompat to false', () => {
    expect(useClipboardSettingsStore.getState().clipboardCompat).toBe(false);
  });

  it('loads settings from main process via generic bridge', async () => {
    mockSettingsGet.mockResolvedValue({ clipboardCompat: true });
    await useClipboardSettingsStore.getState().loadSettings();

    expect(mockSettingsGet).toHaveBeenCalledWith('clipboard');
    expect(useClipboardSettingsStore.getState().clipboardCompat).toBe(true);
    expect(useClipboardSettingsStore.getState().loaded).toBe(true);
  });

  it('defaults to false on mac when load returns null', async () => {
    mockPlatform = 'darwin';
    mockSettingsGet.mockResolvedValue(null);
    await useClipboardSettingsStore.getState().loadSettings();

    expect(useClipboardSettingsStore.getState().clipboardCompat).toBe(false);
    expect(useClipboardSettingsStore.getState().loaded).toBe(true);
  });

  it('defaults to true on windows when load returns null', async () => {
    mockPlatform = 'win32';
    mockSettingsGet.mockResolvedValue(null);
    await useClipboardSettingsStore.getState().loadSettings();

    expect(useClipboardSettingsStore.getState().clipboardCompat).toBe(true);
    expect(useClipboardSettingsStore.getState().loaded).toBe(true);
  });

  it('saves settings via generic bridge', async () => {
    await useClipboardSettingsStore.getState().saveSettings(true);

    expect(useClipboardSettingsStore.getState().clipboardCompat).toBe(true);
    expect(mockSettingsSave).toHaveBeenCalledWith('clipboard', { clipboardCompat: true });
  });

  it('reverts on save failure', async () => {
    mockSettingsSave.mockRejectedValue(new Error('fail'));
    await useClipboardSettingsStore.getState().saveSettings(true);

    expect(useClipboardSettingsStore.getState().clipboardCompat).toBe(false);
  });
});
