import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { isClubhouseModeEnabled, setProjectOverride, clearProjectOverride, getSettings, saveSettings } from './clubhouse-mode-settings';

describe('clubhouse-mode-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('isClubhouseModeEnabled', () => {
    it('returns false when global disabled and no project override (default)', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(isClubhouseModeEnabled('/some/project')).toBe(false);
    });

    it('returns true when global enabled and no project override', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      expect(isClubhouseModeEnabled('/some/project')).toBe(true);
    });

    it('returns project override when present, regardless of global', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: false,
        projectOverrides: { '/my/project': true },
      }));
      expect(isClubhouseModeEnabled('/my/project')).toBe(true);
    });

    it('project override false overrides global enabled', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/my/project': false },
      }));
      expect(isClubhouseModeEnabled('/my/project')).toBe(false);
    });

    it('falls back to global when project has no override', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/other/project': false },
      }));
      expect(isClubhouseModeEnabled('/my/project')).toBe(true);
    });

    it('handles undefined projectPath by using global default', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      expect(isClubhouseModeEnabled()).toBe(true);
      expect(isClubhouseModeEnabled(undefined)).toBe(true);
    });

    it('handles multiple project overrides independently', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: false,
        projectOverrides: {
          '/project-a': true,
          '/project-b': false,
          '/project-c': true,
        },
      }));
      expect(isClubhouseModeEnabled('/project-a')).toBe(true);
      expect(isClubhouseModeEnabled('/project-b')).toBe(false);
      expect(isClubhouseModeEnabled('/project-c')).toBe(true);
      expect(isClubhouseModeEnabled('/project-d')).toBe(false); // no override → global
    });
  });

  describe('setProjectOverride', () => {
    it('saves project override while preserving existing settings', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/existing': false },
      }));

      await setProjectOverride('/new-project', true);

      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toBe(true);
      expect(written.projectOverrides).toEqual({
        '/existing': false,
        '/new-project': true,
      });
    });

    it('creates projectOverrides when none exist', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: false }));

      await setProjectOverride('/project', true);

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.projectOverrides).toEqual({ '/project': true });
    });
  });

  describe('clearProjectOverride', () => {
    it('removes a single project override', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/project-a': true, '/project-b': false },
      }));

      await clearProjectOverride('/project-a');

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.projectOverrides).toEqual({ '/project-b': false });
    });

    it('sets projectOverrides to undefined when last override removed', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        projectOverrides: { '/only-project': true },
      }));

      await clearProjectOverride('/only-project');

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.projectOverrides).toBeUndefined();
    });

    it('no-ops when no projectOverrides exist', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));

      await clearProjectOverride('/project');

      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('getSettings defaults', () => {
    it('returns disabled by default when file does not exist', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const settings = getSettings();
      expect(settings.enabled).toBe(false);
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', async () => {
      await saveSettings({ enabled: true, projectOverrides: { '/p': true } });

      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('clubhouse-mode-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toBe(true);
    });
  });
});
