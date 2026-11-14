import { create } from 'zustand';

/** A remote Dispatcher chat selected from the sidebar. */
export const useRemoteDispatcherSelection = create<{ agentId: string | null; local: boolean; select: (agentId: string | null, local?: boolean) => void }>((set) => ({
  agentId: null,
  local: false,
  select: (agentId, local = false) => set({ agentId, local }),
}));
