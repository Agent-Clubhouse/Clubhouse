import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { OrchestratorProfile } from '../../shared/types';
import * as profileSettings from '../services/profile-settings';
import { getProvider } from '../orchestrators';
import { withValidatedArgs, stringArg, objectArg } from './validation';

export function registerProfileHandlers(): void {
  ipcMain.handle(IPC.PROFILE.GET_SETTINGS, () => {
    return profileSettings.getSettings();
  });

  ipcMain.handle(IPC.PROFILE.SAVE_PROFILE, withValidatedArgs(
    [objectArg<OrchestratorProfile>()],
    async (_event, profile) => {
      await profileSettings.saveProfile(profile);
    },
  ));

  ipcMain.handle(IPC.PROFILE.DELETE_PROFILE, withValidatedArgs(
    [stringArg()],
    async (_event, profileId) => {
      await profileSettings.deleteProfile(profileId);
    },
  ));

  ipcMain.handle(IPC.PROFILE.GET_PROFILE_ENV_KEYS, withValidatedArgs(
    [stringArg()],
    (_event, orchestratorId) => {
      const provider = getProvider(orchestratorId);
      if (!provider) return [];
      return provider.getProfileEnvKeys();
    },
  ));
}
