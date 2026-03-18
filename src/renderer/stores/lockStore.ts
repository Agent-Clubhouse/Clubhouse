/**
 * Lock state store for satellite locking (#867).
 *
 * When a controller connects via mTLS, the satellite enters a locked state
 * that blocks local input. The user can disconnect, pause, or disable Annex.
 */
import { create } from 'zustand';

export interface LockState {
  locked: boolean;
  paused: boolean;
  controllerAlias: string;
  controllerIcon: string;
  controllerColor: string;
  controllerFingerprint: string;
}

interface LockStoreState extends LockState {
  setLockState: (state: Partial<LockState>) => void;
  lock: (controller: Omit<LockState, 'locked' | 'paused'>) => void;
  unlock: () => void;
  togglePause: () => void;
}

const DEFAULT_LOCK_STATE: LockState = {
  locked: false,
  paused: false,
  controllerAlias: '',
  controllerIcon: '',
  controllerColor: '',
  controllerFingerprint: '',
};

export const useLockStore = create<LockStoreState>((set) => ({
  ...DEFAULT_LOCK_STATE,

  setLockState: (state) => set(state),

  lock: (controller) => set({
    locked: true,
    paused: false,
    ...controller,
  }),

  unlock: () => set(DEFAULT_LOCK_STATE),

  togglePause: () => set((state) => ({ paused: !state.paused })),
}));
