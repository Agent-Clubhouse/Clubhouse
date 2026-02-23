import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
}));

import * as fs from 'fs';
import { getSettings, saveSettings } from './badge-settings';

describe('badge-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result).toEqual({
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
      });
    });

    it('returns saved settings from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: false, pluginBadges: false, projectRailBadges: false }),
      );
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.pluginBadges).toBe(false);
      expect(result.projectRailBadges).toBe(false);
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result.enabled).toBe(true);
      expect(result.pluginBadges).toBe(true);
      expect(result.projectRailBadges).toBe(true);
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: false }));
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.pluginBadges).toBe(true);
      expect(result.projectRailBadges).toBe(true);
    });

    it('preserves projectOverrides when present', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: {
          '/my/project': { enabled: false },
        },
      }));
      const result = getSettings();
      expect(result.projectOverrides).toEqual({ '/my/project': { enabled: false } });
    });

    it('does not include projectOverrides by default', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result.projectOverrides).toBeUndefined();
    });

    it('reads from the correct file path', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        '/tmp/test-app/badge-settings.json',
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', () => {
      saveSettings({ enabled: false, pluginBadges: true, projectRailBadges: false });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('badge-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.enabled).toBe(false);
      expect(written.pluginBadges).toBe(true);
      expect(written.projectRailBadges).toBe(false);
    });

    it('round-trips: saved settings can be read back', () => {
      const settings = { enabled: false, pluginBadges: false, projectRailBadges: true };
      saveSettings(settings);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save settings with projectOverrides', () => {
      const settings = {
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: { '/project': { enabled: false, pluginBadges: false } },
      };
      saveSettings(settings);
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.projectOverrides).toEqual({ '/project': { enabled: false, pluginBadges: false } });
    });

    it('can toggle individual badge types independently', () => {
      saveSettings({ enabled: true, pluginBadges: false, projectRailBadges: true });
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.pluginBadges).toBe(false);
      expect(written.projectRailBadges).toBe(true);
    });
  });
});
