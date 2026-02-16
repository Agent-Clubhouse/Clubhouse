import { create } from 'zustand';
import { ExplorerTab, SettingsSubPage } from '../../shared/types';

const VIEW_PREFS_KEY = 'clubhouse_view_prefs';

interface ViewPrefs {
  showHome: boolean;
  showCrossHub: boolean;
}

function loadViewPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (raw) return { showHome: true, showCrossHub: true, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { showHome: true, showCrossHub: true };
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
  showCrossHub: boolean;
  setExplorerTab: (tab: ExplorerTab) => void;
  setSettingsSubPage: (page: SettingsSubPage) => void;
  setSettingsContext: (context: 'app' | string) => void;
  toggleSettings: () => void;
  setShowHome: (show: boolean) => void;
  setShowCrossHub: (show: boolean) => void;
}

const initialPrefs = loadViewPrefs();

export const useUIStore = create<UIState>((set, get) => ({
  explorerTab: 'agents',
  previousExplorerTab: null,
  settingsSubPage: 'display',
  settingsContext: 'app',
  showHome: initialPrefs.showHome,
  showCrossHub: initialPrefs.showCrossHub,

  setExplorerTab: (tab) => set({ explorerTab: tab }),
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
  setShowHome: (show) => {
    set({ showHome: show });
    saveViewPrefs({ showHome: show, showCrossHub: get().showCrossHub });
  },
  setShowCrossHub: (show) => {
    set({ showCrossHub: show });
    saveViewPrefs({ showHome: get().showHome, showCrossHub: show });
    // If hiding and currently on cross-hub, navigate away
    if (!show && get().explorerTab === 'cross-hub') {
      set({ explorerTab: 'agents' });
    }
  },
}));
