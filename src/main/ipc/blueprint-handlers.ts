import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { stringArg, withValidatedArgs } from './validation';

export function registerBlueprintHandlers(): void {
  ipcMain.handle(IPC.BLUEPRINT.SAVE_DIALOG, withValidatedArgs(
    [stringArg()],
    async (_event, defaultName: string) => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true };
      const result = await dialog.showSaveDialog(win, {
        title: 'Save Blueprint',
        defaultPath: defaultName,
        filters: [{ name: 'Blueprint files', extensions: ['json'] }],
      });
      return { canceled: result.canceled, filePath: result.filePath };
    },
  ));
}
