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
import {
  getSettings,
  saveSettings,
  autoDetectDefaults,
  resolveHookServerEnabled,
  isHookServerEnabled,
  setHookServerEnabled,
} from './orchestrator-settings';

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

  describe('hook server preferences', () => {
    describe('resolveHookServerEnabled (default resolution)', () => {
      it('defaults claude-code ON when no explicit preference', () => {
        expect(resolveHookServerEnabled({ enabled: [] }, 'claude-code')).toBe(true);
      });

      it('defaults every other orchestrator OFF when no explicit preference', () => {
        expect(resolveHookServerEnabled({ enabled: [] }, 'copilot-cli')).toBe(false);
        expect(resolveHookServerEnabled({ enabled: [] }, 'codex-cli')).toBe(false);
        expect(resolveHookServerEnabled({ enabled: [] }, 'future-orchestrator')).toBe(false);
      });

      it('honours an explicit preference over the default', () => {
        const settings = { enabled: [], hookServerEnabled: { 'claude-code': false, 'copilot-cli': true } };
        expect(resolveHookServerEnabled(settings, 'claude-code')).toBe(false);
        expect(resolveHookServerEnabled(settings, 'copilot-cli')).toBe(true);
      });
    });

    describe('isHookServerEnabled (from persisted store)', () => {
      it('reads the default when nothing is persisted', () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
        expect(isHookServerEnabled('claude-code')).toBe(true);
        expect(isHookServerEnabled('copilot-cli')).toBe(false);
      });

      it('reads an explicit persisted preference', () => {
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ enabled: ['claude-code', 'copilot-cli'], hookServerEnabled: { 'copilot-cli': true } }),
        );
        expect(isHookServerEnabled('copilot-cli')).toBe(true);
      });
    });

    describe('setHookServerEnabled (merge, no clobber)', () => {
      it('persists a preference without clobbering enabled / other prefs', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue(
          JSON.stringify({ enabled: ['claude-code', 'copilot-cli'], hookServerEnabled: { 'claude-code': true } }),
        );
        const updated = await setHookServerEnabled('copilot-cli', true);
        expect(updated.enabled).toEqual(['claude-code', 'copilot-cli']);
        expect(updated.hookServerEnabled).toEqual({ 'claude-code': true, 'copilot-cli': true });

        const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
        expect(written.enabled).toEqual(['claude-code', 'copilot-cli']);
        expect(written.hookServerEnabled).toEqual({ 'claude-code': true, 'copilot-cli': true });
      });
    });

    it('saving enabled via merge does not lose a previously-saved hook preference', async () => {
      // Seed disk with a hook preference, then simulate the renderer saving just `enabled`.
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: ['claude-code'], hookServerEnabled: { 'copilot-cli': true } }),
      );
      // The app-handler does updateSettings((cur) => ({ ...cur, ...partial })); mirror that here.
      const { updateSettings } = await import('./orchestrator-settings');
      const updated = await updateSettings((cur) => ({ ...cur, enabled: ['claude-code', 'copilot-cli'] }));
      expect(updated.hookServerEnabled).toEqual({ 'copilot-cli': true });
      expect(updated.enabled).toEqual(['claude-code', 'copilot-cli']);
    });
  });

  describe('autoDetectDefaults', () => {
    function makeProvider(id: string, available: boolean) {
      return {
        id,
        checkAvailability: vi.fn(async () => ({ available })),
      };
    }

    it('enables all available providers on fresh install', async () => {
      // No settings file on disk
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      await autoDetectDefaults([
        makeProvider('claude-code', true),
        makeProvider('copilot-cli', true),
        makeProvider('codex-cli', false),
      ]);

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toEqual(['claude-code', 'copilot-cli']);
      expect(written.autoDetected).toBe(true);
    });

    it('enables only the single available provider on fresh install', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      await autoDetectDefaults([
        makeProvider('claude-code', false),
        makeProvider('copilot-cli', true),
        makeProvider('codex-cli', false),
      ]);

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toEqual(['copilot-cli']);
      expect(written.autoDetected).toBe(true);
    });

    it('falls back to claude-code when no providers are found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      await autoDetectDefaults([
        makeProvider('claude-code', false),
        makeProvider('copilot-cli', false),
        makeProvider('codex-cli', false),
      ]);

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toEqual(['claude-code']);
      expect(written.autoDetected).toBe(true);
    });

    it('preserves existing settings file and stamps autoDetected flag', async () => {
      // Settings file exists on disk
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: ['claude-code'] }),
      );

      const providers = [
        makeProvider('claude-code', true),
        makeProvider('copilot-cli', true),
      ];
      await autoDetectDefaults(providers);

      // Should NOT have probed providers
      expect(providers[0].checkAvailability).not.toHaveBeenCalled();
      expect(providers[1].checkAvailability).not.toHaveBeenCalled();

      // Should have saved with the original enabled list plus autoDetected flag
      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toEqual(['claude-code']);
      expect(written.autoDetected).toBe(true);
    });

    it('does not re-run when autoDetected is already true', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ enabled: ['claude-code'], autoDetected: true }),
      );

      await autoDetectDefaults([makeProvider('copilot-cli', true)]);

      // Should not write anything
      expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
    });

    it('handles provider checkAvailability throwing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      const throwingProvider = {
        id: 'broken',
        checkAvailability: vi.fn(async () => { throw new Error('crash'); }),
      };

      await autoDetectDefaults([
        makeProvider('claude-code', true),
        throwingProvider,
      ]);

      const written = JSON.parse(vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string);
      expect(written.enabled).toEqual(['claude-code']);
      expect(written.autoDetected).toBe(true);
    });
  });
});
