import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSoundStore, mapNotificationToSoundEvent, hasAnyCustomPack } from './soundStore';
import { SoundSettings } from '../../shared/types';

// Mock window.clubhouse API
const mockGetSoundSettings = vi.fn();
const mockSaveSoundSettings = vi.fn();
const mockListSoundPacks = vi.fn();
const mockImportSoundPack = vi.fn();
const mockDeleteSoundPack = vi.fn();
const mockGetSoundData = vi.fn();

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        getSoundSettings: mockGetSoundSettings,
        saveSoundSettings: mockSaveSoundSettings,
        listSoundPacks: mockListSoundPacks,
        importSoundPack: mockImportSoundPack,
        deleteSoundPack: mockDeleteSoundPack,
        getSoundData: mockGetSoundData,
      },
    },
  },
  writable: true,
});

// Mock Audio - each instance must have its own pause/play so module-level references work
const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn();

class MockAudio {
  volume = 1;
  src = '';
  play = mockPlay;
  pause = mockPause;
  constructor(_src?: string) {
    if (_src) this.src = _src;
  }
}

vi.stubGlobal('Audio', MockAudio);

const DEFAULT_SETTINGS: SoundSettings = {
  slotAssignments: {},
  eventSettings: {
    'agent-done': { enabled: true, volume: 80 },
    error: { enabled: true, volume: 80 },
    permission: { enabled: true, volume: 80 },
    'permission-granted': { enabled: true, volume: 80 },
    'permission-denied': { enabled: true, volume: 80 },
    'agent-wake': { enabled: true, volume: 80 },
    'agent-sleep': { enabled: true, volume: 80 },
    'agent-focus': { enabled: true, volume: 80 },
    notification: { enabled: true, volume: 80 },
  },
};

describe('soundStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSoundStore.setState({ settings: null, packs: [], soundCache: {} });
  });

  describe('loadSettings', () => {
    it('loads settings from IPC', async () => {
      mockGetSoundSettings.mockResolvedValue(DEFAULT_SETTINGS);
      await useSoundStore.getState().loadSettings();
      expect(useSoundStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('saveSettings', () => {
    it('merges partial settings and persists', async () => {
      useSoundStore.setState({ settings: DEFAULT_SETTINGS });
      mockSaveSoundSettings.mockResolvedValue(undefined);

      await useSoundStore.getState().saveSettings({
        slotAssignments: { 'agent-done': { packId: 'test-pack' } },
      });

      expect(useSoundStore.getState().settings?.slotAssignments['agent-done']?.packId).toBe('test-pack');
      expect(mockSaveSoundSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          slotAssignments: { 'agent-done': { packId: 'test-pack' } },
        }),
      );
    });

    it('does nothing when settings not loaded', async () => {
      await useSoundStore.getState().saveSettings({ slotAssignments: {} });
      expect(mockSaveSoundSettings).not.toHaveBeenCalled();
    });
  });

  describe('loadPacks', () => {
    it('loads packs from IPC', async () => {
      const packs = [{ id: 'pack1', name: 'Pack 1', sounds: { 'agent-done': 'done.mp3' }, source: 'user' as const }];
      mockListSoundPacks.mockResolvedValue(packs);

      await useSoundStore.getState().loadPacks();
      expect(useSoundStore.getState().packs).toEqual(packs);
    });
  });

  describe('importPack', () => {
    it('refreshes pack list after import', async () => {
      const newPack = { id: 'imported', name: 'Imported', sounds: {}, source: 'user' as const };
      mockImportSoundPack.mockResolvedValue(newPack);
      mockListSoundPacks.mockResolvedValue([newPack]);

      const result = await useSoundStore.getState().importPack();
      expect(result).toEqual(newPack);
      expect(mockListSoundPacks).toHaveBeenCalled();
    });

    it('returns null when import is cancelled', async () => {
      mockImportSoundPack.mockResolvedValue(null);

      const result = await useSoundStore.getState().importPack();
      expect(result).toBeNull();
    });
  });

  describe('deletePack', () => {
    it('clears cache and refreshes after delete', async () => {
      useSoundStore.setState({
        settings: DEFAULT_SETTINGS,
        soundCache: { 'pack1:agent-done': 'data:audio/mpeg;base64,xxx', 'pack1:error': 'data:audio/wav;base64,yyy' },
      });
      mockDeleteSoundPack.mockResolvedValue(true);
      mockListSoundPacks.mockResolvedValue([]);
      mockGetSoundSettings.mockResolvedValue(DEFAULT_SETTINGS);

      const result = await useSoundStore.getState().deletePack('pack1');
      expect(result).toBe(true);
      expect(useSoundStore.getState().soundCache).toEqual({});
    });
  });

  describe('playSound', () => {
    it('does nothing when settings not loaded', async () => {
      await useSoundStore.getState().playSound('agent-done');
      expect(mockGetSoundData).not.toHaveBeenCalled();
    });

    it('does nothing when event is disabled', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          slotAssignments: { 'agent-done': { packId: 'test-pack' } },
          eventSettings: {
            ...DEFAULT_SETTINGS.eventSettings,
            'agent-done': { enabled: false, volume: 80 },
          },
        },
      });

      await useSoundStore.getState().playSound('agent-done');
      expect(mockGetSoundData).not.toHaveBeenCalled();
    });

    it('does nothing when no slot assignment exists (OS default)', async () => {
      useSoundStore.setState({ settings: DEFAULT_SETTINGS });

      await useSoundStore.getState().playSound('agent-done');
      expect(mockGetSoundData).not.toHaveBeenCalled();
    });

    it('plays sound from assigned slot pack', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          slotAssignments: { 'agent-done': { packId: 'my-pack' } },
        },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,test');

      await useSoundStore.getState().playSound('agent-done');

      expect(mockGetSoundData).toHaveBeenCalledWith('my-pack', 'agent-done');
      expect(mockPlay).toHaveBeenCalled();
    });

    it('uses per-slot assignment (mix-and-match)', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          slotAssignments: {
            'agent-done': { packId: 'pack-a' },
            error: { packId: 'pack-b' },
          },
        },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,test');

      await useSoundStore.getState().playSound('agent-done');
      expect(mockGetSoundData).toHaveBeenCalledWith('pack-a', 'agent-done');

      await useSoundStore.getState().playSound('error');
      expect(mockGetSoundData).toHaveBeenCalledWith('pack-b', 'error');
    });

    it('uses project override slot assignment when available', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          slotAssignments: { 'agent-done': { packId: 'global-pack' } },
          projectOverrides: {
            'proj-1': {
              slotAssignments: { 'agent-done': { packId: 'project-pack' } },
            },
          },
        },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,test');

      await useSoundStore.getState().playSound('agent-done', 'proj-1');

      expect(mockGetSoundData).toHaveBeenCalledWith('project-pack', 'agent-done');
    });

    it('falls back to global slot when project has no override for that slot', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          slotAssignments: { 'agent-done': { packId: 'global-pack' } },
          projectOverrides: {
            'proj-1': {
              slotAssignments: { error: { packId: 'project-error-pack' } },
            },
          },
        },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,test');

      await useSoundStore.getState().playSound('agent-done', 'proj-1');
      expect(mockGetSoundData).toHaveBeenCalledWith('global-pack', 'agent-done');
    });

    it('caches sound data after first load', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          slotAssignments: { 'agent-done': { packId: 'my-pack' } },
        },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,cached');

      await useSoundStore.getState().playSound('agent-done');
      await useSoundStore.getState().playSound('agent-done');

      // Should only call IPC once (second time uses cache)
      expect(mockGetSoundData).toHaveBeenCalledTimes(1);
    });

    it('plays new event types', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          slotAssignments: { 'agent-wake': { packId: 'my-pack' } },
        },
      });
      mockGetSoundData.mockResolvedValue('data:audio/wav;base64,wake');

      await useSoundStore.getState().playSound('agent-wake');
      expect(mockGetSoundData).toHaveBeenCalledWith('my-pack', 'agent-wake');
      expect(mockPlay).toHaveBeenCalled();
    });
  });

  describe('previewSound', () => {
    it('plays preview from specified pack', async () => {
      useSoundStore.setState({ settings: DEFAULT_SETTINGS });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,preview');

      await useSoundStore.getState().previewSound('some-pack', 'error');

      expect(mockGetSoundData).toHaveBeenCalledWith('some-pack', 'error');
      expect(mockPlay).toHaveBeenCalled();
    });
  });

  describe('applyAllFromPack', () => {
    it('sets all slots to the same pack', async () => {
      useSoundStore.setState({ settings: DEFAULT_SETTINGS });
      mockSaveSoundSettings.mockResolvedValue(undefined);

      await useSoundStore.getState().applyAllFromPack('my-pack');

      const settings = useSoundStore.getState().settings;
      expect(settings?.slotAssignments['agent-done']?.packId).toBe('my-pack');
      expect(settings?.slotAssignments.error?.packId).toBe('my-pack');
      expect(settings?.slotAssignments.permission?.packId).toBe('my-pack');
      expect(settings?.slotAssignments['permission-granted']?.packId).toBe('my-pack');
      expect(settings?.slotAssignments['permission-denied']?.packId).toBe('my-pack');
      expect(settings?.slotAssignments['agent-wake']?.packId).toBe('my-pack');
      expect(settings?.slotAssignments['agent-sleep']?.packId).toBe('my-pack');
      expect(settings?.slotAssignments['agent-focus']?.packId).toBe('my-pack');
      expect(settings?.slotAssignments.notification?.packId).toBe('my-pack');
    });

    it('does nothing when settings not loaded', async () => {
      await useSoundStore.getState().applyAllFromPack('my-pack');
      expect(mockSaveSoundSettings).not.toHaveBeenCalled();
    });
  });
});

describe('mapNotificationToSoundEvent', () => {
  it('maps stop to agent-done', () => {
    expect(mapNotificationToSoundEvent('stop')).toBe('agent-done');
  });

  it('maps tool_error to error', () => {
    expect(mapNotificationToSoundEvent('tool_error')).toBe('error');
  });

  it('maps permission_request to permission', () => {
    expect(mapNotificationToSoundEvent('permission_request')).toBe('permission');
  });

  it('maps notification to notification', () => {
    expect(mapNotificationToSoundEvent('notification')).toBe('notification');
  });

  it('returns null for unknown events', () => {
    expect(mapNotificationToSoundEvent('pre_tool')).toBeNull();
    expect(mapNotificationToSoundEvent('post_tool')).toBeNull();
  });
});

describe('hasAnyCustomPack', () => {
  it('returns false when no slots assigned', () => {
    expect(hasAnyCustomPack(DEFAULT_SETTINGS)).toBe(false);
  });

  it('returns true when at least one slot is assigned', () => {
    const settings: SoundSettings = {
      ...DEFAULT_SETTINGS,
      slotAssignments: { error: { packId: 'pack-a' } },
    };
    expect(hasAnyCustomPack(settings)).toBe(true);
  });

  it('checks project overrides when projectId provided', () => {
    const settings: SoundSettings = {
      ...DEFAULT_SETTINGS,
      projectOverrides: {
        'proj-1': {
          slotAssignments: { 'agent-done': { packId: 'proj-pack' } },
        },
      },
    };
    expect(hasAnyCustomPack(settings, 'proj-1')).toBe(true);
    expect(hasAnyCustomPack(settings, 'proj-2')).toBe(false);
  });
});
