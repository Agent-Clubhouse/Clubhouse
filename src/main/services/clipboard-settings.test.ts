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
import { getSettings, saveSettings } from './clipboard-settings';

describe('clipboard-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      // Default depends on platform: true on win32, false otherwise
      const expectedDefault = process.platform === 'win32';
      expect(result).toEqual({ clipboardCompat: expectedDefault });
    });

    it('returns saved settings from file', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ clipboardCompat: true }),
      );
      const result = getSettings();
      expect(result.clipboardCompat).toBe(true);
    });

    it('returns defaults on corrupt JSON', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      const expectedDefault = process.platform === 'win32';
      expect(result.clipboardCompat).toBe(expectedDefault);
    });

    it('can override default to true', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ clipboardCompat: true }));
      const result = getSettings();
      expect(result.clipboardCompat).toBe(true);
    });

    it('can override default to false', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ clipboardCompat: false }));
      const result = getSettings();
      expect(result.clipboardCompat).toBe(false);
    });

    it('reads from the correct file path', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'clipboard-settings.json'),
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', async () => {
      await saveSettings({ clipboardCompat: true });
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledWith(
        expect.stringContaining('clipboard-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.clipboardCompat).toBe(true);
    });

    it('round-trips: saved settings can be read back', async () => {
      const settings = { clipboardCompat: true };
      await saveSettings(settings);
      const written = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save disabled clipboard compat', async () => {
      await saveSettings({ clipboardCompat: false });
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.clipboardCompat).toBe(false);
    });
  });
});
