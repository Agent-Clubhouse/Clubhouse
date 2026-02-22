import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSoundStore, mapNotificationToSoundEvent } from './soundStore';

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

// Mock Audio
const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn();
let audioVolume = 1;

vi.stubGlobal('Audio', vi.fn().mockImplementation(() => ({
  play: mockPlay,
  pause: mockPause,
  get volume() { return audioVolume; },
  set volume(v: number) { audioVolume = v; },
  set src(_v: string) {},
})));

const DEFAULT_SETTINGS = {
  activePack: null,
  eventSettings: {
    'agent-done': { enabled: true, volume: 80 },
    error: { enabled: true, volume: 80 },
    permission: { enabled: true, volume: 80 },
    notification: { enabled: true, volume: 80 },
  },
};

describe('soundStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSoundStore.setState({ settings: null, packs: [], soundCache: {} });
    audioVolume = 1;
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

      await useSoundStore.getState().saveSettings({ activePack: 'test-pack' });

      expect(useSoundStore.getState().settings?.activePack).toBe('test-pack');
      expect(mockSaveSoundSettings).toHaveBeenCalledWith(
        expect.objectContaining({ activePack: 'test-pack' }),
      );
    });

    it('does nothing when settings not loaded', async () => {
      await useSoundStore.getState().saveSettings({ activePack: 'test' });
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
          activePack: 'test-pack',
          eventSettings: {
            ...DEFAULT_SETTINGS.eventSettings,
            'agent-done': { enabled: false, volume: 80 },
          },
        },
      });

      await useSoundStore.getState().playSound('agent-done');
      expect(mockGetSoundData).not.toHaveBeenCalled();
    });

    it('does nothing when no pack is active (OS default)', async () => {
      useSoundStore.setState({ settings: DEFAULT_SETTINGS });

      await useSoundStore.getState().playSound('agent-done');
      expect(mockGetSoundData).not.toHaveBeenCalled();
    });

    it('plays sound from active pack', async () => {
      useSoundStore.setState({
        settings: { ...DEFAULT_SETTINGS, activePack: 'my-pack' },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,test');

      await useSoundStore.getState().playSound('agent-done');

      expect(mockGetSoundData).toHaveBeenCalledWith('my-pack', 'agent-done');
      expect(mockPlay).toHaveBeenCalled();
    });

    it('uses project override pack when available', async () => {
      useSoundStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          activePack: 'global-pack',
          projectOverrides: { 'proj-1': { activePack: 'project-pack' } },
        },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,test');

      await useSoundStore.getState().playSound('agent-done', 'proj-1');

      expect(mockGetSoundData).toHaveBeenCalledWith('project-pack', 'agent-done');
    });

    it('caches sound data after first load', async () => {
      useSoundStore.setState({
        settings: { ...DEFAULT_SETTINGS, activePack: 'my-pack' },
      });
      mockGetSoundData.mockResolvedValue('data:audio/mpeg;base64,cached');

      await useSoundStore.getState().playSound('agent-done');
      await useSoundStore.getState().playSound('agent-done');

      // Should only call IPC once (second time uses cache)
      expect(mockGetSoundData).toHaveBeenCalledTimes(1);
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
