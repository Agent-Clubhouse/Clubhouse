import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

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
vi.mock('fs/promises');
vi.mock('./fs-utils');

import { pathExists } from './fs-utils';
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
import { resetAllSettingsStoresForTests } from './settings-store';

describe('sound-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllSettingsStoresForTests();

    // Default: readFileSync throws (file not found)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.rm).mockResolvedValue(undefined);
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

    it('saves settings to file', async () => {
      const settings = getSettings();
      settings.slotAssignments = { 'agent-done': { packId: 'my-pack' } };
      await saveSettings(settings);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
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
    it('returns empty array when sounds directory does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      expect(await listSoundPacks()).toEqual([]);
    });

    it('discovers packs with valid sound files', async () => {
      vi.mocked(pathExists).mockImplementation(async (p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds') || s.endsWith('/my-pack')) return true;
        return false;
      });
      vi.mocked(fsp.readdir).mockImplementation(async (p, _opts?) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds')) {
          return [
            { name: 'my-pack', isDirectory: () => true } as unknown as fs.Dirent,
          ] as unknown as fs.Dirent[] as any;
        }
        if (s.endsWith('/my-pack')) {
          return ['agent-done.mp3', 'error.wav', 'agent-wake.ogg', 'readme.txt'] as unknown as string[] as any;
        }
        return [] as any;
      });

      const packs = await listSoundPacks();
      expect(packs).toHaveLength(1);
      expect(packs[0].id).toBe('my-pack');
      expect(packs[0].name).toBe('my-pack');
      expect(packs[0].sounds['agent-done']).toBe('agent-done.mp3');
      expect(packs[0].sounds['error']).toBe('error.wav');
      expect(packs[0].sounds['agent-wake']).toBe('agent-wake.ogg');
      expect(packs[0].source).toBe('user');
    });

    it('reads name from manifest.json if available', async () => {
      vi.mocked(pathExists).mockImplementation(async (p) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds') || s.endsWith('/custom') || s.includes('manifest.json')) return true;
        return false;
      });
      vi.mocked(fsp.readdir).mockImplementation(async (p, _opts?) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds')) {
          return [
            { name: 'custom', isDirectory: () => true } as unknown as fs.Dirent,
          ] as unknown as fs.Dirent[] as any;
        }
        if (s.endsWith('/custom')) {
          return ['agent-done.ogg', 'manifest.json'] as unknown as string[] as any;
        }
        return [] as any;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p, _enc?) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.includes('manifest.json')) return JSON.stringify({ name: 'Custom Pack', author: 'Test' });
        throw new Error('ENOENT');
      });

      const packs = await listSoundPacks();
      expect(packs[0].name).toBe('Custom Pack');
      expect(packs[0].author).toBe('Test');
    });

    it('skips directories with no valid sound files', async () => {
      vi.mocked(pathExists).mockImplementation(async (p) => {
        const s = String(p).replace(/\\/g, '/');
        return s.endsWith('/sounds') || s.endsWith('/empty-dir');
      });
      vi.mocked(fsp.readdir).mockImplementation(async (p, _opts?) => {
        const s = String(p).replace(/\\/g, '/');
        if (s.endsWith('/sounds')) {
          return [
            { name: 'empty-dir', isDirectory: () => true } as unknown as fs.Dirent,
          ] as unknown as fs.Dirent[] as any;
        }
        if (s.endsWith('/empty-dir')) {
          return ['readme.txt', 'notes.md'] as unknown as string[] as any;
        }
        return [] as any;
      });

      expect(await listSoundPacks()).toEqual([]);
    });
  });

  describe('registerPluginSounds / unregisterPluginSounds', () => {
    it('registers and unregisters plugin sounds', async () => {
      vi.mocked(pathExists).mockImplementation(async (p) => {
        return String(p).replace(/\\/g, '/').endsWith('/sounds');
      });
      vi.mocked(fsp.readdir).mockImplementation(async () => {
        return ['agent-done.mp3', 'error.mp3'] as unknown as string[] as any;
      });

      const pack = await registerPluginSounds('test-plugin', '/plugins/test-plugin', 'Test Plugin Sounds');
      expect(pack).not.toBeNull();
      expect(pack!.id).toBe('plugin:test-plugin');
      expect(pack!.name).toBe('Test Plugin Sounds');
      expect(pack!.source).toBe('plugin');
      expect(pack!.pluginId).toBe('test-plugin');

      // Should appear in getAllSoundPacks
      const allPacks = await getAllSoundPacks();
      expect(allPacks.some((p) => p.id === 'plugin:test-plugin')).toBe(true);

      // Unregister
      unregisterPluginSounds('test-plugin');
      const afterUnregister = await getAllSoundPacks();
      expect(afterUnregister.some((p) => p.id === 'plugin:test-plugin')).toBe(false);
    });

    it('returns null when plugin has no sounds directory', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      const pack = await registerPluginSounds('no-sounds', '/plugins/no-sounds');
      expect(pack).toBeNull();
    });
  });

  describe('deleteSoundPack', () => {
    it('deletes a user sound pack and cleans slot assignments', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
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

      const result = await deleteSoundPack('my-pack');
      expect(result).toBe(true);
      expect(fsp.rm).toHaveBeenCalled();
      // Should save cleaned settings
      expect(fs.promises.writeFile).toHaveBeenCalled();
      const savedJson = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      const savedSettings = JSON.parse(savedJson);
      expect(savedSettings.slotAssignments['agent-done']).toBeUndefined();
      expect(savedSettings.slotAssignments.error?.packId).toBe('other-pack');
    });

    it('refuses to delete plugin packs', async () => {
      expect(await deleteSoundPack('plugin:test')).toBe(false);
    });

    it('returns false for non-existent packs', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      expect(await deleteSoundPack('nonexistent')).toBe(false);
    });
  });

  describe('getSoundData', () => {
    it('returns base64 data URL for existing sound file', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue(['agent-done.mp3'] as unknown as fs.Dirent[] as any);
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('fake-audio'));

      const data = await getSoundData('my-pack', 'agent-done');
      expect(data).toMatch(/^data:audio\/mpeg;base64,/);
    });

    it('returns null when pack directory does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      expect(await getSoundData('missing', 'agent-done')).toBeNull();
    });

    it('returns null when event sound file does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue(['error.mp3'] as unknown as fs.Dirent[] as any);

      expect(await getSoundData('my-pack', 'agent-done')).toBeNull();
    });

    it('returns data for new event types', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue(['agent-wake.wav'] as unknown as fs.Dirent[] as any);
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('wake-audio'));

      const data = await getSoundData('my-pack', 'agent-wake');
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
