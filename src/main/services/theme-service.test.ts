import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  promises: {
    writeFile: vi.fn(async () => {}),
  },
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import { resetAllSettingsStoresForTests } from './settings-store';
import { getSettings, saveSettings } from './theme-service';

const SETTINGS_PATH = path.join(os.tmpdir(), 'clubhouse-test-userData', 'theme-settings.json');

describe('theme-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('getSettings', () => {
    it('returns default catppuccin-mocha when no file exists', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = getSettings();
      expect(result).toEqual({ themeId: 'catppuccin-mocha' });
    });

    it('returns saved themeId from file', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ themeId: 'dracula' })
      );
      const result = getSettings();
      expect(result.themeId).toBe('dracula');
    });

    it('returns defaults on corrupt JSON', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      const result = getSettings();
      expect(result).toEqual({ themeId: 'catppuccin-mocha' });
    });

    it('merges partial settings with defaults', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
      const result = getSettings();
      expect(result.themeId).toBe('catppuccin-mocha');
    });
  });

  describe('saveSettings', () => {
    it('writes JSON to the settings path', async () => {
      await saveSettings({ themeId: 'nord' });
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledTimes(1);
      const [path, data] = vi.mocked(fs.promises.writeFile).mock.calls[0] as [string, string, string];
      expect(path).toBe(SETTINGS_PATH);
      const parsed = JSON.parse(data);
      expect(parsed.themeId).toBe('nord');
    });

    it('persists each theme ID correctly', async () => {
      const themeIds = [
        'catppuccin-mocha',
        'catppuccin-latte',
        'solarized-dark',
        'terminal',
        'nord',
        'dracula',
        'tokyo-night',
        'gruvbox-dark',
      ] as const;

      for (const id of themeIds) {
        vi.clearAllMocks();
        await saveSettings({ themeId: id });
        const [, data] = vi.mocked(fs.promises.writeFile).mock.calls[0] as [string, string, string];
        expect(JSON.parse(data).themeId).toBe(id);
      }
    });
  });
});
