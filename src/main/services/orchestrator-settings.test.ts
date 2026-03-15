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
import { getSettings, saveSettings } from './orchestrator-settings';

describe('orchestrator-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result).toEqual({ enabled: ['claude-code'] });
    });

    it('returns saved settings from file', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: ['claude-code', 'copilot'] }),
      );
      const result = getSettings();
      expect(result.enabled).toEqual(['claude-code', 'copilot']);
    });

    it('returns defaults on corrupt JSON', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result).toEqual({ enabled: ['claude-code'] });
    });

    it('merges partial settings with defaults', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: [] }));
      const result = getSettings();
      expect(result.enabled).toEqual([]);
    });

    it('handles empty enabled array', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: [] }));
      const result = getSettings();
      expect(result.enabled).toEqual([]);
    });

    it('reads from the correct file path', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'orchestrator-settings.json'),
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', async () => {
      await saveSettings({ enabled: ['claude-code', 'copilot'] });
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledWith(
        expect.stringContaining('orchestrator-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toEqual(['claude-code', 'copilot']);
    });

    it('round-trips: saved settings can be read back', async () => {
      const settings = { enabled: ['provider-a', 'provider-b'] };
      await saveSettings(settings);
      const written = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save empty enabled list', async () => {
      await saveSettings({ enabled: [] });
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toEqual([]);
    });
  });
});
