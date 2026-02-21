import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { AnnexSettings } from '../../shared/types';
import * as annexSettings from '../services/annex-settings';
import * as annexServer from '../services/annex-server';
import { appLog } from '../services/log-service';

function broadcastStatusChanged(): void {
  const status = annexServer.getStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.ANNEX.STATUS_CHANGED, status);
    }
  }
}

export function registerAnnexHandlers(): void {
  ipcMain.handle(IPC.ANNEX.GET_SETTINGS, () => {
    return annexSettings.getSettings();
  });

  ipcMain.handle(IPC.ANNEX.SAVE_SETTINGS, (_event, settings: AnnexSettings) => {
    const previous = annexSettings.getSettings();
    annexSettings.saveSettings(settings);

    // Start or stop server based on enabled state
    if (settings.enabled && !previous.enabled) {
      try {
        annexServer.start();
        appLog('core:annex', 'info', 'Annex server started via settings');
      } catch (err) {
        appLog('core:annex', 'error', 'Failed to start Annex server', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    } else if (!settings.enabled && previous.enabled) {
      annexServer.stop();
      appLog('core:annex', 'info', 'Annex server stopped via settings');
    }

    // Notify renderer of status change
    broadcastStatusChanged();
  });

  ipcMain.handle(IPC.ANNEX.GET_STATUS, () => {
    return annexServer.getStatus();
  });

  ipcMain.handle(IPC.ANNEX.REGENERATE_PIN, () => {
    annexServer.regeneratePin();
    broadcastStatusChanged();
    return annexServer.getStatus();
  });
}

/** Conditionally start Annex if settings say enabled. Call after IPC registration. */
export function maybeStartAnnex(): void {
  const settings = annexSettings.getSettings();
  if (settings.enabled) {
    try {
      annexServer.start();
      appLog('core:annex', 'info', 'Annex server auto-started on launch');
    } catch (err) {
      appLog('core:annex', 'error', 'Failed to auto-start Annex server', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
