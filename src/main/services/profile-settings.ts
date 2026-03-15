import * as os from 'os';
import * as path from 'path';
import { createSettingsStore } from './settings-store';
import { OrchestratorProfile, ProfilesSettings } from '../../shared/types';

const DEFAULT_SETTINGS: ProfilesSettings = {
  profiles: [],
};

const store = createSettingsStore<ProfilesSettings>('profiles.json', DEFAULT_SETTINGS);

export function getSettings(): ProfilesSettings {
  return store.get();
}

export function saveSettings(settings: ProfilesSettings): Promise<void> {
  return store.save(settings);
}

export function getProfiles(): OrchestratorProfile[] {
  return store.get().profiles;
}

export function getProfile(profileId: string): OrchestratorProfile | undefined {
  return store.get().profiles.find((p) => p.id === profileId);
}

export function saveProfile(profile: OrchestratorProfile): Promise<void> {
  const settings = store.get();
  const idx = settings.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    settings.profiles[idx] = profile;
  } else {
    settings.profiles.push(profile);
  }
  return store.save(settings);
}

export function deleteProfile(profileId: string): Promise<void> {
  const settings = store.get();
  settings.profiles = settings.profiles.filter((p) => p.id !== profileId);
  return store.save(settings);
}

/** Expand ~ in env var values to the user's home directory */
export function resolveProfileEnv(profile: OrchestratorProfile, orchestratorId: string): Record<string, string> | undefined {
  const entry = profile.orchestrators[orchestratorId];
  if (!entry) return undefined;

  const home = os.homedir();
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env)) {
    resolved[key] = value.startsWith('~/')
      ? path.join(home, value.slice(2))
      : value.replace(/^~(?=\/|$)/, home);
  }
  return resolved;
}
