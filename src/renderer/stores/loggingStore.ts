import { create } from 'zustand';
import { LoggingSettings } from '../../shared/types';

interface LoggingState {
  settings: LoggingSettings | null;
  namespaces: string[];
  logPath: string;
  loadSettings: () => Promise<void>;
  saveSettings: (partial: Partial<LoggingSettings>) => Promise<void>;
  loadNamespaces: () => Promise<void>;
}

export const useLoggingStore = create<LoggingState>((set, get) => ({
  settings: null,
  namespaces: [],
  logPath: '',

  loadSettings: async () => {
    const [settings, namespaces, logPath] = await Promise.all([
      window.clubhouse.log.getSettings(),
      window.clubhouse.log.getNamespaces(),
      window.clubhouse.log.getPath(),
    ]);
    set({ settings, namespaces, logPath });
  },

  saveSettings: async (partial) => {
    const current = get().settings;
    if (!current) return;
    const merged = { ...current, ...partial };
    set({ settings: merged });
    await window.clubhouse.log.saveSettings(merged);
  },

  loadNamespaces: async () => {
    const namespaces = await window.clubhouse.log.getNamespaces();
    set({ namespaces });
  },
}));
