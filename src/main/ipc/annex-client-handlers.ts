/**
 * IPC handlers for the Annex V2 client (controller side).
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import * as annexClient from '../services/annex-client';
import { withValidatedArgs, stringArg, numberArg, objectArg, arrayArg } from './validation';

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

  ipcMain.handle(IPC.ANNEX_CLIENT.GET_DISCOVERED, () => {
    return annexClient.getDiscoveredServices();
  });

  ipcMain.handle(IPC.ANNEX_CLIENT.PAIR_WITH, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, fingerprint, pin) => {
      return annexClient.pairWithService(fingerprint, pin);
    },
  ));

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
      // Also resize the local headless terminal cache so serialization
      // dimensions stay correct for buffer replay on tab switch.
      annexClient.resizeRemoteBuffer(satelliteId, agentId, cols, rows);
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

  // Proxy IPC: wake a sleeping agent on a satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.AGENT_WAKE, withValidatedArgs(
    [stringArg(), stringArg(), objectArg({ optional: true })],
    (_event, satelliteId, agentId, options) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'agent:wake',
        payload: { agentId, ...options },
      });
    },
  ));

  // Fetch PTY buffer for a remote agent from its satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.PTY_GET_BUFFER, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, satelliteId, agentId) => {
      return annexClient.requestPtyBuffer(satelliteId, agentId);
    },
  ));

  // Permanently forget a satellite (disconnect + remove peer + clear state)
  ipcMain.handle(IPC.ANNEX_CLIENT.FORGET_SATELLITE, withValidatedArgs(
    [stringArg()],
    (_event, fingerprint) => {
      annexClient.forgetSatellite(fingerprint);
    },
  ));

  // Forget all satellites (disconnect all + remove all peers + clear state)
  ipcMain.handle(IPC.ANNEX_CLIENT.FORGET_ALL_SATELLITES, () => {
    annexClient.forgetAllSatellites();
  });

  // File system proxy: read file tree from satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.FILE_TREE, withValidatedArgs(
    [stringArg(), stringArg(), objectArg({ optional: true })],
    async (_event, satelliteId, projectId, options) => {
      return annexClient.requestFileTree(satelliteId, projectId, options);
    },
  ));

  // File system proxy: read file content from satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.FILE_READ, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, satelliteId, projectId, path) => {
      return annexClient.requestFileRead(satelliteId, projectId, path);
    },
  ));

  // Forward clipboard image to a satellite agent
  ipcMain.handle(IPC.ANNEX_CLIENT.CLIPBOARD_IMAGE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), stringArg()],
    (_event, satelliteId, agentId, base64, mimeType) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'clipboard:image',
        payload: { agentId, base64, mimeType },
      });
    },
  ));

  // PTY proxy: spawn a shell on a satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.PTY_SPAWN_SHELL, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    (_event, satelliteId, sessionId, projectId) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'pty:spawn-shell',
        payload: { sessionId, projectId },
      });
    },
  ));

  // Git proxy: execute git operation on satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.GIT_OPERATION, withValidatedArgs(
    [stringArg(), stringArg(), objectArg()],
    async (_event, satelliteId, projectId, params) => {
      return annexClient.requestGitOperation(satelliteId, projectId, params as annexClient.GitOperationParams);
    },
  ));

  // Session proxy: list sessions on satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.SESSION_LIST, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, satelliteId, agentId, projectId, orchestrator) => {
      return annexClient.requestSessionList(satelliteId, agentId, projectId, orchestrator);
    },
  ));

  // Session proxy: read session transcript from satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.SESSION_TRANSCRIPT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), stringArg(), numberArg(), numberArg(), stringArg({ optional: true })],
    async (_event, satelliteId, agentId, sessionId, projectId, offset, limit, orchestrator) => {
      return annexClient.requestSessionTranscript(satelliteId, agentId, sessionId, projectId, offset, limit, orchestrator);
    },
  ));

  // Session proxy: get session summary from satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.SESSION_SUMMARY, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), stringArg(), stringArg({ optional: true })],
    async (_event, satelliteId, agentId, sessionId, projectId, orchestrator) => {
      return annexClient.requestSessionSummary(satelliteId, agentId, sessionId, projectId, orchestrator);
    },
  ));

  // Proxy IPC: create a durable agent on a satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.AGENT_CREATE_DURABLE, withValidatedArgs(
    [stringArg(), stringArg(), objectArg()],
    async (_event, satelliteId, projectId, params) => {
      return annexClient.requestCreateDurable(satelliteId, projectId, params as {
        name: string; color: string; model?: string; useWorktree?: boolean;
        orchestrator?: string; freeAgentMode?: boolean; mcpIds?: string[];
      });
    },
  ));

  // Proxy IPC: delete a durable agent on a satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.AGENT_DELETE_DURABLE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), stringArg()],
    async (_event, satelliteId, projectId, agentId, mode) => {
      return annexClient.requestDeleteDurable(satelliteId, projectId, agentId, mode);
    },
  ));

  // Proxy IPC: get worktree status for a remote agent
  ipcMain.handle(IPC.ANNEX_CLIENT.AGENT_WORKTREE_STATUS, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, satelliteId, projectId, agentId) => {
      return annexClient.requestWorktreeStatus(satelliteId, projectId, agentId);
    },
  ));

  // Proxy IPC: reorder durable agents on a satellite
  ipcMain.handle(IPC.ANNEX_CLIENT.AGENT_REORDER, withValidatedArgs(
    [stringArg(), stringArg(), arrayArg(stringArg())],
    (_event, satelliteId, projectId, orderedIds) => {
      return annexClient.sendToSatellite(satelliteId, {
        type: 'agent:reorder',
        payload: { projectId, orderedIds },
      });
    },
  ));
}
