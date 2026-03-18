import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { AnnexSettings } from '../../shared/types';
import * as annexSettings from '../services/annex-settings';
import * as annexServer from '../services/annex-server';
import * as annexPeers from '../services/annex-peers';
import * as experimentalSettings from '../services/experimental-settings';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, objectArg, stringArg } from './validation';

function broadcastStatusChanged(): void {
  const status = annexServer.getStatus();
  broadcastToAllWindows(IPC.ANNEX.STATUS_CHANGED, status);
}

function broadcastPeersChanged(): void {
  broadcastToAllWindows(IPC.ANNEX.PEERS_CHANGED, annexPeers.listPeers());
}

export function registerAnnexHandlers(): void {
  ipcMain.handle(IPC.ANNEX.GET_SETTINGS, () => {
    return annexSettings.getSettings();
  });

  ipcMain.handle(IPC.ANNEX.SAVE_SETTINGS, withValidatedArgs(
    [objectArg<AnnexSettings>()],
    async (_event, settings) => {
    const expSettings = experimentalSettings.getSettings();
    const previous = annexSettings.getSettings();
    await annexSettings.saveSettings(settings);

    // Only start/stop server if experimental flag is on
    if (expSettings.annex) {
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
    }

    // Notify renderer of status change
    broadcastStatusChanged();
  }));

  ipcMain.handle(IPC.ANNEX.GET_STATUS, () => {
    return annexServer.getStatus();
  });

  ipcMain.handle(IPC.ANNEX.REGENERATE_PIN, () => {
    annexServer.regeneratePin();
    broadcastStatusChanged();
    return annexServer.getStatus();
  });

  // --- Peer management ---

  ipcMain.handle(IPC.ANNEX.LIST_PEERS, () => {
    return annexPeers.listPeers();
  });

  ipcMain.handle(IPC.ANNEX.REMOVE_PEER, withValidatedArgs(
    [stringArg()],
    (_event, fingerprint) => {
      const removed = annexPeers.removePeer(fingerprint);
      if (removed) broadcastPeersChanged();
      return removed;
    },
  ));

  ipcMain.handle(IPC.ANNEX.REMOVE_ALL_PEERS, () => {
    annexPeers.removeAllPeers();
    broadcastPeersChanged();
  });

  ipcMain.handle(IPC.ANNEX.UNLOCK_PAIRING, () => {
    annexPeers.unlockPairing();
  });

  ipcMain.handle(IPC.ANNEX.DISCONNECT_CONTROLLER, withValidatedArgs(
    [stringArg()],
    (_event, fingerprint) => {
      // Disconnect a specific controller WebSocket by fingerprint
      annexServer.disconnectPeer(fingerprint);
    },
  ));

  ipcMain.handle(IPC.ANNEX.DISABLE_AND_DISCONNECT, async () => {
    annexServer.stop();
    await annexSettings.saveSettings({ ...annexSettings.getSettings(), enabled: false });
    broadcastStatusChanged();
  });
}

/** Conditionally start Annex if settings say enabled AND experimental flag is on. */
export function maybeStartAnnex(): void {
  const expSettings = experimentalSettings.getSettings();
  if (!expSettings.annex) {
    return; // Annex feature not enabled in experimental settings
  }

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
