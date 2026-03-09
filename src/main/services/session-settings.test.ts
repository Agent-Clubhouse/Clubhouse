import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
}));

import * as fs from 'fs';
import { getSettings, saveSettings, shouldPromptForName } from './session-settings';

describe('session-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result).toEqual({ promptForName: false });
    });

    it('returns saved settings from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      const result = getSettings();
      expect(result.promptForName).toBe(true);
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result.promptForName).toBe(false);
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        projectOverrides: { '/project': true },
      }));
      const result = getSettings();
      expect(result.promptForName).toBe(false);
      expect(result.projectOverrides).toEqual({ '/project': true });
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
        path.join('/tmp/test-app', 'session-settings.json'),
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', () => {
      saveSettings({ promptForName: true });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('session-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.promptForName).toBe(true);
    });

    it('round-trips: saved settings can be read back', () => {
      const settings = { promptForName: true };
      saveSettings(settings);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save settings with projectOverrides', () => {
      const settings = {
        promptForName: false,
        projectOverrides: { '/project': true },
      };
      saveSettings(settings);
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.projectOverrides).toEqual({ '/project': true });
    });
  });

  describe('shouldPromptForName', () => {
    it('returns default (false) when no file exists and no project path', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(shouldPromptForName()).toBe(false);
    });

    it('returns global setting when no project path given', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      expect(shouldPromptForName()).toBe(true);
    });

    it('returns global setting when project path has no override', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      expect(shouldPromptForName('/some/unknown/project')).toBe(true);
    });

    it('returns project override when it exists (true overrides false default)', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: false,
          projectOverrides: { '/my/project': true },
        }),
      );
      expect(shouldPromptForName('/my/project')).toBe(true);
    });

    it('returns project override when it exists (false overrides true default)', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: true,
          projectOverrides: { '/my/project': false },
        }),
      );
      expect(shouldPromptForName('/my/project')).toBe(false);
    });

    it('returns global setting when projectOverrides is undefined', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true }),
      );
      expect(shouldPromptForName('/any/project')).toBe(true);
    });

    it('returns global setting when projectOverrides is empty', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ promptForName: true, projectOverrides: {} }),
      );
      expect(shouldPromptForName('/any/project')).toBe(true);
    });

    it('matches exact project path only', () => {
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

    it('handles undefined project path with overrides present', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: true,
          projectOverrides: { '/my/project': false },
        }),
      );
      expect(shouldPromptForName(undefined)).toBe(true);
    });

    it('handles empty string project path (falsy) by returning global setting', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          promptForName: true,
          projectOverrides: { '': false },
        }),
      );
      // Empty string is falsy, so it should skip override lookup and return global
      expect(shouldPromptForName('')).toBe(true);
    });

    it('differentiates between multiple project overrides', () => {
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
