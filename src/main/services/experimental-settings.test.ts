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
import { getSettings, saveSettings, migrateExperimentalSettings } from './experimental-settings';
import { STRUCTURED_MODE_REMOVED_NOTICE_KEY } from '../../shared/types';

describe('experimental-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('migrateExperimentalSettings', () => {
    it('drops structuredMode: true and sets the removal notice key', () => {
      expect(migrateExperimentalSettings({ structuredMode: true, otherFlag: true })).toEqual({
        otherFlag: true,
        [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true,
      });
    });

    it('drops structuredMode: false without setting the notice key', () => {
      const migrated = migrateExperimentalSettings({ structuredMode: false, otherFlag: false });
      expect(migrated).toEqual({ otherFlag: false });
      expect(migrated).not.toHaveProperty(STRUCTURED_MODE_REMOVED_NOTICE_KEY);
    });

    it('leaves settings without structuredMode untouched', () => {
      expect(migrateExperimentalSettings({ otherFlag: true })).toEqual({ otherFlag: true });
      expect(migrateExperimentalSettings({})).toEqual({});
    });

    it('preserves an existing notice key that has not been acknowledged yet', () => {
      expect(migrateExperimentalSettings({ [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true })).toEqual({
        [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: true,
      });
    });

    it('does not mutate its input', () => {
      const raw = { structuredMode: true };
      migrateExperimentalSettings(raw);
      expect(raw).toEqual({ structuredMode: true });
    });
  });

  describe('store wiring', () => {
    it('applies the migration when loading settings from disk', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ structuredMode: true, otherFlag: true }));
      const settings = getSettings();
      expect(settings).not.toHaveProperty('structuredMode');
      expect(settings[STRUCTURED_MODE_REMOVED_NOTICE_KEY]).toBe(true);
      expect(settings.otherFlag).toBe(true);
    });

    it('returns empty defaults when the file does not exist', () => {
      expect(getSettings()).toEqual({});
    });

    it('persists settings without the legacy key once saved', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ structuredMode: true }));
      const { [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: _notice, ...rest } = getSettings();
      await saveSettings(rest);

      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('experimental-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written).toEqual({});
    });
  });
});
