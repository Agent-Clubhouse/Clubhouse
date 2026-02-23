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
import { getSettings, saveSettings } from './clipboard-settings';

describe('clipboard-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      // Default depends on platform: true on win32, false otherwise
      const expectedDefault = process.platform === 'win32';
      expect(result).toEqual({ clipboardCompat: expectedDefault });
    });

    it('returns saved settings from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ clipboardCompat: true }),
      );
      const result = getSettings();
      expect(result.clipboardCompat).toBe(true);
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      const expectedDefault = process.platform === 'win32';
      expect(result.clipboardCompat).toBe(expectedDefault);
    });

    it('can override default to true', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ clipboardCompat: true }));
      const result = getSettings();
      expect(result.clipboardCompat).toBe(true);
    });

    it('can override default to false', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ clipboardCompat: false }));
      const result = getSettings();
      expect(result.clipboardCompat).toBe(false);
    });

    it('reads from the correct file path', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        '/tmp/test-app/clipboard-settings.json',
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', () => {
      saveSettings({ clipboardCompat: true });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('clipboard-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.clipboardCompat).toBe(true);
    });

    it('round-trips: saved settings can be read back', () => {
      const settings = { clipboardCompat: true };
      saveSettings(settings);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save disabled clipboard compat', () => {
      saveSettings({ clipboardCompat: false });
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.clipboardCompat).toBe(false);
    });
  });
});
