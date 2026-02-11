import { create } from 'zustand';
import { ExplorerTab } from '../../shared/types';

interface UIState {
  explorerTab: ExplorerTab;
  selectedFilePath: string | null;
  setExplorerTab: (tab: ExplorerTab) => void;
  setSelectedFilePath: (path: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  explorerTab: 'agents',
  selectedFilePath: null,

  setExplorerTab: (tab) => set({ explorerTab: tab }),
  setSelectedFilePath: (path) => set({ selectedFilePath: path }),
}));
