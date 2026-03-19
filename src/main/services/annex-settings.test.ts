import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
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
import { getSettings, saveSettings } from './annex-settings';

describe('annex-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();
  });

  describe('getSettings', () => {
    it('returns defaults when no file exists', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = getSettings();
      expect(result.enableServer).toBe(false);
      expect(result.enableClient).toBe(false);
      expect(result.deviceName).toBe(`Clubhouse on ${os.hostname()}`);
    });

    it('returns saved settings from file', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enableServer: true, enableClient: true, deviceName: 'My Device' }),
      );
      const result = getSettings();
      expect(result.enableServer).toBe(true);
      expect(result.enableClient).toBe(true);
      expect(result.deviceName).toBe('My Device');
    });

    it('returns defaults on corrupt JSON', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = getSettings();
      expect(result.enableServer).toBe(false);
      expect(result.enableClient).toBe(false);
      expect(result.deviceName).toBe(`Clubhouse on ${os.hostname()}`);
    });

    it('merges partial settings with defaults', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ enableServer: true }));
      const result = getSettings();
      expect(result.enableServer).toBe(true);
      expect(result.enableClient).toBe(false);
      expect(result.deviceName).toBe(`Clubhouse on ${os.hostname()}`);
    });

    it('preserves custom device name when only toggles change', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ deviceName: 'Custom Name' }),
      );
      const result = getSettings();
      expect(result.enableServer).toBe(false);
      expect(result.enableClient).toBe(false);
      expect(result.deviceName).toBe('Custom Name');
    });

    it('reads from the correct file path', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      getSettings();
      expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
        path.join('/tmp/test-app', 'annex-settings.json'),
        'utf-8',
      );
    });
  });

  describe('saveSettings', () => {
    it('writes settings as JSON', async () => {
      await saveSettings({ enableServer: true, enableClient: true, deviceName: 'Test Device' });
      expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledWith(
        expect.stringContaining('annex-settings.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enableServer).toBe(true);
      expect(written.enableClient).toBe(true);
      expect(written.deviceName).toBe('Test Device');
    });

    it('round-trips: saved settings can be read back', async () => {
      const settings = { enableServer: true, enableClient: true, deviceName: 'Round Trip Device' };
      await saveSettings(settings);
      const written = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      expect(getSettings()).toEqual(settings);
    });

    it('can disable annex', async () => {
      await saveSettings({ enableServer: false, enableClient: false, deviceName: 'My Device' });
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enableServer).toBe(false);
      expect(written.enableClient).toBe(false);
    });
  });

  describe('legacy migration', () => {
    it('migrates legacy enabled: true to enableServer and enableClient', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: true, deviceName: 'Legacy Device' }),
      );
      const result = getSettings();
      expect(result.enableServer).toBe(true);
      expect(result.enableClient).toBe(true);
      expect(result.enabled).toBeUndefined();
      expect(result.deviceName).toBe('Legacy Device');
    });

    it('migrates legacy enabled: false to enableServer: false and enableClient: false', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: false, deviceName: 'Legacy Off' }),
      );
      const result = getSettings();
      expect(result.enableServer).toBe(false);
      expect(result.enableClient).toBe(false);
      expect(result.enabled).toBeUndefined();
    });

    it('enabled field always overrides enableServer/enableClient when present', async () => {
      // When legacy `enabled` is present, it takes precedence and is then stripped
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: true, enableServer: false, enableClient: true }),
      );
      const result = getSettings();
      expect(result.enableServer).toBe(true);
      expect(result.enableClient).toBe(true);
      expect(result.enabled).toBeUndefined();
    });

    it('strips enabled field on save even if passed', async () => {
      await saveSettings({ enabled: true, enableServer: true, enableClient: false, deviceName: 'Strip Test' } as any);
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toBeUndefined();
      // enabled: true overrides both to true during migration
      expect(written.enableServer).toBe(true);
      expect(written.enableClient).toBe(true);
    });

    it('can enable server without client', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enableServer: true, enableClient: false }),
      );
      const result = getSettings();
      expect(result.enableServer).toBe(true);
      expect(result.enableClient).toBe(false);
    });

    it('can enable client without server', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enableServer: false, enableClient: true }),
      );
      const result = getSettings();
      expect(result.enableServer).toBe(false);
      expect(result.enableClient).toBe(true);
    });

    it('round-trips new settings with both toggles correctly', async () => {
      const settings = { enableServer: true, enableClient: false, deviceName: 'Split Config' };
      await saveSettings(settings);
      const written = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      vi.mocked(fs.readFileSync).mockReturnValue(written);
      const result = getSettings();
      expect(result.enableServer).toBe(true);
      expect(result.enableClient).toBe(false);
      expect(result.deviceName).toBe('Split Config');
    });
  });
});
