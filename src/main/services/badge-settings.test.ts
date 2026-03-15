import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  promises: {
    writeFile: vi.fn(async () => {}),
  },
}));

import * as fs from 'fs';
import { resetAllSettingsStoresForTests } from './settings-store';
import { getSettings, saveSettings } from './badge-settings';

describe('badge-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result).toEqual({
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
      });
    });

    it('returns saved settings from file', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: false, pluginBadges: false, projectRailBadges: false }),
      );
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.pluginBadges).toBe(false);
      expect(result.projectRailBadges).toBe(false);
    });

    it('returns defaults on corrupt JSON', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result.enabled).toBe(true);
      expect(result.pluginBadges).toBe(true);
      expect(result.projectRailBadges).toBe(true);
    });

    it('merges partial settings with defaults', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: false }));
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.pluginBadges).toBe(true);
      expect(result.projectRailBadges).toBe(true);
    });

    it('preserves projectOverrides when present', async () => {
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

    it('does not include projectOverrides by default', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result.projectOverrides).toBeUndefined();
    });

    it('reads from the correct file path', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'badge-settings.json'),
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', async () => {
      await saveSettings({ enabled: false, pluginBadges: true, projectRailBadges: false });
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledWith(
        expect.stringContaining('badge-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toBe(false);
      expect(written.pluginBadges).toBe(true);
      expect(written.projectRailBadges).toBe(false);
    });

    it('round-trips: saved settings can be read back', async () => {
      const settings = { enabled: false, pluginBadges: false, projectRailBadges: true };
      await saveSettings(settings);
      const written = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save settings with projectOverrides', async () => {
      const settings = {
        enabled: true,
        pluginBadges: true,
        projectRailBadges: true,
        projectOverrides: { '/project': { enabled: false, pluginBadges: false } },
      };
      await saveSettings(settings);
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.projectOverrides).toEqual({ '/project': { enabled: false, pluginBadges: false } });
    });

    it('can toggle individual badge types independently', async () => {
      await saveSettings({ enabled: true, pluginBadges: false, projectRailBadges: true });
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.pluginBadges).toBe(false);
      expect(written.projectRailBadges).toBe(true);
    });
  });
});
