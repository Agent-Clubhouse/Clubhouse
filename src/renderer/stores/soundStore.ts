import { create } from 'zustand';
import { SoundSettings, SoundPackInfo, SoundEvent, ALL_SOUND_EVENTS } from '../../shared/types';

interface SoundState {
  settings: SoundSettings | null;
  packs: SoundPackInfo[];
  /** Cached base64 data URLs keyed by `packId:event` */
  soundCache: Record<string, string>;

  loadSettings: () => Promise<void>;
  saveSettings: (partial: Partial<SoundSettings>) => Promise<void>;
  loadPacks: () => Promise<void>;
  importPack: () => Promise<SoundPackInfo | null>;
  deletePack: (packId: string) => Promise<boolean>;

  /**
   * Play the sound for a given event.
   * Resolves the active pack (with optional project override), loads the audio
   * data if not cached, and plays it.
   */
  playSound: (event: SoundEvent, projectId?: string) => Promise<void>;

  /** Preview a specific sound from a specific pack. */
  previewSound: (packId: string, event: SoundEvent) => Promise<void>;
}

/** Active Audio element for stopping previous playback */
let activeAudio: HTMLAudioElement | null = null;

function stopActiveAudio(): void {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }
}

async function loadSoundData(packId: string, event: SoundEvent, cache: Record<string, string>): Promise<string | null> {
  const cacheKey = `${packId}:${event}`;
  if (cache[cacheKey]) return cache[cacheKey];

  const data = await window.clubhouse.app.getSoundData(packId, event);
  if (data) {
    // Store in cache via direct mutation (store will be updated separately)
    cache[cacheKey] = data;
  }
  return data;
}

export const useSoundStore = create<SoundState>((set, get) => ({
  settings: null,
  packs: [],
  soundCache: {},

  loadSettings: async () => {
    const settings = await window.clubhouse.app.getSoundSettings();
    set({ settings });
  },

  saveSettings: async (partial) => {
    const current = get().settings;
    if (!current) return;
    const merged = { ...current, ...partial };
    set({ settings: merged });
    await window.clubhouse.app.saveSoundSettings(merged);
  },

  loadPacks: async () => {
    const packs = await window.clubhouse.app.listSoundPacks();
    set({ packs });
  },

  importPack: async () => {
    const pack = await window.clubhouse.app.importSoundPack();
    if (pack) {
      // Refresh pack list
      await get().loadPacks();
    }
    return pack;
  },

  deletePack: async (packId) => {
    const result = await window.clubhouse.app.deleteSoundPack(packId);
    if (result) {
      // Clear cache entries for this pack
      const cache = { ...get().soundCache };
      for (const key of Object.keys(cache)) {
        if (key.startsWith(`${packId}:`)) {
          delete cache[key];
        }
      }
      set({ soundCache: cache });
      // Refresh pack list and settings
      await get().loadPacks();
      await get().loadSettings();
    }
    return result;
  },

  playSound: async (event, projectId) => {
    const { settings, soundCache } = get();
    if (!settings) return;

    const eventSettings = settings.eventSettings[event];
    if (!eventSettings?.enabled) return;

    // Resolve active pack with project override
    let activePack = settings.activePack;
    if (projectId && settings.projectOverrides?.[projectId]?.activePack !== undefined) {
      activePack = settings.projectOverrides[projectId].activePack ?? null;
    }

    // No pack selected = use OS default (handled by Electron's silent flag)
    if (!activePack) return;

    const data = await loadSoundData(activePack, event, soundCache);
    if (!data) return;

    // Update cache in store
    set({ soundCache: { ...get().soundCache, [`${activePack}:${event}`]: data } });

    stopActiveAudio();
    const audio = new Audio(data);
    audio.volume = eventSettings.volume / 100;
    activeAudio = audio;
    try {
      await audio.play();
    } catch {
      // Autoplay may be blocked; ignore
    }
  },

  previewSound: async (packId, event) => {
    const { settings, soundCache } = get();
    const volume = settings?.eventSettings[event]?.volume ?? 80;

    const data = await loadSoundData(packId, event, soundCache);
    if (!data) return;

    // Update cache in store
    set({ soundCache: { ...get().soundCache, [`${packId}:${event}`]: data } });

    stopActiveAudio();
    const audio = new Audio(data);
    audio.volume = volume / 100;
    activeAudio = audio;
    try {
      await audio.play();
    } catch {
      // Autoplay may be blocked
    }
  },
}));

/**
 * Map notification event kinds to sound events.
 */
export function mapNotificationToSoundEvent(eventKind: string): SoundEvent | null {
  switch (eventKind) {
    case 'stop': return 'agent-done';
    case 'tool_error': return 'error';
    case 'permission_request': return 'permission';
    case 'notification': return 'notification';
    default: return null;
  }
}
