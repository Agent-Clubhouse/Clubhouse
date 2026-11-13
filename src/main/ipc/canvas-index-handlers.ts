/**
 * IPC for the main-process canvas index (#1544): which canvases hold an
 * agent's card, read from the persisted stores so the answer doesn't depend
 * on the canvas having been opened this session.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getAgentCanvasMemberships } from '../services/canvas-store-reader';
import { readTargetCanvasForNavigation, resolveAgentNavigationTarget, resolveTargetCanvasIndex } from '../services/connection-target-navigation';
import { appLog } from '../services/log-service';
import { withValidatedArgs, stringArg } from './validation';

/** Same rule as the MCP binding handlers: only application windows, never webviews. */
function assertCallerIsAppWindow(event: Electron.IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    appLog('core:canvas-index', 'warn', 'Rejected canvas index request — caller is not an application window');
    throw new Error('Canvas index request rejected — unauthorized caller');
  }
}

export function registerCanvasIndexHandlers(): void {
  ipcMain.handle(IPC.CANVAS_CMD.GET_AGENT_CANVASES, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (event, agentId, projectId) => {
      assertCallerIsAppWindow(event);
      return getAgentCanvasMemberships(agentId, projectId ?? null);
    },
  ));
  ipcMain.handle(IPC.CANVAS_CMD.GET_TARGET_CANVASES, withValidatedArgs(
    [stringArg(), stringArg()],
    async (event, kind, targetId) => {
      assertCallerIsAppWindow(event);
      if (kind !== 'group-project' && kind !== 'browser' && kind !== 'terminal') {
        throw new Error('Unsupported Canvas target kind.');
      }
      return resolveTargetCanvasIndex(kind, targetId);
    },
  ));
  ipcMain.handle(IPC.CANVAS_CMD.READ_FOR_NAVIGATION, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true })],
    async (event, kind, targetId, projectId) => {
      assertCallerIsAppWindow(event);
      if (kind !== 'group-project' && kind !== 'browser' && kind !== 'terminal') throw new Error('Unsupported Canvas target kind.');
      return readTargetCanvasForNavigation(kind, targetId, projectId);
    },
  ));
  ipcMain.handle(IPC.CANVAS_CMD.RESOLVE_AGENT_TARGET, withValidatedArgs(
    [stringArg()],
    async (event, agentId) => {
      assertCallerIsAppWindow(event);
      return resolveAgentNavigationTarget(agentId);
    },
  ));
}
