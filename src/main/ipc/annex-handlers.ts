import { BrowserWindow, ipcMain } from 'electron';
import { settingsChanged } from '../telemetry/feature-events';
import { IPC } from '../../shared/ipc-channels';
import type { AnnexSettings } from '../../shared/types';
import * as annexSettings from '../services/annex-settings';
import * as annexServer from '../services/annex-server';
import * as annexClient from '../services/annex-client';
import * as annexPeers from '../services/annex-peers';
import * as annexIdentity from '../services/annex-identity';
import * as annexTls from '../services/annex-tls';
import * as annexDevices from '../services/annex-devices';
import * as networkChannel from '../services/annex-network-channel';
import * as membership from '../services/annex-network-membership';
import { onDevicesChanged } from '../services/annex-device-signal';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, objectArg, stringArg, booleanArg } from './validation';
import { setDeviceToolHost } from '../services/clubhouse-mcp/tools/device-tools';
import { setAnnexNetworkToolHost } from '../services/clubhouse-mcp/tools/annex-network-tools';
import { deliveryHash } from '../services/annex-delivery-store';

function broadcastStatusChanged(): void {
  const status = annexServer.getStatus();
  broadcastToAllWindows(IPC.ANNEX.STATUS_CHANGED, status);
}

function broadcastPeersChanged(): void {
  broadcastToAllWindows(IPC.ANNEX.PEERS_CHANGED, annexPeers.listPeersForDisplay());
}

function applyNetworkSettings(settings: AnnexSettings, previous: AnnexSettings): void {
  const bindingChanged = !!settings.loopbackOnly !== !!previous.loopbackOnly;
  if (settings.enableServer && (!previous.enableServer || bindingChanged)) {
    if (previous.enableServer) annexServer.stop();
    try {
      annexServer.start();
      appLog('core:annex', 'info', 'Annex server started via settings');
    } catch (err) {
      appLog('core:annex', 'error', 'Failed to start Annex server', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  } else if (!settings.enableServer && previous.enableServer) {
    annexServer.stop();
    appLog('core:annex', 'info', 'Annex server stopped via settings');
  }
  if (settings.enableClient && !previous.enableClient) {
    annexClient.startClient();
    appLog('core:annex', 'info', 'Annex client started via settings');
  } else if (!settings.enableClient && previous.enableClient) {
    annexClient.stopClient();
    appLog('core:annex', 'info', 'Annex client stopped via settings');
  } else if (settings.enableClient && bindingChanged) {
    annexClient.scan();
  }
  broadcastStatusChanged();
}

function assertNetworkSettingsReady(settings: AnnexSettings): void {
  if (deliveryHash(annexSettings.getSettings()) !== deliveryHash(settings)) {
    throw new Error('Annex settings changed again before secure readiness could be confirmed.');
  }
  const status = annexServer.getStatus();
  if (settings.enableServer && (!status.tlsEnabled || !status.port || !status.pairingPort)) {
    throw new Error('Annex secure listeners stopped before readiness could be confirmed.');
  }
}

export function registerAnnexHandlers(): void {
  setAnnexNetworkToolHost({
    applyLoopbackOnly: async (value, assertAuthorized) => {
      const previous = annexSettings.getSettings();
      const settings = await annexSettings.updateSettings((current) => {
        assertAuthorized();
        return { ...current, loopbackOnly: value };
      });
      settingsChanged('annex');
      if (!!settings.loopbackOnly === !!previous.loopbackOnly) return;
      try {
        if (settings.enableServer) {
          annexServer.stop();
          await annexServer.startVerified();
        }
        if (settings.enableClient) annexClient.scan();
        assertNetworkSettingsReady(settings);
        broadcastStatusChanged();
      } catch (err) {
        appLog('core:annex', 'error', 'An approved Annex scope change could not be applied securely', { meta: { error: err instanceof Error ? err.message : String(err) } });
        if (err instanceof annexServer.AnnexStartFailure && err.wasSuperseded()) {
          broadcastStatusChanged();
          throw new Error('The Annex change was interrupted by a concurrent runtime change. No rollback was attempted; current settings and runtime readiness are unconfirmed. Check Annex Network on the desktop.');
        }
        if (!(err instanceof annexServer.AnnexStartFailure) && deliveryHash(annexSettings.getSettings()) === deliveryHash(settings)) annexServer.stop();
        let restored: AnnexSettings | undefined;
        try {
          restored = await annexSettings.updateSettings((current) => {
            if (err instanceof annexServer.AnnexStartFailure && err.wasSuperseded()) throw err;
            if (deliveryHash(current) !== deliveryHash(settings)) throw new Error('Annex settings changed again; a concurrent edit cannot be overwritten.');
            return { ...current, loopbackOnly: previous.loopbackOnly };
          });
          if (err instanceof annexServer.AnnexStartFailure && err.wasSuperseded()) throw err;
          if (restored.enableServer) await annexServer.startVerified();
          if (restored.enableClient) annexClient.scan();
          assertNetworkSettingsReady(restored);
        } catch (restoreError) {
          appLog('core:annex', 'error', 'Annex scope rollback was incomplete', { meta: { error: restoreError instanceof Error ? restoreError.message : String(restoreError) } });
          const concurrent = (restoreError instanceof annexServer.AnnexStartFailure && restoreError.wasSuperseded())
            || (restored && deliveryHash(annexSettings.getSettings()) !== deliveryHash(restored));
          if (!concurrent && restored && !(restoreError instanceof annexServer.AnnexStartFailure)) annexServer.stop();
          broadcastStatusChanged();
          if (concurrent) throw new Error('The Annex change failed and rollback was interrupted by a concurrent change. The replacement runtime was not stopped; current settings and runtime readiness are unconfirmed. Check Annex Network on the desktop.');
          throw new Error(restored
            ? 'The Annex change failed. The previous setting was restored, but its secure runtime could not be restored; Annex is stopped. Check Annex Network on the desktop.'
            : 'The Annex change failed and its previous setting could not be restored. Runtime readiness is unconfirmed; check Annex Network on the desktop before retrying.');
        }
        broadcastStatusChanged();
        throw new Error('The Annex change failed to start its secure listeners. The previous setting and secure runtime were restored; no change was confirmed.');
      }
    },
  });
  // See devices and Manage devices (#3068): what the agent tools act through.
  setDeviceToolHost({
    list: () => annexDevices.listDevices(),
    rename: (fingerprint, name) => membership.renameMember(fingerprint, name),
    reconnect: (fingerprint) => annexClient.retry(fingerprint),
    remove: (fingerprint) => {
      const removed = annexDevices.removeDevice(fingerprint);
      if (removed) broadcastPeersChanged();
      return removed;
    },
    // Only opens the page for a person: no code, link or certificate goes back to the agent.
    openAddDevice: () => {
      if (!BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) return false;
      broadcastToAllWindows(IPC.APP.OPEN_SETTINGS, 'annex');
      return true;
    },
    canConnect: () => !!annexSettings.getSettings().enableClient,
  });
  // Annex Network membership (#3061): what members tell each other, and what to do about it.
  membership.initNetworkMembership({
    connect: (fingerprint) => annexClient.connect(fingerprint),
    endDevice: (fingerprint) => {
      // Revoke first: a removed phone is told on its open connections while it's still known.
      annexServer.revokePeer(fingerprint);
      annexClient.forgetSatellite(fingerprint);
      broadcastPeersChanged();
    },
  });
  onDevicesChanged(() => broadcastToAllWindows(IPC.ANNEX.DEVICES_CHANGED, annexDevices.listDevices()));

  ipcMain.handle(IPC.ANNEX.LIST_DEVICES, () => annexDevices.listDevices());

  // Who this machine has heard from on the Annex Network channel (#3060).
  ipcMain.handle(IPC.ANNEX.LIST_NETWORK_MEMBERS, () => networkChannel.listMembers());

  // Renames a network member everywhere (#3067).
  ipcMain.handle(IPC.ANNEX.RENAME_DEVICE, withValidatedArgs(
    [stringArg(), stringArg({ maxLength: 200 })],
    (_event, fingerprint, name) => membership.renameMember(fingerprint, name),
  ));

  ipcMain.handle(IPC.ANNEX.REMOVE_DEVICE, withValidatedArgs(
    [stringArg()],
    (_event, fingerprint) => {
      const removed = annexDevices.removeDevice(fingerprint);
      if (removed) broadcastPeersChanged();
      return removed;
    },
  ));

  ipcMain.handle(IPC.ANNEX.GET_SETTINGS, () => {
    return annexSettings.getSettings();
  });

  ipcMain.handle(IPC.ANNEX.SAVE_SETTINGS, withValidatedArgs(
    [objectArg<AnnexSettings>()],
    async (_event, settings) => {
    const previous = annexSettings.getSettings();
    await annexSettings.saveSettings(settings);
    settingsChanged('annex');
    applyNetworkSettings(settings, previous);
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
    return annexPeers.listPeersForDisplay();
  });

  ipcMain.handle(IPC.ANNEX.REMOVE_PEER, withValidatedArgs(
    [stringArg()],
    (_event, fingerprint) => {
      // Revokes before anything can reconnect, and closes its open connections.
      const removed = annexServer.revokePeer(fingerprint);
      if (removed) broadcastPeersChanged();
      return removed;
    },
  ));

  ipcMain.handle(IPC.ANNEX.REMOVE_ALL_PEERS, () => {
    annexServer.revokeAllPeers();
    broadcastPeersChanged();
  });

  // Reopens pairing after too many wrong PINs paused it, with a fresh PIN.
  ipcMain.handle(IPC.ANNEX.UNLOCK_PAIRING, () => {
    annexServer.allowPairingAgain();
    broadcastStatusChanged();
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

/** Conditionally start Annex server if enableServer is on. Annex is now a stable feature. */
export function maybeStartAnnex(): void {
  appLog('core:annex', 'info', 'Annex server startup check');

  const settings = annexSettings.getSettings();
  appLog('core:annex', 'info', 'Annex settings at startup', {
    meta: { enableServer: settings.enableServer, enableClient: settings.enableClient, deviceName: settings.deviceName },
  });

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

/** Conditionally start the Annex Bonjour client if enableClient is on. Annex is now a stable feature. */
export function maybeStartAnnexClient(): void {
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
