/**
 * IPC for the main-process canvas index (#1544): which canvases hold an
 * agent's card, read from the persisted stores so the answer doesn't depend
 * on the canvas having been opened this session.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getAgentCanvasMemberships } from '../services/canvas-store-reader';
import { withValidatedArgs, stringArg } from './validation';

export function registerCanvasIndexHandlers(): void {
  ipcMain.handle(IPC.CANVAS_CMD.GET_AGENT_CANVASES, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, agentId, projectId) => getAgentCanvasMemberships(agentId as string, (projectId as string | undefined) ?? null),
  ));
}
