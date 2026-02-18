import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import { getSettings, saveSettings } from './log-settings';

const SETTINGS_PATH = path.join(os.tmpdir(), 'clubhouse-test-userData', 'logging-settings.json');

describe('log-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = getSettings();
      expect(result).toEqual({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' });
    });

    it('returns saved settings from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: false, namespaces: { 'app:test': false } }),
      );
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.namespaces['app:test']).toBe(false);
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      const result = getSettings();
      expect(result).toEqual({ enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info' });
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: false }));
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.namespaces).toEqual({});
      expect(result.retention).toBe('medium');
      expect(result.minLogLevel).toBe('info');
    });
  });

  describe('saveSettings', () => {
    it('writes JSON to the settings path', () => {
      const settings = { enabled: false, namespaces: { 'app:ipc': false } };
      saveSettings(settings);
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
      const [path, data] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, string, string];
      expect(path).toBe(SETTINGS_PATH);
      const parsed = JSON.parse(data);
      expect(parsed.enabled).toBe(false);
      expect(parsed.namespaces['app:ipc']).toBe(false);
    });
  });
});
