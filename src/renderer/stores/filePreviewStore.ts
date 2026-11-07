import { create } from 'zustand';

export interface FilePreviewTarget {
  path: string;
  line?: number;
  col?: number;
}

interface FilePreviewState {
  target: FilePreviewTarget | null;
  open: (path: string, line?: number, col?: number) => void;
  close: () => void;
}

/** Explicit user file viewing, independent of the active project or agent. */
export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  target: null,
  open: (path, line, col) => set({ target: { path, line, col } }),
  close: () => set({ target: null }),
}));
