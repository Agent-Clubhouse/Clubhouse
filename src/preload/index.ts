import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { settingsChannels } from '../shared/settings-definitions';
import { pty } from './pty';
import { project } from './project';
import { agent } from './agent';
import { git } from './git';
import { agentSettings } from './agentSettings';
import { file } from './file';
import { blueprint } from './blueprint';
import { plugin } from './plugin';
import { marketplace } from './marketplace';
import { pluginMcp } from './pluginMcp';
import { log } from './log';
import { process as processApi } from './process';
import { app } from './app';
import { profile } from './profile';
import { annex } from './annex';
import { annexClient } from './annexClient';
import { window } from './window';
import { groupProject } from './groupProject';
import { mcpBinding } from './mcpBinding';
import { canvas } from './canvas';
import { hookServer } from './hookServer';
import { goobers } from './goobers';
import { telemetry } from './telemetry';
import { NEW_CHROME_ARG } from '../shared/chrome-flag';

export const api = {
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  /** True when main started this window with the new chrome layout (fixed for the session). */
  newChromeLayout: process.argv.includes(NEW_CHROME_ARG),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  /**
   * Generic settings bridge — routes get/save by definition key.
   * Eliminates per-setting preload boilerplate: no new methods needed
   * when adding a setting via createManagedSettings().
   */
  settings: {
    get: (key: string): Promise<unknown> => {
      const ch = settingsChannels(key);
      return ipcRenderer.invoke(ch.get);
    },
    save: (key: string, value: unknown, ...extraArgs: unknown[]): Promise<void> => {
      const ch = settingsChannels(key);
      return ipcRenderer.invoke(ch.save, value, ...extraArgs);
    },
  },
  ...pty,
  ...project,
  ...agent,
  ...git,
  ...agentSettings,
  ...file,
  ...blueprint,
  ...plugin,
  ...marketplace,
  ...pluginMcp,
  ...log,
  ...processApi,
  ...app,
  ...profile,
  ...annex,
  ...annexClient,
  ...window,
  ...groupProject,
  ...mcpBinding,
  ...canvas,
  ...hookServer,
  ...goobers,
  ...telemetry,
};

export type ClubhouseAPI = typeof api;

contextBridge.exposeInMainWorld('clubhouse', api);
