import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { AnnexSettings } from '../../shared/types';
import * as annexSettings from '../services/annex-settings';
import * as annexServer from '../services/annex-server';
import * as annexClient from '../services/annex-client';
import * as annexPeers from '../services/annex-peers';
import * as annexIdentity from '../services/annex-identity';
import * as annexTls from '../services/annex-tls';
import * as experimentalSettings from '../services/experimental-settings';
import { isPreviewEligible } from '../services/preview-eligible';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, objectArg, stringArg, booleanArg } from './validation';

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

    // Only start/stop if experimental flag is on
    if (expSettings.annex) {
      // Server toggle (independent of client)
      if (settings.enableServer && !previous.enableServer) {
        try {
          annexServer.start();
          appLog('core:annex', 'info', 'Annex server started via settings');
        } catch (err) {
          appLog('core:annex', 'error', 'Failed to start Annex server', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      } else if (!settings.enableServer && previous.enableServer) {
        annexServer.stop();
        appLog('core:annex', 'info', 'Annex server stopped via settings');
      }

      // Client toggle (independent of server)
      if (settings.enableClient && !previous.enableClient) {
        annexClient.startClient();
        appLog('core:annex', 'info', 'Annex client started via settings');
      } else if (!settings.enableClient && previous.enableClient) {
        annexClient.stopClient();
        appLog('core:annex', 'info', 'Annex client stopped via settings');
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

  ipcMain.handle(IPC.ANNEX.NOTIFY_PAUSE, withValidatedArgs(
    [booleanArg()],
    (_event, paused) => {
      annexServer.notifySessionPause(paused);
    },
  ));

  ipcMain.handle(IPC.ANNEX.DISABLE_AND_DISCONNECT, async () => {
    annexServer.stop();
    annexClient.stopClient();
    await annexSettings.saveSettings({ ...annexSettings.getSettings(), enableServer: false, enableClient: false });
    broadcastStatusChanged();
  });

  // Purge all server-side annex config: stop server, delete identity, TLS cert, peers, reset settings
  ipcMain.handle(IPC.ANNEX.PURGE_SERVER_CONFIG, async () => {
    appLog('core:annex', 'info', 'Purging all Annex server configuration');

    // Stop everything first
    annexServer.stop();
    annexClient.stopClient();

    // Delete persisted files
    annexIdentity.deleteIdentity();
    annexTls.deleteCert();
    annexPeers.removeAllPeers();

    // Reset settings to defaults (disabled)
    await annexSettings.saveSettings({
      enableServer: false,
      enableClient: false,
      deviceName: annexSettings.getSettings().deviceName, // keep device name
      alias: annexSettings.getSettings().alias, // keep alias
      icon: 'computer',
      color: 'indigo',
      autoReconnect: true,
    });

    broadcastStatusChanged();
    broadcastPeersChanged();
    appLog('core:annex', 'info', 'Annex server configuration purged');
  });
}

/** Conditionally start Annex server if enableServer is on AND experimental flag is on AND build is preview-eligible. */
export function maybeStartAnnex(): void {
  const expSettings = experimentalSettings.getSettings();
  if (!expSettings.annex) {
    return; // Annex feature not enabled in experimental settings
  }

  if (!isPreviewEligible()) return;

  const settings = annexSettings.getSettings();
  if (settings.enableServer) {
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

/** Conditionally start the Annex Bonjour client if enableClient is on AND experimental flag is on AND build is preview-eligible. */
export function maybeStartAnnexClient(): void {
  const expSettings = experimentalSettings.getSettings();
  if (!expSettings.annex) return;

  if (!isPreviewEligible()) return;

  const settings = annexSettings.getSettings();
  if (!settings.enableClient) return;

  try {
    annexClient.startClient();
    appLog('core:annex', 'info', 'Annex client auto-started on launch');
  } catch (err) {
    appLog('core:annex', 'error', 'Failed to auto-start Annex client', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}
