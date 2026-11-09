import { create } from 'zustand';
import { DISPATCHER_DEBUG_FLAG } from '../../../shared/types';

/**
 * The Dispatcher debug view (#3188), a switch in Settings > Experimental. It
 * changes only what is shown, never what the Dispatcher does:
 *
 * - its work agent (the one that holds its connections, `state.agentId`) gets
 *   a row under the Dispatcher's, which opens that agent's chat read-only
 *   (DispatcherWorkView);
 * - the Dispatcher's chat shows what it normally hides (tool calls, Clubhouse
 *   updates, agents' raw news, uncleaned replies), each marked as debug
 *   (groupChatDebugMarks).
 *
 * Off, everything reads as before. The flag is preview-only, like every flag
 * on that page, so a stable build reads it as off.
 */

export { DISPATCHER_DEBUG_FLAG };

interface DispatcherDebugState {
  on: boolean;
  /** The Dispatcher's view shows the work agent's chat rather than its own. Only read while `on`. */
  workOpen: boolean;
  setOn: (on: boolean) => void;
  setWorkOpen: (open: boolean) => void;
}

export const useDispatcherDebugStore = create<DispatcherDebugState>((set, get) => ({
  on: false,
  workOpen: false,
  setOn: (on) => { if (get().on !== on) set({ on }); },
  setWorkOpen: (workOpen) => { if (get().workOpen !== workOpen) set({ workOpen }); },
}));

/** Read the saved switch once; the Experimental page updates the store as it saves. */
export async function loadDispatcherDebug(): Promise<void> {
  try {
    const flags = await window.clubhouse.app.getExperimentalSettings();
    useDispatcherDebugStore.getState().setOn(!!flags[DISPATCHER_DEBUG_FLAG]);
  } catch {
    // telemetry-exempt: a debug view; unreadable settings leave it off.
  }
}

export function useDispatcherDebug(): boolean {
  return useDispatcherDebugStore((s) => s.on);
}

/** Whether the Dispatcher's view shows the work agent's chat. */
export function useDispatcherWorkOpen(): boolean {
  return useDispatcherDebugStore((s) => s.on && s.workOpen);
}
