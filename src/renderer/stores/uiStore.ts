import { create } from 'zustand';
import { ExplorerTab, SettingsSubPage } from '../../shared/types';

const VIEW_PREFS_KEY = 'clubhouse_view_prefs';

interface ViewPrefs {
  showHome: boolean;
}

function loadViewPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (raw) return { showHome: true, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { showHome: true };
}

function saveViewPrefs(prefs: ViewPrefs): void {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

interface UIState {
  explorerTab: ExplorerTab;
  previousExplorerTab: ExplorerTab | null;
  settingsSubPage: SettingsSubPage;
  settingsContext: 'app' | string;
  showHome: boolean;
  pluginSettingsId: string | null;
  helpSectionId: string;
  helpTopicId: string | null;
  projectExplorerTab: Record<string, ExplorerTab>;
  setExplorerTab: (tab: ExplorerTab, projectId?: string) => void;
  restoreProjectView: (projectId: string) => void;
  setSettingsSubPage: (page: SettingsSubPage) => void;
  setSettingsContext: (context: 'app' | string) => void;
  toggleSettings: () => void;
  toggleHelp: () => void;
  setHelpSection: (id: string) => void;
  setHelpTopic: (id: string | null) => void;
  setShowHome: (show: boolean) => void;
  openAbout: () => void;
  openPluginSettings: (pluginId: string) => void;
  closePluginSettings: () => void;
}

const initialPrefs = loadViewPrefs();

export const useUIStore = create<UIState>((set, get) => ({
  explorerTab: 'agents',
  previousExplorerTab: null,
  settingsSubPage: 'display',
  settingsContext: 'app',
  showHome: initialPrefs.showHome,
  pluginSettingsId: null,
  helpSectionId: 'general',
  helpTopicId: null,
  projectExplorerTab: {},

  setExplorerTab: (tab, projectId?) => {
    set({ explorerTab: tab });
    if (projectId && tab !== 'settings' && tab !== 'help') {
      set((s) => ({ projectExplorerTab: { ...s.projectExplorerTab, [projectId]: tab } }));
    }
  },

  restoreProjectView: (projectId) => {
    const saved = get().projectExplorerTab[projectId];
    set({ explorerTab: saved || 'agents' });
  },
  setSettingsSubPage: (page) => set({ settingsSubPage: page }),
  setSettingsContext: (context) => set({
    settingsContext: context,
    settingsSubPage: context === 'app' ? 'orchestrators' : 'project',
  }),
  toggleSettings: () => {
    const { explorerTab, previousExplorerTab } = get();
    if (explorerTab !== 'settings') {
      set({ previousExplorerTab: explorerTab, explorerTab: 'settings', settingsSubPage: 'orchestrators', settingsContext: 'app' });
    } else {
      set({ explorerTab: previousExplorerTab || 'agents', previousExplorerTab: null });
    }
  },
  toggleHelp: () => {
    const { explorerTab, previousExplorerTab } = get();
    if (explorerTab !== 'help') {
      set({ previousExplorerTab: explorerTab, explorerTab: 'help', helpSectionId: 'general', helpTopicId: null });
    } else {
      set({ explorerTab: previousExplorerTab || 'agents', previousExplorerTab: null });
    }
  },
  setHelpSection: (id) => set({ helpSectionId: id, helpTopicId: null }),
  setHelpTopic: (id) => set({ helpTopicId: id }),
  setShowHome: (show) => {
    set({ showHome: show });
    saveViewPrefs({ showHome: show });
  },
  openAbout: () => {
    const { explorerTab } = get();
    set({ previousExplorerTab: explorerTab, explorerTab: 'settings', settingsSubPage: 'about', settingsContext: 'app' });
  },
  openPluginSettings: (pluginId) => {
    set({ pluginSettingsId: pluginId, settingsSubPage: 'plugin-detail' });
  },
  closePluginSettings: () => {
    set({ pluginSettingsId: null, settingsSubPage: 'plugins' });
  },
}));
