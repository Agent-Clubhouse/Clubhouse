import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const profile = {
  profile: {
  getSettings: (): Promise<{
    profiles: Array<{
      id: string;
      name: string;
      orchestrators: Record<string, { env: Record<string, string> }>;
    }>;
  }> =>
    ipcRenderer.invoke(IPC.PROFILE.GET_SETTINGS),
  saveProfile: (profile: {
    id: string;
    name: string;
    orchestrators: Record<string, { env: Record<string, string> }>;
  }) =>
    ipcRenderer.invoke(IPC.PROFILE.SAVE_PROFILE, profile),
  deleteProfile: (profileId: string) =>
    ipcRenderer.invoke(IPC.PROFILE.DELETE_PROFILE, profileId),
  getProfileEnvKeys: (orchestratorId: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.PROFILE.GET_PROFILE_ENV_KEYS, orchestratorId),
  },
};
