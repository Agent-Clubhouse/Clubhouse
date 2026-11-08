import { create } from 'zustand';
import { beginLoad, optimisticUpdate } from './optimistic-update';
import { DEFAULT_ACCESS, isAccessLevel, type AccessLevel } from '../../shared/agent-access';

/** The app's Default access (#2761): the level new agents and quick agents start at. */
interface DefaultAccessState {
  defaultAccess: AccessLevel;
  loadDefaultAccess: () => Promise<void>;
  setDefaultAccess: (level: AccessLevel) => Promise<void>;
}

export const useDefaultAccessStore = create<DefaultAccessState>((set, get) => ({
  defaultAccess: DEFAULT_ACCESS,

  loadDefaultAccess: async () => {
    const applyLoaded = beginLoad(get);
    try {
      const level = await window.clubhouse.app.getDefaultAccess();
      const safe = applyLoaded({ defaultAccess: isAccessLevel(level) ? level : DEFAULT_ACCESS });
      if (safe) set(safe);
    } catch {
      // Keep the default
    }
  },

  setDefaultAccess: async (level) => {
    await optimisticUpdate(set, get, { defaultAccess: level }, () => window.clubhouse.app.setDefaultAccess(level));
  },
}));
