/**
 * IPC handlers for the Annex V2 client (controller side).
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as annexClient from '../services/annex-client';
import { withValidatedArgs, stringArg, numberArg, objectArg } from './validation';

export function registerAnnexClientHandlers(): void {
  ipcMain.handle(IPC.ANNEX_CLIENT.GET_SATELLITES, () => {
    return annexClient.getSatellites();
  });

  ipcMain.handle(IPC.ANNEX_CLIENT.CONNECT, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    (_event, fingerprint, bearerToken) => {
      annexClient.connect(fingerprint, bearerToken);
    },
  ));

  ipcMain.handle(IPC.ANNEX_CLIENT.DISCONNECT, withValidatedArgs(
    [stringArg()],
    (_event, fingerprint) => {
      annexClient.disconnect(fingerprint);
    },
  ));

  ipcMain.handle(IPC.ANNEX_CLIENT.RETRY, withValidatedArgs(
    [stringArg()],
    (_event, fingerprint) => {
      annexClient.retry(fingerprint);
    },
  ));

  ipcMain.handle(IPC.ANNEX_CLIENT.SCAN, () => {
    annexClient.scan();
  });

  // Proxy IPC: send PTY input to a satellite's agent
  ipcMain.handle(IPC.ANNEX_CLIENT.PTY_INPUT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    (_event, satelliteId, agentId, data) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'pty:input',
        payload: { agentId, data },
      });
    },
  ));

  // Proxy IPC: resize PTY on a satellite's agent
  ipcMain.handle(IPC.ANNEX_CLIENT.PTY_RESIZE, withValidatedArgs(
    [stringArg(), stringArg(), numberArg(), numberArg()],
    (_event, satelliteId, agentId, cols, rows) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'pty:resize',
        payload: { agentId, cols, rows },
      });
    },
  ));

  // Proxy IPC: spawn agent on a satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.AGENT_SPAWN, withValidatedArgs(
    [stringArg(), objectArg()],
    (_event, satelliteId, params) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'agent:spawn',
        payload: params,
      });
    },
  ));

  // Proxy IPC: kill agent on a satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.AGENT_KILL, withValidatedArgs(
    [stringArg(), stringArg()],
    (_event, satelliteId, agentId) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'agent:kill',
        payload: { agentId },
      });
    },
  ));
}
