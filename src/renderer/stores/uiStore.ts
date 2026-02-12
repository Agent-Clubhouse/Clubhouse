import { create } from 'zustand';
import { ExplorerTab, SettingsSubPage } from '../../shared/types';

interface UIState {
  explorerTab: ExplorerTab;
  selectedFilePath: string | null;
  selectedGitFile: { path: string; staged: boolean; worktreePath: string } | null;
  settingsSubPage: SettingsSubPage;
  setExplorerTab: (tab: ExplorerTab) => void;
  setSelectedFilePath: (path: string | null) => void;
  setSelectedGitFile: (file: { path: string; staged: boolean; worktreePath: string } | null) => void;
  setSettingsSubPage: (page: SettingsSubPage) => void;
}

export const useUIStore = create<UIState>((set) => ({
  explorerTab: 'agents',
  selectedFilePath: null,
  selectedGitFile: null,
  settingsSubPage: 'project',

  setExplorerTab: (tab) => set({ explorerTab: tab }),
  setSelectedFilePath: (path) => set({ selectedFilePath: path }),
  setSelectedGitFile: (file) => set({ selectedGitFile: file }),
  setSettingsSubPage: (page) => set({ settingsSubPage: page }),
}));
