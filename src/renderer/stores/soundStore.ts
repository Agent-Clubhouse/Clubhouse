import { create } from 'zustand';
import {
  SoundSettings,
  SoundPackInfo,
  SoundEvent,
  ALL_SOUND_EVENTS,
  SlotAssignment,
} from '../../shared/types';

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
   * Resolves the per-slot pack assignment (with optional project override),
   * loads the audio data if not cached, and plays it.
   */
  playSound: (event: SoundEvent, projectId?: string) => Promise<void>;

  /** Preview a specific sound from a specific pack. */
  previewSound: (packId: string, event: SoundEvent) => Promise<void>;

  /** Apply all sounds from a single pack to every slot. */
  applyAllFromPack: (packId: string) => Promise<void>;
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

/**
 * Resolve the pack for a given event slot, considering project overrides.
 */
function resolveSlotPack(settings: SoundSettings, event: SoundEvent, projectId?: string): string | null {
  // Check project-level slot override first
  if (projectId) {
    const projectSlots = settings.projectOverrides?.[projectId]?.slotAssignments;
    if (projectSlots?.[event]) {
      return projectSlots[event]!.packId;
    }
  }
  // Fall back to global slot assignment
  return settings.slotAssignments[event]?.packId ?? null;
}

/**
 * Check if any slot has a custom pack assigned (used for notification silencing).
 */
export function hasAnyCustomPack(settings: SoundSettings, projectId?: string): boolean {
  for (const event of ALL_SOUND_EVENTS) {
    if (resolveSlotPack(settings, event, projectId) !== null) return true;
  }
  return false;
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
      // Refresh pack list and settings (deleteSoundPack cleans slot assignments)
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

    // Resolve per-slot pack assignment
    const packId = resolveSlotPack(settings, event, projectId);

    // No pack assigned for this slot = use OS default (handled by Electron's silent flag)
    if (!packId) return;

    const data = await loadSoundData(packId, event, soundCache);
    if (!data) return;

    // Update cache in store
    set({ soundCache: { ...get().soundCache, [`${packId}:${event}`]: data } });

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

  applyAllFromPack: async (packId: string) => {
    const current = get().settings;
    if (!current) return;

    const slots: Partial<Record<SoundEvent, SlotAssignment>> = {};
    for (const event of ALL_SOUND_EVENTS) {
      slots[event] = { packId };
    }
    await get().saveSettings({ slotAssignments: slots });
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
