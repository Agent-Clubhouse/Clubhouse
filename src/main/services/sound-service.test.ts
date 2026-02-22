import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock electron before importing
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === 'userData') return '/tmp/test-userdata';
      if (key === 'home') return '/tmp/test-home';
      return '/tmp/test';
    }),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBoxSync: vi.fn(),
  },
}));

vi.mock('fs');
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return { ...actual };
});

import {
  getSettings,
  saveSettings,
  listSoundPacks,
  getAllSoundPacks,
  registerPluginSounds,
  unregisterPluginSounds,
  deleteSoundPack,
  getSoundData,
  resolveActivePack,
} from './sound-service';

describe('sound-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: readFileSync throws (file not found)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  });

  describe('getSettings / saveSettings', () => {
    it('returns defaults when no settings file exists', () => {
      const settings = getSettings();
      expect(settings.activePack).toBeNull();
      expect(settings.eventSettings['agent-done'].enabled).toBe(true);
      expect(settings.eventSettings['agent-done'].volume).toBe(80);
      expect(settings.eventSettings.error.enabled).toBe(true);
      expect(settings.eventSettings.permission.enabled).toBe(true);
      expect(settings.eventSettings.notification.enabled).toBe(true);
    });

    it('saves settings to file', () => {
      const settings = getSettings();
      settings.activePack = 'my-pack';
      saveSettings(settings);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('sound-settings.json'),
        expect.stringContaining('"my-pack"'),
        'utf-8',
      );
    });
  });

  describe('listSoundPacks', () => {
    it('returns empty array when sounds directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(listSoundPacks()).toEqual([]);
    });

    it('discovers packs with valid sound files', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds') || s.endsWith('/my-pack')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds')) {
          return [
            { name: 'my-pack', isDirectory: () => true } as unknown as fs.Dirent,
          ] as unknown as fs.Dirent[];
        }
        if (s.endsWith('/my-pack')) {
          return ['agent-done.mp3', 'error.wav', 'readme.txt'] as unknown as string[];
        }
        return [];
      });

      const packs = listSoundPacks();
      expect(packs).toHaveLength(1);
      expect(packs[0].id).toBe('my-pack');
      expect(packs[0].name).toBe('my-pack');
      expect(packs[0].sounds['agent-done']).toBe('agent-done.mp3');
      expect(packs[0].sounds['error']).toBe('error.wav');
      expect(packs[0].source).toBe('user');
    });

    it('reads name from manifest.json if available', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds') || s.endsWith('/custom') || s.includes('manifest.json')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds')) {
          return [
            { name: 'custom', isDirectory: () => true } as unknown as fs.Dirent,
          ] as unknown as fs.Dirent[];
        }
        if (s.endsWith('/custom')) {
          return ['agent-done.ogg', 'manifest.json'] as unknown as string[];
        }
        return [];
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.includes('manifest.json')) return JSON.stringify({ name: 'Custom Pack', author: 'Test' });
        throw new Error('ENOENT');
      });

      const packs = listSoundPacks();
      expect(packs[0].name).toBe('Custom Pack');
      expect(packs[0].author).toBe('Test');
    });

    it('skips directories with no valid sound files', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        return s.endsWith('/sounds') || s.endsWith('/empty-dir');
      });
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds')) {
          return [
            { name: 'empty-dir', isDirectory: () => true } as unknown as fs.Dirent,
          ] as unknown as fs.Dirent[];
        }
        if (s.endsWith('/empty-dir')) {
          return ['readme.txt', 'notes.md'] as unknown as string[];
        }
        return [];
      });

      expect(listSoundPacks()).toEqual([]);
    });
  });

  describe('registerPluginSounds / unregisterPluginSounds', () => {
    it('registers and unregisters plugin sounds', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).replace(/\\/g, '/').endsWith('/sounds');
      });
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        return ['agent-done.mp3', 'error.mp3'] as unknown as string[];
      });

      const pack = registerPluginSounds('test-plugin', '/plugins/test-plugin', 'Test Plugin Sounds');
      expect(pack).not.toBeNull();
      expect(pack!.id).toBe('plugin:test-plugin');
      expect(pack!.name).toBe('Test Plugin Sounds');
      expect(pack!.source).toBe('plugin');
      expect(pack!.pluginId).toBe('test-plugin');

      // Should appear in getAllSoundPacks
      const allPacks = getAllSoundPacks();
      expect(allPacks.some((p) => p.id === 'plugin:test-plugin')).toBe(true);

      // Unregister
      unregisterPluginSounds('test-plugin');
      const afterUnregister = getAllSoundPacks();
      expect(afterUnregister.some((p) => p.id === 'plugin:test-plugin')).toBe(false);
    });

    it('returns null when plugin has no sounds directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const pack = registerPluginSounds('no-sounds', '/plugins/no-sounds');
      expect(pack).toBeNull();
    });
  });

  describe('deleteSoundPack', () => {
    it('deletes a user sound pack', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.rmSync).mockImplementation(() => {});
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = deleteSoundPack('my-pack');
      expect(result).toBe(true);
      expect(fs.rmSync).toHaveBeenCalled();
    });

    it('refuses to delete plugin packs', () => {
      expect(deleteSoundPack('plugin:test')).toBe(false);
    });

    it('returns false for non-existent packs', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(deleteSoundPack('nonexistent')).toBe(false);
    });
  });

  describe('getSoundData', () => {
    it('returns base64 data URL for existing sound file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['agent-done.mp3'] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-audio'));

      const data = getSoundData('my-pack', 'agent-done');
      expect(data).toMatch(/^data:audio\/mpeg;base64,/);
    });

    it('returns null when pack directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(getSoundData('missing', 'agent-done')).toBeNull();
    });

    it('returns null when event sound file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['error.mp3'] as unknown as fs.Dirent[]);

      expect(getSoundData('my-pack', 'agent-done')).toBeNull();
    });
  });

  describe('resolveActivePack', () => {
    it('returns global active pack when no project override', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ activePack: 'global-pack', eventSettings: {} }),
      );
      expect(resolveActivePack()).toBe('global-pack');
    });

    it('returns project override when set', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activePack: 'global-pack',
          eventSettings: {},
          projectOverrides: { 'proj-1': { activePack: 'project-pack' } },
        }),
      );
      expect(resolveActivePack('proj-1')).toBe('project-pack');
    });

    it('falls back to global when project has no override', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activePack: 'global-pack',
          eventSettings: {},
          projectOverrides: {},
        }),
      );
      expect(resolveActivePack('proj-1')).toBe('global-pack');
    });
  });
});
