import { create } from 'zustand';
import type { OrchestratorProfile } from '../../shared/types';

interface ProfileState {
  profiles: OrchestratorProfile[];
  loadProfiles: () => Promise<void>;
  saveProfile: (profile: OrchestratorProfile) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  getProfileEnvKeys: (orchestratorId: string) => Promise<string[]>;
  getProfilesForOrchestrator: (orchestratorId: string) => OrchestratorProfile[];
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],

  loadProfiles: async () => {
    try {
      const settings = await window.clubhouse.profile.getSettings();
      set({ profiles: settings.profiles ?? [] });
    } catch {
      // Keep defaults on error
    }
  },

  saveProfile: async (profile) => {
    await window.clubhouse.profile.saveProfile(profile);
    // Reload from disk for consistency
    const settings = await window.clubhouse.profile.getSettings();
    set({ profiles: settings.profiles ?? [] });
  },

  deleteProfile: async (profileId) => {
    await window.clubhouse.profile.deleteProfile(profileId);
    const settings = await window.clubhouse.profile.getSettings();
    set({ profiles: settings.profiles ?? [] });
  },

  getProfileEnvKeys: async (orchestratorId) => {
    return window.clubhouse.profile.getProfileEnvKeys(orchestratorId);
  },

  getProfilesForOrchestrator: (orchestratorId) => {
    return get().profiles.filter((p) => p.orchestrator === orchestratorId);
  },
}));
