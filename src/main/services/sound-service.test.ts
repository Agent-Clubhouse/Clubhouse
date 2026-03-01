import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

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

import {
  getSettings,
  saveSettings,
  listSoundPacks,
  getAllSoundPacks,
  registerPluginSounds,
  unregisterPluginSounds,
  deleteSoundPack,
  getSoundData,
  resolveSlotPack,
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
      expect(settings.slotAssignments).toEqual({});
      expect(settings.eventSettings['agent-done'].enabled).toBe(true);
      expect(settings.eventSettings['agent-done'].volume).toBe(80);
      expect(settings.eventSettings.error.enabled).toBe(true);
      expect(settings.eventSettings.permission.enabled).toBe(true);
      expect(settings.eventSettings['permission-granted'].enabled).toBe(true);
      expect(settings.eventSettings['permission-denied'].enabled).toBe(true);
      expect(settings.eventSettings['agent-wake'].enabled).toBe(true);
      expect(settings.eventSettings['agent-sleep'].enabled).toBe(true);
      expect(settings.eventSettings['agent-focus'].enabled).toBe(true);
      expect(settings.eventSettings.notification.enabled).toBe(true);
    });

    it('saves settings to file', () => {
      const settings = getSettings();
      settings.slotAssignments = { 'agent-done': { packId: 'my-pack' } };
      saveSettings(settings);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('sound-settings.json'),
        expect.stringContaining('"my-pack"'),
        'utf-8',
      );
    });

    it('migrates legacy activePack to slotAssignments', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activePack: 'legacy-pack',
          eventSettings: {
            'agent-done': { enabled: true, volume: 80 },
            error: { enabled: true, volume: 80 },
            permission: { enabled: true, volume: 80 },
            notification: { enabled: true, volume: 80 },
          },
        }),
      );
      const settings = getSettings();
      // activePack should be removed, all slots assigned
      expect(settings.activePack).toBeUndefined();
      expect(settings.slotAssignments['agent-done']?.packId).toBe('legacy-pack');
      expect(settings.slotAssignments.error?.packId).toBe('legacy-pack');
      expect(settings.slotAssignments.permission?.packId).toBe('legacy-pack');
      expect(settings.slotAssignments.notification?.packId).toBe('legacy-pack');
      // New events should also be assigned
      expect(settings.slotAssignments['permission-granted']?.packId).toBe('legacy-pack');
      expect(settings.slotAssignments['agent-wake']?.packId).toBe('legacy-pack');
    });

    it('adds missing eventSettings keys for new events on upgrade', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          slotAssignments: {},
          eventSettings: {
            'agent-done': { enabled: true, volume: 50 },
            error: { enabled: false, volume: 70 },
            permission: { enabled: true, volume: 80 },
            notification: { enabled: true, volume: 80 },
          },
        }),
      );
      const settings = getSettings();
      // Existing events should keep their values
      expect(settings.eventSettings['agent-done'].volume).toBe(50);
      expect(settings.eventSettings.error.enabled).toBe(false);
      // New events should get defaults
      expect(settings.eventSettings['permission-granted'].enabled).toBe(true);
      expect(settings.eventSettings['permission-granted'].volume).toBe(80);
      expect(settings.eventSettings['agent-wake'].enabled).toBe(true);
      expect(settings.eventSettings['agent-sleep'].enabled).toBe(true);
      expect(settings.eventSettings['agent-focus'].enabled).toBe(true);
    });

    it('migrates legacy project overrides', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activePack: null,
          slotAssignments: {},
          eventSettings: {},
          projectOverrides: {
            'proj-1': { activePack: 'project-pack' },
          },
        }),
      );
      const settings = getSettings();
      const projSlots = settings.projectOverrides?.['proj-1']?.slotAssignments;
      expect(projSlots?.['agent-done']?.packId).toBe('project-pack');
      expect(settings.projectOverrides?.['proj-1']?.activePack).toBeUndefined();
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
          return ['agent-done.mp3', 'error.wav', 'agent-wake.ogg', 'readme.txt'] as unknown as string[];
        }
        return [];
      });

      const packs = listSoundPacks();
      expect(packs).toHaveLength(1);
      expect(packs[0].id).toBe('my-pack');
      expect(packs[0].name).toBe('my-pack');
      expect(packs[0].sounds['agent-done']).toBe('agent-done.mp3');
      expect(packs[0].sounds['error']).toBe('error.wav');
      expect(packs[0].sounds['agent-wake']).toBe('agent-wake.ogg');
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
    it('deletes a user sound pack and cleans slot assignments', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.rmSync).mockImplementation(() => {});
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.includes('sound-settings.json')) {
          return JSON.stringify({
            slotAssignments: {
              'agent-done': { packId: 'my-pack' },
              error: { packId: 'other-pack' },
            },
            eventSettings: {},
          });
        }
        throw new Error('ENOENT');
      });

      const result = deleteSoundPack('my-pack');
      expect(result).toBe(true);
      expect(fs.rmSync).toHaveBeenCalled();
      // Should save cleaned settings
      expect(fs.writeFileSync).toHaveBeenCalled();
      const savedJson = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const savedSettings = JSON.parse(savedJson);
      expect(savedSettings.slotAssignments['agent-done']).toBeUndefined();
      expect(savedSettings.slotAssignments.error?.packId).toBe('other-pack');
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

    it('returns data for new event types', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['agent-wake.wav'] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('wake-audio'));

      const data = getSoundData('my-pack', 'agent-wake');
      expect(data).toMatch(/^data:audio\/wav;base64,/);
    });
  });

  describe('resolveSlotPack', () => {
    it('returns null when no slot assignment exists', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ slotAssignments: {}, eventSettings: {} }),
      );
      expect(resolveSlotPack('agent-done')).toBeNull();
    });

    it('returns global slot assignment', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          slotAssignments: { 'agent-done': { packId: 'global-pack' } },
          eventSettings: {},
        }),
      );
      expect(resolveSlotPack('agent-done')).toBe('global-pack');
    });

    it('returns project override when set', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          slotAssignments: { 'agent-done': { packId: 'global-pack' } },
          eventSettings: {},
          projectOverrides: {
            'proj-1': {
              slotAssignments: { 'agent-done': { packId: 'project-pack' } },
            },
          },
        }),
      );
      expect(resolveSlotPack('agent-done', 'proj-1')).toBe('project-pack');
    });

    it('falls back to global when project has no override for slot', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          slotAssignments: { 'agent-done': { packId: 'global-pack' } },
          eventSettings: {},
          projectOverrides: {
            'proj-1': {
              slotAssignments: { error: { packId: 'project-error-pack' } },
            },
          },
        }),
      );
      expect(resolveSlotPack('agent-done', 'proj-1')).toBe('global-pack');
    });

    it('supports per-slot mix-and-match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          slotAssignments: {
            'agent-done': { packId: 'pack-a' },
            error: { packId: 'pack-b' },
            'agent-wake': { packId: 'pack-c' },
          },
          eventSettings: {},
        }),
      );
      expect(resolveSlotPack('agent-done')).toBe('pack-a');
      expect(resolveSlotPack('error')).toBe('pack-b');
      expect(resolveSlotPack('agent-wake')).toBe('pack-c');
      expect(resolveSlotPack('notification')).toBeNull();
    });
  });

  describe('resolveActivePack (legacy compat)', () => {
    it('returns first assigned pack', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          slotAssignments: { error: { packId: 'my-pack' } },
          eventSettings: {},
        }),
      );
      expect(resolveActivePack()).toBe('my-pack');
    });

    it('returns null when no slots assigned', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ slotAssignments: {}, eventSettings: {} }),
      );
      expect(resolveActivePack()).toBeNull();
    });
  });
});
