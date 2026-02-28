import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { OrchestratorProfile } from '../../shared/types';
import * as profileSettings from '../services/profile-settings';
import { getProvider } from '../orchestrators';

export function registerProfileHandlers(): void {
  ipcMain.handle(IPC.PROFILE.GET_SETTINGS, () => {
    return profileSettings.getSettings();
  });

  ipcMain.handle(IPC.PROFILE.SAVE_PROFILE, (_event, profile: OrchestratorProfile) => {
    profileSettings.saveProfile(profile);
  });

  ipcMain.handle(IPC.PROFILE.DELETE_PROFILE, (_event, profileId: string) => {
    profileSettings.deleteProfile(profileId);
  });

  ipcMain.handle(IPC.PROFILE.GET_PROFILE_ENV_KEYS, (_event, orchestratorId: string) => {
    const provider = getProvider(orchestratorId);
    if (!provider) return [];
    return provider.getProfileEnvKeys();
  });
}
