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
import { getSettings, saveSettings, shouldPromptForName } from './session-settings';

describe('session-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result).toEqual({ promptForName: false });
    });

    it('returns saved settings from file', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      const result = getSettings();
      expect(result.promptForName).toBe(true);
    });

    it('returns defaults on corrupt JSON', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result.promptForName).toBe(false);
    });

    it('merges partial settings with defaults', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        projectOverrides: { '/project': true },
      }));
      const result = getSettings();
      expect(result.promptForName).toBe(false);
      expect(result.projectOverrides).toEqual({ '/project': true });
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
        path.join('/tmp/test-app', 'session-settings.json'),
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', async () => {
      await saveSettings({ promptForName: true });
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledWith(
        expect.stringContaining('session-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.promptForName).toBe(true);
    });

    it('round-trips: saved settings can be read back', async () => {
      const settings = { promptForName: true };
      await saveSettings(settings);
      const written = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save settings with projectOverrides', async () => {
      const settings = {
        promptForName: false,
        projectOverrides: { '/project': true },
      };
      await saveSettings(settings);
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.projectOverrides).toEqual({ '/project': true });
    });
  });

  describe('shouldPromptForName', () => {
    it('returns default (false) when no file exists and no project path', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(shouldPromptForName()).toBe(false);
    });

    it('returns global setting when no project path given', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      expect(shouldPromptForName()).toBe(true);
    });

    it('returns global setting when project path has no override', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      expect(shouldPromptForName('/some/unknown/project')).toBe(true);
    });

    it('returns project override when it exists (true overrides false default)', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: false,
          projectOverrides: { '/my/project': true },
        }),
      );
      expect(shouldPromptForName('/my/project')).toBe(true);
    });

    it('returns project override when it exists (false overrides true default)', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: true,
          projectOverrides: { '/my/project': false },
        }),
      );
      expect(shouldPromptForName('/my/project')).toBe(false);
    });

    it('returns global setting when projectOverrides is undefined', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      expect(shouldPromptForName('/any/project')).toBe(true);
    });

    it('returns global setting when projectOverrides is empty', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true, projectOverrides: {} }),
      );
      expect(shouldPromptForName('/any/project')).toBe(true);
    });

    it('matches exact project path only', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: false,
          projectOverrides: { '/my/project': true },
        }),
      );
      // Exact match
      expect(shouldPromptForName('/my/project')).toBe(true);
      // Subpath should NOT match — falls back to global
      expect(shouldPromptForName('/my/project/sub')).toBe(false);
      // Parent should NOT match — falls back to global
      expect(shouldPromptForName('/my')).toBe(false);
    });

    it('handles undefined project path with overrides present', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: true,
          projectOverrides: { '/my/project': false },
        }),
      );
      expect(shouldPromptForName(undefined)).toBe(true);
    });

    it('handles empty string project path (falsy) by returning global setting', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: true,
          projectOverrides: { '': false },
        }),
      );
      // Empty string is falsy, so it should skip override lookup and return global
      expect(shouldPromptForName('')).toBe(true);
    });

    it('differentiates between multiple project overrides', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: false,
          projectOverrides: {
            '/project-a': true,
            '/project-b': false,
          },
        }),
      );
      expect(shouldPromptForName('/project-a')).toBe(true);
      expect(shouldPromptForName('/project-b')).toBe(false);
      expect(shouldPromptForName('/project-c')).toBe(false); // global default
    });
  });
});
