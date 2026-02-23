import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
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
import { getSettings, saveSettings } from './annex-settings';

describe('annex-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.deviceName).toBe(`Clubhouse on ${os.hostname()}`);
    });

    it('returns saved settings from file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: true, deviceName: 'My Device' }),
      );
      const result = getSettings();
      expect(result.enabled).toBe(true);
      expect(result.deviceName).toBe('My Device');
    });

    it('returns defaults on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.deviceName).toBe(`Clubhouse on ${os.hostname()}`);
    });

    it('merges partial settings with defaults', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enabled: true }));
      const result = getSettings();
      expect(result.enabled).toBe(true);
      expect(result.deviceName).toBe(`Clubhouse on ${os.hostname()}`);
    });

    it('preserves custom device name when only enabled changes', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ deviceName: 'Custom Name' }),
      );
      const result = getSettings();
      expect(result.enabled).toBe(false);
      expect(result.deviceName).toBe('Custom Name');
    });

    it('reads from the correct file path', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'annex-settings.json'),
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', () => {
      saveSettings({ enabled: true, deviceName: 'Test Device' });
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('annex-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.enabled).toBe(true);
      expect(written.deviceName).toBe('Test Device');
    });

    it('round-trips: saved settings can be read back', () => {
      const settings = { enabled: true, deviceName: 'Round Trip Device' };
      saveSettings(settings);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can disable annex', () => {
      saveSettings({ enabled: false, deviceName: 'My Device' });
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.enabled).toBe(false);
    });
  });
});
