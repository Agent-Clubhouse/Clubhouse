import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { OrchestratorProfile } from '../../shared/types';
import * as profileSettings from '../services/profile-settings';
import { getProvider } from '../orchestrators';

export function registerProfileHandlers(): void {
  ipcMain.handle(IPC.PROFILE.GET_SETTINGS, () => {
    return profileSettings.getSettings();
  });

  ipcMain.handle(IPC.PROFILE.SAVE_PROFILE, async (_event, profile: OrchestratorProfile) => {
    await profileSettings.saveProfile(profile);
  });

  ipcMain.handle(IPC.PROFILE.DELETE_PROFILE, async (_event, profileId: string) => {
    await profileSettings.deleteProfile(profileId);
  });

  ipcMain.handle(IPC.PROFILE.GET_PROFILE_ENV_KEYS, (_event, orchestratorId: string) => {
    const provider = getProvider(orchestratorId);
    if (!provider) return [];
    return provider.getProfileEnvKeys();
  });
}
