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

let cmStored: { enabled: boolean; projectOverrides?: Record<string, boolean> } = { enabled: false };

vi.mock('./clubhouse-mode-settings', () => ({
  isClubhouseModeEnabled: vi.fn(() => false),
  getSettings: vi.fn(() => ({ ...cmStored })),
}));

import { isMcpEnabled, isMcpEnabledForAny, saveSettings } from './mcp-settings';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { resetAllSettingsStoresForTests } from './settings-store';

describe('mcp-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
    cmStored = { enabled: false };
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

  describe('isMcpEnabledForAny', () => {
    it('returns false when everything is disabled', () => {
      expect(isMcpEnabledForAny()).toBe(false);
    });

    it('returns true when MCP global toggle is on', async () => {
      await saveSettings({ enabled: true });
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns true when any MCP project override is true', async () => {
      await saveSettings({ enabled: false, projectOverrides: { '/a': false, '/b': true } });
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns false when all MCP project overrides are false', async () => {
      await saveSettings({ enabled: false, projectOverrides: { '/a': false, '/b': false } });
      expect(isMcpEnabledForAny()).toBe(false);
    });

    it('returns true when Clubhouse Mode global toggle is on', () => {
      cmStored = { enabled: true };
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns true when any Clubhouse Mode project override is true', () => {
      cmStored = { enabled: false, projectOverrides: { '/x': false, '/y': true } };
      expect(isMcpEnabledForAny()).toBe(true);
    });

    it('returns false when all Clubhouse Mode project overrides are false', () => {
      cmStored = { enabled: false, projectOverrides: { '/x': false } };
      expect(isMcpEnabledForAny()).toBe(false);
    });
  });
});
