import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import { getSettings, saveSettings } from './theme-service';

const SETTINGS_PATH = '/tmp/clubhouse-test-userData/theme-settings.json';

describe('theme-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns default catppuccin-mocha when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = getSettings();
      expect(result).toEqual({ themeId: 'catppuccin-mocha' });
    });

    it('returns saved themeId from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ themeId: 'dracula' })
      );
      const result = getSettings();
      expect(result.themeId).toBe('dracula');
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      const result = getSettings();
      expect(result).toEqual({ themeId: 'catppuccin-mocha' });
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
      const result = getSettings();
      expect(result.themeId).toBe('catppuccin-mocha');
    });
  });

  describe('saveSettings', () => {
    it('writes JSON to the settings path', () => {
      saveSettings({ themeId: 'nord' });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
      const [path, data] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
      expect(path).toBe(SETTINGS_PATH);
      const parsed = JSON.parse(data);
      expect(parsed.themeId).toBe('nord');
    });

    it('persists each theme ID correctly', () => {
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
        saveSettings({ themeId: id });
        const [, data] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
        expect(JSON.parse(data).themeId).toBe(id);
      }
    });
  });
});
