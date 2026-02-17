import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBadgeSettingsStore } from './badgeSettingsStore';

// Mock the window.clubhouse API
const mockGetBadgeSettings = vi.fn();
const mockSaveBadgeSettings = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        getBadgeSettings: mockGetBadgeSettings,
        saveBadgeSettings: mockSaveBadgeSettings,
      },
    },
  },
  writable: true,
});

function getState() {
  return useBadgeSettingsStore.getState();
}

function reset() {
  useBadgeSettingsStore.setState({
    enabled: false,
    pluginBadges: true,
    projectRailBadges: true,
    projectOverrides: {},
  });
  vi.clearAllMocks();
}

describe('badgeSettingsStore', () => {
  beforeEach(() => {
    reset();
  });

  describe('loadSettings', () => {
    it('loads settings from IPC', async () => {
      mockGetBadgeSettings.mockResolvedValue({
        enabled: false,
        pluginBadges: false,
        projectRailBadges: true,
        projectOverrides: { proj1: { enabled: true } },
      });
      await getState().loadSettings();
      expect(getState().enabled).toBe(false);
      expect(getState().pluginBadges).toBe(false);
      expect(getState().projectRailBadges).toBe(true);
      expect(getState().projectOverrides).toEqual({ proj1: { enabled: true } });
    });

    it('uses defaults when IPC returns null', async () => {
      mockGetBadgeSettings.mockResolvedValue(null);
      await getState().loadSettings();
      expect(getState().enabled).toBe(false);
      expect(getState().pluginBadges).toBe(true);
      expect(getState().projectRailBadges).toBe(true);
    });

    it('keeps defaults on error', async () => {
      mockGetBadgeSettings.mockRejectedValue(new Error('fail'));
      await getState().loadSettings();
      expect(getState().enabled).toBe(false);
    });
  });

  describe('saveAppSettings', () => {
    it('updates app-level settings and persists', async () => {
      await getState().saveAppSettings({ enabled: false });
      expect(getState().enabled).toBe(false);
      expect(mockSaveBadgeSettings).toHaveBeenCalledWith({
        enabled: false,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: {},
      });
    });

    it('reverts on save failure', async () => {
      useBadgeSettingsStore.setState({ enabled: true });
      mockSaveBadgeSettings.mockImplementation(() => { throw new Error('fail'); });
      await getState().saveAppSettings({ enabled: false });
      // Should revert to previous
      expect(getState().enabled).toBe(true);
    });
  });

  describe('getProjectSettings', () => {
    it('returns app defaults when no project override exists', () => {
      const settings = getState().getProjectSettings('proj1');
      expect(settings).toEqual({ enabled: false, pluginBadges: true, projectRailBadges: true });
    });

    it('merges project overrides with app defaults', () => {
      useBadgeSettingsStore.setState({
        enabled: true,
        projectOverrides: { proj1: { pluginBadges: false } },
      });
      const settings = getState().getProjectSettings('proj1');
      expect(settings).toEqual({ enabled: true, pluginBadges: false, projectRailBadges: true });
    });

    it('fully overrides all settings when all specified', () => {
      useBadgeSettingsStore.setState({
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: { proj1: { enabled: false, pluginBadges: false, projectRailBadges: false } },
      });
      const settings = getState().getProjectSettings('proj1');
      expect(settings).toEqual({ enabled: false, pluginBadges: false, projectRailBadges: false });
    });

    it('returns app defaults for a different project', () => {
      useBadgeSettingsStore.setState({
        enabled: false,
        projectOverrides: { proj1: { enabled: true } },
      });
      const settings = getState().getProjectSettings('proj2');
      expect(settings.enabled).toBe(false);
    });
  });

  describe('setProjectOverride', () => {
    it('sets a project-level override and persists', async () => {
      await getState().setProjectOverride('proj1', { pluginBadges: false });
      expect(getState().projectOverrides).toEqual({ proj1: { pluginBadges: false } });
      expect(mockSaveBadgeSettings).toHaveBeenCalled();
    });

    it('merges with existing overrides for the same project', async () => {
      await getState().setProjectOverride('proj1', { pluginBadges: false });
      await getState().setProjectOverride('proj1', { projectRailBadges: false });
      expect(getState().projectOverrides.proj1).toEqual({
        pluginBadges: false,
        projectRailBadges: false,
      });
    });

    it('reverts on save failure', async () => {
      mockSaveBadgeSettings.mockImplementation(() => { throw new Error('fail'); });
      await getState().setProjectOverride('proj1', { enabled: false });
      expect(getState().projectOverrides).toEqual({});
    });
  });

  describe('clearProjectOverride', () => {
    it('removes project override and persists', async () => {
      useBadgeSettingsStore.setState({
        projectOverrides: { proj1: { enabled: false }, proj2: { pluginBadges: false } },
      });
      await getState().clearProjectOverride('proj1');
      expect(getState().projectOverrides).toEqual({ proj2: { pluginBadges: false } });
      expect(mockSaveBadgeSettings).toHaveBeenCalled();
    });

    it('does nothing for non-existent project', async () => {
      await getState().clearProjectOverride('nonexistent');
      expect(getState().projectOverrides).toEqual({});
    });

    it('reverts on save failure', async () => {
      useBadgeSettingsStore.setState({
        projectOverrides: { proj1: { enabled: false } },
      });
      mockSaveBadgeSettings.mockImplementation(() => { throw new Error('fail'); });
      await getState().clearProjectOverride('proj1');
      expect(getState().projectOverrides).toEqual({ proj1: { enabled: false } });
    });
  });
});
