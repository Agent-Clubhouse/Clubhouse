/**
 * The project's legacy agent defaults (#3245): the settings page reads them
 * and previews every import or copy before it runs. Nothing here writes on
 * its own; see services/legacy-defaults.ts.
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import {
  copyIntoAgent,
  describeLegacyDefaults,
  importAsParts,
  previewCopyIntoAgent,
  previewCopyIntoNewAgent,
  previewImportAsParts,
} from '../services/legacy-defaults';
import { stringArg, withValidatedArgs } from './validation';

export function registerLegacyDefaultsHandlers(): void {
  ipcMain.handle(IPC.LEGACY_DEFAULTS.DESCRIBE, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => describeLegacyDefaults(projectPath),
  ));

  ipcMain.handle(IPC.LEGACY_DEFAULTS.PREVIEW_IMPORT, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => previewImportAsParts(projectPath),
  ));

  ipcMain.handle(IPC.LEGACY_DEFAULTS.IMPORT, withValidatedArgs(
    [stringArg()],
    async (_event, projectPath) => importAsParts(projectPath),
  ));

  ipcMain.handle(IPC.LEGACY_DEFAULTS.PREVIEW_COPY, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => previewCopyIntoAgent(projectPath, agentId),
  ));

  ipcMain.handle(IPC.LEGACY_DEFAULTS.COPY, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectPath, agentId) => copyIntoAgent(projectPath, agentId),
  ));

  ipcMain.handle(IPC.LEGACY_DEFAULTS.PREVIEW_COPY_NEW, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, projectPath, name, orchestrator) => previewCopyIntoNewAgent(projectPath, name, orchestrator),
  ));
}
