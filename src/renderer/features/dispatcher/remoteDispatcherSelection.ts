import { create } from 'zustand';

/**
 * Which Dispatcher the sidebar picked besides this computer's own: another
 * computer's, by its machine (lowercased fingerprint), not by a chat id, so
 * the pick holds across that computer's connect, snapshot and reconnect.
 * `local` is this computer's earlier chat while following a lead.
 */
export const useRemoteDispatcherSelection = create<{ machine: string | null; local: boolean; controller: boolean; approvalsOnly: boolean; select: (machine: string | null, local?: boolean, controller?: boolean, approvalsOnly?: boolean) => void }>((set) => ({
  machine: null,
  local: false,
  controller: false,
  approvalsOnly: false,
  select: (machine, local = false, controller = false, approvalsOnly = false) => set({ machine, local, controller: !!machine && controller, approvalsOnly }),
}));
