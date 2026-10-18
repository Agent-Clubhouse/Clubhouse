/**
 * IPC for the main-process canvas index (#1544): which canvases hold an
 * agent's card, read from the persisted stores so the answer doesn't depend
 * on the canvas having been opened this session.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getAgentCanvasMemberships } from '../services/canvas-store-reader';
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
}
