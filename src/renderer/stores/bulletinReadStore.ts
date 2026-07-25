import { create } from 'zustand';

/**
 * Tracks the per-channel "last read" timestamp for group project bulletin boards.
 *
 * Read state is per-user (this machine), not project data, so it lives in
 * localStorage keyed by group project id rather than in the shared project file.
 */

const STORAGE_PREFIX = 'bulletin_read_';

/** topic -> ISO timestamp of the newest message the user has seen. */
export type LastReadMap = Record<string, string>;

function storageKey(groupProjectId: string): string {
  return `${STORAGE_PREFIX}${groupProjectId}`;
}

function loadFromStorage(groupProjectId: string): LastReadMap {
  try {
    const raw = localStorage.getItem(storageKey(groupProjectId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: LastReadMap = {};
    for (const [topic, timestamp] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof timestamp === 'string') map[topic] = timestamp;
    }
    return map;
  } catch {
    return {};
  }
}

function saveToStorage(groupProjectId: string, map: LastReadMap): void {
  try {
    localStorage.setItem(storageKey(groupProjectId), JSON.stringify(map));
  } catch {
    // Ignore quota / serialization errors — read state is best-effort.
  }
}

function timeOf(iso: string | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

interface BulletinReadState {
  /** groupProjectId -> (topic -> last read ISO timestamp). */
  lastRead: Record<string, LastReadMap>;
  /** Hydrate a project's read state from localStorage. */
  loadLastRead: (groupProjectId: string) => LastReadMap;
  /**
   * Current read state for a project, hydrating from localStorage on first
   * access so the very first digest fetch already knows what has been read.
   * Call from effects/callbacks, not during render — it may update the store.
   */
  getLastRead: (groupProjectId: string) => LastReadMap;
  /** Mark a single topic read up to `timestamp`. Never moves backwards. */
  markTopicRead: (groupProjectId: string, topic: string, timestamp: string) => void;
  /** Mark several topics read in one update. Never moves any topic backwards. */
  markTopicsRead: (
    groupProjectId: string,
    entries: Array<{ topic: string; timestamp: string }>,
  ) => void;
  /** Drop read state for a project (e.g. when the project is deleted). */
  clearLastRead: (groupProjectId: string) => void;
}

export const useBulletinReadStore = create<BulletinReadState>((set, get) => ({
  lastRead: {},

  loadLastRead: (groupProjectId) => {
    const map = loadFromStorage(groupProjectId);
    set((s) => ({ lastRead: { ...s.lastRead, [groupProjectId]: map } }));
    return map;
  },

  getLastRead: (groupProjectId) => {
    const existing = get().lastRead[groupProjectId];
    if (existing) return existing;
    return get().loadLastRead(groupProjectId);
  },

  markTopicRead: (groupProjectId, topic, timestamp) => {
    get().markTopicsRead(groupProjectId, [{ topic, timestamp }]);
  },

  markTopicsRead: (groupProjectId, entries) => {
    const current = get().lastRead[groupProjectId] ?? {};
    const next = { ...current };
    let changed = false;

    for (const { topic, timestamp } of entries) {
      if (!topic || !timestamp) continue;
      const incoming = timeOf(timestamp);
      if (incoming === 0) continue;
      if (incoming <= timeOf(next[topic])) continue;
      next[topic] = timestamp;
      changed = true;
    }

    if (!changed) return;
    saveToStorage(groupProjectId, next);
    set((s) => ({ lastRead: { ...s.lastRead, [groupProjectId]: next } }));
  },

  clearLastRead: (groupProjectId) => {
    try {
      localStorage.removeItem(storageKey(groupProjectId));
    } catch {
      // Ignore
    }
    set((s) => {
      const next = { ...s.lastRead };
      delete next[groupProjectId];
      return { lastRead: next };
    });
  },
}));
