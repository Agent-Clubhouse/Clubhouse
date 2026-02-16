import { create } from 'zustand';
import { ExplorerTab, SettingsSubPage } from '../../shared/types';

interface UIState {
  explorerTab: ExplorerTab;
  previousExplorerTab: ExplorerTab | null;
  selectedFilePath: string | null;
  selectedGitFile: { path: string; staged: boolean; worktreePath: string } | null;
  settingsSubPage: SettingsSubPage;
  settingsContext: 'app' | string;
  setExplorerTab: (tab: ExplorerTab) => void;
  setSelectedFilePath: (path: string | null) => void;
  setSelectedGitFile: (file: { path: string; staged: boolean; worktreePath: string } | null) => void;
  setSettingsSubPage: (page: SettingsSubPage) => void;
  setSettingsContext: (context: 'app' | string) => void;
  toggleSettings: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  explorerTab: 'agents',
  previousExplorerTab: null,
  selectedFilePath: null,
  selectedGitFile: null,
  settingsSubPage: 'display',
  settingsContext: 'app',

  setExplorerTab: (tab) => set({ explorerTab: tab }),
  setSelectedFilePath: (path) => set({ selectedFilePath: path }),
  setSelectedGitFile: (file) => set({ selectedGitFile: file }),
  setSettingsSubPage: (page) => set({ settingsSubPage: page }),
  setSettingsContext: (context) => set({
    settingsContext: context,
    settingsSubPage: context === 'app' ? 'display' : 'project',
  }),
  toggleSettings: () => {
    const { explorerTab, previousExplorerTab } = get();
    if (explorerTab !== 'settings') {
      set({ previousExplorerTab: explorerTab, explorerTab: 'settings', settingsSubPage: 'display', settingsContext: 'app' });
    } else {
      set({ explorerTab: previousExplorerTab || 'agents', previousExplorerTab: null });
    }
  },
}));
