import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('./settings-store', () => {
  let stored: Record<string, unknown> = { enabled: false };
  return {
    createSettingsStore: vi.fn(() => ({
      get: () => ({ ...stored }),
      save: vi.fn(async (settings: Record<string, unknown>) => { stored = { ...settings }; }),
    })),
    resetAllSettingsStoresForTests: vi.fn(() => { stored = { enabled: false }; }),
  };
});

vi.mock('./clubhouse-mode-settings', () => ({
  isClubhouseModeEnabled: vi.fn(() => false),
}));

import { isMcpEnabled, getSettings, saveSettings } from './mcp-settings';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { resetAllSettingsStoresForTests } from './settings-store';

describe('mcp-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('isMcpEnabled', () => {
    it('returns false by default', () => {
      expect(isMcpEnabled()).toBe(false);
    });

    it('returns true when globally enabled', async () => {
      await saveSettings({ enabled: true });
      expect(isMcpEnabled()).toBe(true);
    });

    it('agent override takes highest priority', async () => {
      await saveSettings({ enabled: false });
      expect(isMcpEnabled('/project', true)).toBe(true);
      expect(isMcpEnabled('/project', false)).toBe(false);
    });

    it('project override takes priority over global', async () => {
      await saveSettings({ enabled: true, projectOverrides: { '/project': false } });
      expect(isMcpEnabled('/project')).toBe(false);
    });

    it('falls back to clubhouse mode when all disabled', () => {
      vi.mocked(isClubhouseModeEnabled).mockReturnValue(true);
      expect(isMcpEnabled()).toBe(true);
    });

    it('clubhouse mode fallback receives project path', () => {
      vi.mocked(isClubhouseModeEnabled).mockReturnValue(false);
      isMcpEnabled('/my-project');
      expect(isClubhouseModeEnabled).toHaveBeenCalledWith('/my-project');
    });
  });
});
