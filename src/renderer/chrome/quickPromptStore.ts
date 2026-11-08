import { create } from 'zustand';

interface QuickPromptState {
  open: boolean;
  openPrompt: () => void;
  closePrompt: () => void;
}

/** The one-line quick agent prompt (#2812), opened by ⌘N in the new layout. */
export const useQuickPromptStore = create<QuickPromptState>((set) => ({
  open: false,
  openPrompt: () => set({ open: true }),
  closePrompt: () => set({ open: false }),
}));
