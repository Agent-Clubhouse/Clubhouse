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
import { getSettings, saveSettings } from './orchestrator-settings';

describe('orchestrator-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result).toEqual({ enabled: ['claude-code'] });
    });

    it('returns saved settings from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: ['claude-code', 'copilot'] }),
      );
      const result = getSettings();
      expect(result.enabled).toEqual(['claude-code', 'copilot']);
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result).toEqual({ enabled: ['claude-code'] });
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: [] }));
      const result = getSettings();
      expect(result.enabled).toEqual([]);
    });

    it('handles empty enabled array', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: [] }));
      const result = getSettings();
      expect(result.enabled).toEqual([]);
    });

    it('reads from the correct file path', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        '/tmp/test-app/orchestrator-settings.json',
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', () => {
      saveSettings({ enabled: ['claude-code', 'copilot'] });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('orchestrator-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.enabled).toEqual(['claude-code', 'copilot']);
    });

    it('round-trips: saved settings can be read back', () => {
      const settings = { enabled: ['provider-a', 'provider-b'] };
      saveSettings(settings);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can save empty enabled list', () => {
      saveSettings({ enabled: [] });
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.enabled).toEqual([]);
    });
  });
});
